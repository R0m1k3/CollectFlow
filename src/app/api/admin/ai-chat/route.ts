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
## Tables de la base de données CollectFlow

### ventes_produits
Données de ventes produits (historique 12 mois par magasin)
- id (serial PK)
- codein (varchar) — identifiant produit interne
- code_fournisseur (varchar) — code fournisseur
- nom_fournisseur (varchar) — nom du fournisseur
- libelle1 (varchar) — libellé produit
- gtin (varchar) — code-barres
- reference (varchar) — référence
- colisage (numeric) — quantité par colis
- code_gamme (varchar) — classification actuelle (A/B/C/D/Z)
- code_gamme_init (varchar) — classification initiale
- code3 / libelle3 — sous-catégorie
- magasin (varchar) — code magasin
- code_magasin (varchar) — code magasin alternatif
- annee (smallint), mois (smallint) — période
- periode (varchar) — ex: "2024-01"
- quantite (numeric) — quantité vendue
- montant_mvt (numeric) — CA HT
- marge_mvt (numeric) — marge HT
- imported_at, updated_at (timestamp)

### users
Utilisateurs de l'application
- id (serial PK)
- username (varchar unique)
- password_hash (text) — NE PAS EXPOSER
- role (varchar) — 'admin' ou 'user'
- created_at (timestamp)

### session_snapshots
Snapshots de sessions d'arbitrage gamme
- id (serial PK)
- user_id (int FK → users)
- code_fournisseur, nom_fournisseur (varchar)
- magasin (varchar)
- changes (jsonb) — map codein → {before, after}
- summary_json (jsonb) — statistiques résumées
- label (text) — nom du snapshot
- type (varchar) — 'snapshot' ou 'export'
- created_at (timestamp)

### ai_supplier_context
Règles métier IA par fournisseur
- code_fournisseur (varchar PK)
- context (text) — règles saisies par le manager
- updated_at (timestamp)
`;

const SYSTEM_PROMPT = `Tu es un assistant IA administrateur pour l'application CollectFlow, un outil de gestion de gammes produits et d'analyse des ventes pour des magasins de distribution.

Tu as accès à la base de données PostgreSQL de l'application via l'outil \`execute_sql\`. Tu peux aussi consulter le schéma avec \`get_db_schema\`.

**Règles importantes :**
- N'expose JAMAIS le champ password_hash de la table users
- Utilise uniquement des SELECT (pas de INSERT, UPDATE, DELETE, DROP, etc.)
- Limite tes requêtes à 500 lignes maximum par défaut (utilise LIMIT)
- Si une requête est trop large, agrège les données

**Contexte métier :**
- Les gammes A/B/C/D/Z classifient les produits : A=pilier, B=rotation, C=performance, D=saisonnier, Z=sortie
- Les magasins sont identifiés par leur code (ex: "001", "002")
- Les fournisseurs ont un code et un nom
- Les ventes sont enregistrées par mois et par magasin

Réponds toujours en français, de façon claire et structurée.`;

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

                // Agentic loop — non-streaming tool phase, streaming final answer
                for (let round = 0; round < 8; round++) {
                    const response = await ai.models.generateContent({
                        model,
                        contents: contents as any,
                        config: {
                            systemInstruction: SYSTEM_PROMPT,
                            tools: googleTools as any,
                        },
                    });

                    const fnCalls = response.functionCalls;

                    if (!fnCalls || fnCalls.length === 0) {
                        // No tool calls — stream the final text
                        const streamResponse = await ai.models.generateContentStream({
                            model,
                            contents: contents as any,
                            config: {
                                systemInstruction: SYSTEM_PROMPT,
                                tools: googleTools as any,
                                maxOutputTokens: 8192,
                            },
                        });

                        for await (const chunk of streamResponse) {
                            const text = chunk.text;
                            if (text) send({ type: "text", content: text });
                        }
                        break;
                    }

                    // Add model response with function calls to history
                    contents.push({
                        role: "model",
                        parts: response.candidates![0].content!.parts as any,
                    });

                    // Execute tool calls
                    const toolResultParts: Array<{ functionResponse: { name: string; response: { output: string } } }> = [];
                    for (const fn of fnCalls) {
                        const args = (fn.args ?? {}) as Record<string, unknown>;
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
                        toolResultParts.push({ functionResponse: { name: fn.name!, response: { output: result } } });
                    }

                    // Add tool results to history
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
