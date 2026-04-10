import { NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { getDb } from "@/db";
import fs from "fs/promises";
import path from "path";
import { GoogleGenAI, Type } from "@google/genai";

interface AiConfig {
    provider: "openrouter" | "google";
    openRouterKey?: string;
    googleAiKey?: string;
    googleAiModel?: string;
}

async function getAiConfig(): Promise<AiConfig> {
    try {
        const configFile = path.join(process.cwd(), "data", ".db-config.json");
        const data = await fs.readFile(configFile, "utf-8");
        const config = JSON.parse(data);
        return {
            provider: config.aiProvider ?? "openrouter",
            openRouterKey: config.openRouterKey ?? process.env.OPENROUTER_API_KEY,
            googleAiKey: config.googleAiKey ?? process.env.GOOGLE_AI_KEY,
            googleAiModel: config.googleAiModel ?? "gemini-2.0-flash",
        };
    } catch {
        return {
            provider: "openrouter",
            openRouterKey: process.env.OPENROUTER_API_KEY,
        };
    }
}

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

// Tools available to the admin AI
const TOOLS = [
    {
        type: "function",
        function: {
            name: "execute_sql",
            description:
                "Execute a READ-ONLY SQL SELECT query on the CollectFlow PostgreSQL database. Use this to answer questions about data.",
            parameters: {
                type: "object",
                properties: {
                    query: {
                        type: "string",
                        description:
                            "A valid PostgreSQL SELECT query. Only SELECT statements are allowed.",
                    },
                },
                required: ["query"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "get_db_schema",
            description:
                "Returns the full database schema with table names, columns, and descriptions.",
            parameters: {
                type: "object",
                properties: {},
                required: [],
            },
        },
    },
];

const DB_SCHEMA = `
# Schéma complet de la base de données CollectFlow (PostgreSQL)

## Table : ventes_produits
Table principale. Contient l'historique des ventes par produit, par magasin, par mois.
Chaque ligne = 1 produit × 1 magasin × 1 mois.

Colonnes :
- id (serial PK)
- codein (varchar) — identifiant produit interne unique FF Nancy
- code_fournisseur (varchar) — code fournisseur (ex: "FOU001")
- nom_fournisseur (varchar) — nom complet du fournisseur
- libelle1 (varchar) — libellé principal du produit
- gtin (varchar) — code-barres EAN
- reference (varchar) — référence produit fournisseur
- colisage (numeric) — quantité par colis
- code_gamme (varchar) — classification actuelle : A, B, C, D, ou Z
- code_gamme_init (varchar) — classification d'origine à l'import
- code3 (varchar) — code sous-catégorie produit
- libelle3 (varchar) — libellé sous-catégorie
- magasin (varchar) — nom ou code magasin (ex: "Supermarché Est")
- code_magasin (varchar) — identifiant court magasin (ex: "001")
- annee (smallint) — année de la période (ex: 2024)
- mois (smallint) — mois de la période (1-12)
- periode (varchar) — format "YYYY-MM" (ex: "2024-03")
- quantite (numeric) — quantité vendue sur la période
- montant_mvt (numeric) — chiffre d'affaires HT en euros
- marge_mvt (numeric) — marge brute HT en euros
- prix_unitaire (numeric) — prix de vente unitaire HT (si disponible)
- imported_at (timestamp) — date d'import
- updated_at (timestamp) — dernière mise à jour

Requêtes utiles sur ventes_produits :
- Lister les fournisseurs distincts : SELECT DISTINCT code_fournisseur, nom_fournisseur FROM ventes_produits ORDER BY nom_fournisseur
- CA total par fournisseur : SELECT nom_fournisseur, SUM(montant_mvt) as ca FROM ventes_produits GROUP BY nom_fournisseur ORDER BY ca DESC
- Produits par gamme : SELECT code_gamme, COUNT(DISTINCT codein) FROM ventes_produits GROUP BY code_gamme
- Évolution mensuelle : SELECT periode, SUM(montant_mvt) as ca FROM ventes_produits GROUP BY periode ORDER BY periode
- Produits d'un fournisseur : SELECT DISTINCT codein, libelle1, code_gamme FROM ventes_produits WHERE code_fournisseur = '...'

## Table : users
Utilisateurs de l'application CollectFlow.

Colonnes :
- id (serial PK)
- username (varchar unique) — identifiant de connexion
- password_hash (text) — ⛔ NE JAMAIS EXPOSER CE CHAMP
- role (varchar) — 'admin' (accès total) ou 'user' (accès restreint)
- created_at (timestamp)

## Table : session_snapshots
Historique des sessions d'arbitrage de gamme sauvegardées par les utilisateurs.
Un snapshot = une session de travail où un utilisateur a modifié des classifications gamme.

Colonnes :
- id (serial PK)
- user_id (int FK → users.id)
- code_fournisseur (varchar)
- nom_fournisseur (varchar)
- magasin (varchar)
- changes (jsonb) — objet JSON : { "codein": { "before": "A", "after": "B" }, ... }
- summary_json (jsonb) — statistiques : { "total": N, "byGamme": {...}, ... }
- label (text) — nom donné au snapshot par l'utilisateur
- type (varchar) — 'snapshot' (sauvegarde manuelle) ou 'export' (export Excel/PDF)
- created_at (timestamp)

Requêtes utiles sur session_snapshots :
- Derniers snapshots : SELECT id, label, nom_fournisseur, magasin, type, created_at FROM session_snapshots ORDER BY created_at DESC LIMIT 20
- Compter les changements d'un snapshot : SELECT id, label, jsonb_object_keys(changes) FROM session_snapshots
- Snapshots par utilisateur : SELECT u.username, COUNT(*) FROM session_snapshots s JOIN users u ON u.id = s.user_id GROUP BY u.username

## Table : ai_supplier_context
Contexte métier personnalisé par fournisseur, saisi par les managers pour guider l'IA d'analyse de gamme.

Colonnes :
- code_fournisseur (varchar PK)
- context (text) — instructions et règles métier spécifiques au fournisseur
- updated_at (timestamp)

## Règles métier — Classification gamme (A/B/C/D/Z)
- **A** : Produit pilier — fort volume, fort CA, indispensable au rayon
- **B** : Bon produit — bonne rotation, CA correct
- **C** : Produit de performance — faible rotation mais maintenu pour compléter l'offre
- **D** : Produit saisonnier ou de niche — présence justifiée par événement ou spécificité
- **Z** : Produit en sortie de gamme — à déréférencer

## Informations sur l'application CollectFlow
- Application web Next.js de gestion de gammes produits pour des magasins de distribution alimentaire
- Les données viennent d'une API externe (FF Nancy) synchronisée chaque nuit
- Plusieurs magasins peuvent être gérés, chacun a son propre assortiment
- Les utilisateurs arbitrent manuellement les gammes produit par fournisseur
- Les sessions sont sauvegardées comme snapshots pour historique et audit
`;

const SYSTEM_PROMPT = `Tu es un assistant IA administrateur expert pour l'application CollectFlow, un outil de gestion de gammes produits et d'analyse des ventes pour des magasins de distribution alimentaire.

## Outils disponibles
- \`execute_sql\` : exécute une requête SELECT sur la base PostgreSQL
- \`get_db_schema\` : retourne le schéma complet de la base de données

Le schéma complet est déjà inclus dans ton contexte ci-dessous — utilise \`get_db_schema\` uniquement si tu as besoin de détails supplémentaires.

## Schéma de la base de données
${DB_SCHEMA}

## Règles SQL strictes
- N'utilise JAMAIS INSERT, UPDATE, DELETE, DROP, TRUNCATE, ALTER, CREATE
- N'expose JAMAIS le champ \`password_hash\` de la table \`users\`
- Toujours ajouter LIMIT (max 200 lignes par défaut, sauf agrégats)
- Pour les analyses larges, utilise des agrégats (SUM, COUNT, AVG, GROUP BY)
- Préfère des requêtes précises et ciblées plutôt que SELECT *
- Si une question nécessite plusieurs requêtes, enchaîne-les avec plusieurs appels \`execute_sql\`

## Stratégie d'analyse
1. Commence toujours par explorer les données disponibles si tu ne connais pas les valeurs exactes (codes fournisseurs, codes magasins, périodes disponibles)
2. Adapte tes requêtes aux données réelles trouvées
3. Présente les résultats de façon lisible avec des tableaux, listes et titres

## Format de réponse — IMPORTANT
- Réponds TOUJOURS en **Markdown** : utilise ## titres, **gras**, tableaux \`| col | col |\`, listes \`-\`, blocs de code \`\`\`sql
- N'utilise JAMAIS de HTML (<div>, <table>, <b>, <br>, etc.)
- Réponds toujours en français
- Sois précis, structuré et complet — ne tronque jamais ta réponse
- Si les données sont nombreuses, résume et mets en avant les points clés`;

async function executeSql(query: string): Promise<string> {
    // Security: only allow SELECT statements
    const normalizedQuery = query.trim().toUpperCase();
    if (!normalizedQuery.startsWith("SELECT") && !normalizedQuery.startsWith("WITH")) {
        return "Erreur: Seules les requêtes SELECT sont autorisées.";
    }

    // Block dangerous keywords
    const blocked = ["INSERT", "UPDATE", "DELETE", "DROP", "TRUNCATE", "ALTER", "CREATE", "GRANT", "REVOKE"];
    for (const kw of blocked) {
        if (new RegExp(`\\b${kw}\\b`).test(normalizedQuery)) {
            return `Erreur: Le mot-clé ${kw} n'est pas autorisé.`;
        }
    }

    try {
        const db = getDb();
        const result = await db.execute(query as any);
        const rows = result.rows ?? [];

        if (rows.length === 0) return "Aucun résultat.";

        // Return as compact JSON (max 200 rows)
        const limited = rows.slice(0, 200);
        const truncated = rows.length > 200 ? ` (résultats tronqués à 200/${rows.length})` : "";

        return JSON.stringify(limited, null, 2) + truncated;
    } catch (err) {
        const msg = err instanceof Error ? err.message : "Erreur inconnue";
        return `Erreur SQL: ${msg}`;
    }
}

async function callOpenRouter(
    messages: object[],
    model: string,
    apiKey: string,
    useTools: boolean,
    stream: boolean
): Promise<Response> {
    const body: Record<string, unknown> = {
        model,
        messages,
        temperature: 0.3,
        max_tokens: 8192,
    };

    if (useTools) {
        body.tools = TOOLS;
        body.tool_choice = "auto";
    }

    if (stream) {
        body.stream = true;
        body.stream_options = { include_usage: true };
    }

    return fetch(OPENROUTER_URL, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            "HTTP-Referer": "https://collectflow.app",
            "X-Title": "CollectFlow Admin Chat",
        },
        body: JSON.stringify(body),
    });
}

// Google AI Studio handler
async function handleGoogleAi(messages: Array<{ role: string; content: string }>, config: AiConfig): Promise<Response> {
    if (!config.googleAiKey) {
        return new Response(JSON.stringify({ error: "No Google AI key configured" }), { status: 500 });
    }

    const model = config.googleAiModel ?? "gemini-2.0-flash";
    const encoder = new TextEncoder();

    const googleTools = [{
        functionDeclarations: [
            {
                name: "execute_sql",
                description: "Execute a READ-ONLY SQL SELECT query on the CollectFlow PostgreSQL database.",
                parameters: {
                    type: Type.OBJECT,
                    properties: { query: { type: Type.STRING, description: "A valid PostgreSQL SELECT query." } },
                    required: ["query"],
                },
            },
            {
                name: "get_db_schema",
                description: "Returns the full database schema with table names, columns, and descriptions.",
                parameters: { type: Type.OBJECT, properties: {} },
            },
        ],
    }];

    const stream = new ReadableStream({
        async start(controller) {
            function send(event: object) {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
            }

            try {
                const ai = new GoogleGenAI({ apiKey: config.googleAiKey! });

                // Build full contents array for generateContent
                const contents: Array<{ role: string; parts: Array<{ text: string }> }> = [
                    ...messages.map((m) => ({
                        role: m.role === "assistant" ? "model" : "user",
                        parts: [{ text: m.content }],
                    })),
                ];

                // Agentic loop — streaming throughout
                for (let round = 0; round < 8; round++) {
                    const streamResponse = await ai.models.generateContentStream({
                        model,
                        contents: contents as any,
                        config: {
                            systemInstruction: SYSTEM_PROMPT,
                            tools: googleTools as any,
                            maxOutputTokens: 8192,
                        },
                    });

                    // Collect stream, forwarding text chunks immediately
                    let collectedText = "";
                    const collectedParts: any[] = [];

                    for await (const chunk of streamResponse) {
                        const text = chunk.text;
                        if (text) {
                            collectedText += text;
                            send({ type: "text", content: text });
                        }
                        // Collect parts for function calls
                        const parts = chunk.candidates?.[0]?.content?.parts;
                        if (parts) collectedParts.push(...parts);
                    }

                    // Check for function calls in collected parts
                    const fnCallParts = collectedParts.filter((p: any) => p.functionCall);

                    if (fnCallParts.length === 0) {
                        // Pure text response — done
                        break;
                    }

                    // Had function calls — add model turn to history
                    if (collectedText) {
                        // Mixed text + function calls
                        contents.push({ role: "model", parts: collectedParts });
                    } else {
                        contents.push({ role: "model", parts: fnCallParts });
                    }

                    // Execute tool calls
                    const toolResultParts: Array<{ functionResponse: { name: string; response: { output: string } } }> = [];
                    for (const part of fnCallParts) {
                        const fn = part.functionCall as { name: string; args: Record<string, unknown> };
                        const args = fn.args ?? {};
                        send({ type: "tool_start", name: fn.name, args });

                        let result = "";
                        if (fn.name === "execute_sql") {
                            result = await executeSql(args.query as string);
                        } else if (fn.name === "get_db_schema") {
                            result = DB_SCHEMA;
                        } else {
                            result = `Outil inconnu: ${fn.name}`;
                        }

                        send({ type: "tool_result", name: fn.name, result: result.substring(0, 500) + (result.length > 500 ? "..." : "") });
                        toolResultParts.push({ functionResponse: { name: fn.name, response: { output: result } } });
                    }

                    contents.push({ role: "user", parts: toolResultParts as any });
                }

                send({ type: "usage", prompt_tokens: 0, completion_tokens: 0 });
                send({ type: "done" });
                controller.close();
            } catch (err) {
                const msg = err instanceof Error ? err.message : "Erreur inconnue";
                send({ type: "error", message: msg });
                controller.close();
            }
        },
    });

    return new Response(stream, {
        headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
        },
    });
}

export async function POST(req: NextRequest) {
    // Auth check
    const session = await auth();
    if (!session || (session.user as any)?.role !== "admin") {
        return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 403 });
    }

    const { messages, model } = await req.json();

    const aiConfig = await getAiConfig();

    if (aiConfig.provider === "google") {
        return handleGoogleAi(messages, aiConfig);
    }

    const apiKey = aiConfig.openRouterKey;
    if (!apiKey) {
        return new Response(JSON.stringify({ error: "No OpenRouter API key configured" }), { status: 500 });
    }

    // Build message list with system prompt
    const fullMessages: object[] = [
        { role: "system", content: SYSTEM_PROMPT },
        ...messages,
    ];

    // SSE stream
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
        async start(controller) {
            function send(event: object) {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
            }

            try {
                let currentMessages = [...fullMessages];
                let totalPromptTokens = 0;
                let totalCompletionTokens = 0;
                let directAnswer: string | null = null;

                // Tool-calling loop (non-streaming for tool phase)
                for (let round = 0; round < 8; round++) {
                    const res = await callOpenRouter(currentMessages, model, apiKey, true, false);

                    if (!res.ok) {
                        const errText = await res.text();
                        send({ type: "error", message: `OpenRouter error: ${errText}` });
                        controller.close();
                        return;
                    }

                    const data = await res.json();
                    const usage = data.usage;
                    if (usage) {
                        totalPromptTokens += usage.prompt_tokens ?? 0;
                        totalCompletionTokens += usage.completion_tokens ?? 0;
                    }

                    const choice = data.choices?.[0];
                    const assistantMessage = choice?.message;

                    if (!assistantMessage) break;

                    currentMessages.push(assistantMessage);

                    const toolCalls = assistantMessage.tool_calls;
                    if (!toolCalls || toolCalls.length === 0) {
                        // Model gave a direct answer — capture it and skip the extra final call
                        directAnswer = assistantMessage.content ?? "";
                        break;
                    }

                    // Execute tool calls
                    const toolResults: object[] = [];
                    for (const tc of toolCalls) {
                        const fnName = tc.function?.name;
                        let args: Record<string, unknown> = {};
                        try {
                            args = JSON.parse(tc.function?.arguments ?? "{}");
                        } catch { /* ignore */ }

                        send({ type: "tool_start", name: fnName, args });

                        let result = "";
                        if (fnName === "execute_sql") {
                            result = await executeSql(args.query as string);
                        } else if (fnName === "get_db_schema") {
                            result = DB_SCHEMA;
                        } else {
                            result = `Outil inconnu: ${fnName}`;
                        }

                        send({ type: "tool_result", name: fnName, result: result.substring(0, 500) + (result.length > 500 ? "..." : "") });

                        toolResults.push({
                            role: "tool",
                            tool_call_id: tc.id,
                            content: result,
                        });
                    }

                    currentMessages.push(...toolResults);
                }

                // If model gave a direct answer in the loop, stream it character by character
                if (directAnswer !== null) {
                    send({ type: "text", content: directAnswer });
                    send({ type: "usage", prompt_tokens: totalPromptTokens, completion_tokens: totalCompletionTokens });
                    send({ type: "done" });
                    controller.close();
                    return;
                }

                // Otherwise make a final streaming call after tool use
                const finalRes = await callOpenRouter(currentMessages, model, apiKey, false, true);

                if (!finalRes.ok) {
                    const errText = await finalRes.text();
                    send({ type: "error", message: `OpenRouter error: ${errText}` });
                    controller.close();
                    return;
                }

                // Stream the response chunks
                const reader = finalRes.body?.getReader();
                if (!reader) {
                    controller.close();
                    return;
                }

                const textDecoder = new TextDecoder();
                let buffer = "";
                let finalUsage: { prompt_tokens?: number; completion_tokens?: number } | null = null;

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;

                    buffer += textDecoder.decode(value, { stream: true });
                    const lines = buffer.split("\n");
                    buffer = lines.pop() ?? "";

                    for (const line of lines) {
                        if (!line.startsWith("data: ")) continue;
                        const raw = line.slice(6).trim();
                        if (raw === "[DONE]") continue;

                        try {
                            const chunk = JSON.parse(raw);
                            const delta = chunk.choices?.[0]?.delta?.content;
                            if (delta) {
                                send({ type: "text", content: delta });
                            }
                            if (chunk.usage) {
                                finalUsage = chunk.usage;
                            }
                        } catch { /* ignore malformed */ }
                    }
                }

                if (finalUsage) {
                    totalPromptTokens += finalUsage.prompt_tokens ?? 0;
                    totalCompletionTokens += finalUsage.completion_tokens ?? 0;
                }

                send({
                    type: "usage",
                    prompt_tokens: totalPromptTokens,
                    completion_tokens: totalCompletionTokens,
                });

                send({ type: "done" });
                controller.close();
            } catch (err) {
                const msg = err instanceof Error ? err.message : "Erreur inconnue";
                send({ type: "error", message: msg });
                controller.close();
            }
        },
    });

    return new Response(stream, {
        headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
        },
    });
}
