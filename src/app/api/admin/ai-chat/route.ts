import { NextRequest } from "next/server";
import { auth } from "@/lib/auth";
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
const FF_API_BASE = process.env.FF_API_BASE_URL ?? "https://api.ffnancy.fr";

// ─── Tool definitions ────────────────────────────────────────────────────────

const TOOLS_OPENROUTER = [
    {
        type: "function",
        function: {
            name: "call_api",
            description: "Appelle un endpoint de l'API FF Nancy pour récupérer des données (articles, stock, ventes, fournisseurs, commandes, etc.).",
            parameters: {
                type: "object",
                properties: {
                    endpoint: {
                        type: "string",
                        description: "Chemin de l'endpoint, ex: /api/articles?codefou=FOU001&limit=50 ou /api/stock/article/12345",
                    },
                },
                required: ["endpoint"],
            },
        },
    },
];

const TOOLS_GOOGLE = [{
    functionDeclarations: [
        {
            name: "call_api",
            description: "Appelle un endpoint de l'API FF Nancy pour récupérer des données (articles, stock, ventes, fournisseurs, commandes, etc.).",
            parameters: {
                type: Type.OBJECT,
                properties: {
                    endpoint: {
                        type: Type.STRING,
                        description: "Chemin de l'endpoint, ex: /api/articles?codefou=FOU001&limit=50 ou /api/stock/article/12345",
                    },
                },
                required: ["endpoint"],
            },
        },
    ],
}];

// ─── API caller ───────────────────────────────────────────────────────────────

async function callFfApi(endpoint: string): Promise<string> {
    // Sécurité : uniquement GET, uniquement les endpoints documentés
    const allowedPrefixes = [
        "/api/health", "/api/sync", "/api/schema",
        "/api/articles", "/api/stock", "/api/fournisseurs",
        "/api/commandes", "/api/mouvements", "/api/performance",
        "/api/publicites", "/api/commandes-auto",
    ];
    const isAllowed = allowedPrefixes.some(p => endpoint.startsWith(p));
    if (!isAllowed) {
        return `Erreur: endpoint non autorisé — "${endpoint}". Utilise uniquement les endpoints documentés.`;
    }

    try {
        const url = `${FF_API_BASE}${endpoint}`;
        const res = await fetch(url, {
            headers: { "Content-Type": "application/json" },
            cache: "no-store",
        });

        if (!res.ok) {
            return `Erreur API ${res.status}: ${await res.text()}`;
        }

        const data = await res.json();
        const text = JSON.stringify(data);

        // Tronquer si trop long (max 6000 chars)
        if (text.length > 6000) {
            return text.substring(0, 6000) + `\n...(tronqué, ${text.length} caractères total)`;
        }
        return text;
    } catch (err) {
        const msg = err instanceof Error ? err.message : "Erreur inconnue";
        return `Erreur réseau: ${msg}`;
    }
}

// ─── System prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `Tu es un assistant IA administrateur expert pour l'application CollectFlow, un outil de gestion de gammes produits et d'analyse des ventes pour des magasins de distribution alimentaire (Foirfouille Nancy).

## Outil disponible
- \`call_api\` : appelle un endpoint GET de l'API FF Nancy et retourne les données JSON

## API FF Nancy — Documentation complète
Base URL : ${FF_API_BASE}
Format des dates : YYYY-MM-DD
Identifiants articles : toujours \`no_id\` (entier interne)
Codes site : ex 000, 001, 002…

### Santé / Infra
- GET /api/health — vérifie que l'API et PostgreSQL répondent
- GET /api/sync/status — état de la synchronisation en cours
- GET /api/schema/tables?search=nom — liste les tables PG
- GET /api/schema/tables/:nom — colonnes d'une table
- GET /api/schema/top?limit=10 — tables les plus peuplées

### Articles
- GET /api/articles?search=&codein=&ean=&codefou=&actif=1&page=1&limit=50 — liste avec PA, GTIN, fournisseur principal (max 500/page)
- GET /api/articles/:id — détail complet d'un article (no_id)
- GET /api/articles/:id/referentiel — fournisseurs, tarifs, codes EAN
- GET /api/articles/:id/mouvements — historique des mouvements
- GET /api/articles/:id/mensuel — CA mensuel de l'article

Le champ **prix d'achat (PA)** est retourné directement dans GET /api/articles (champ \`pa\` ou \`prix_achat\`).
Pour un article précis : GET /api/articles/:id/referentiel pour voir tous les tarifs fournisseurs.

### Stock
- GET /api/stock?site=001&page=1&limit=100 — stock global tous articles (max 1000/page)
- GET /api/stock/article/:id — stock par site pour un article (no_id) → contient aussi \`prmp\` (Prix de Revient Moyen Pondéré)
- GET /api/stock/site/:site — tous les articles d'un site donné
- GET /api/stock/article/:id/historique — historique stock de l'article
- GET /api/stock/article/:id/periode?dateDebut=&dateFin= — stock sur période
- GET /api/stock/valorisation — valeur totale du stock par site

Le **PRMP** (prix réel moyen pondéré) est dans GET /api/stock/article/:id, champ \`prmp\` par site.

### Fournisseurs
- GET /api/fournisseurs?search=nom — liste des fournisseurs (champs : code, nom)
- GET /api/fournisseurs/:code/articles — articles du fournisseur
- GET /api/fournisseurs/:code/commandes — commandes du fournisseur

### Commandes
- GET /api/commandes?dateDebut=&dateFin=&codefou= — liste des commandes fournisseurs
- GET /api/commandes/:noCommande — détail d'une commande + ses lignes
- GET /api/commandes/receptions/liste — liste des réceptions

### Commandes automatiques
- GET /api/commandes-auto?site=&codefou= — résumé des propositions par fournisseur/site avec comparaison franco
  Champs : franco_ht, montant_propo_ht, franco_atteint (OUI/NON/N/A), ecart_franco
- GET /api/commandes-auto/:codefou?site= — détail d'un fournisseur : résumé + liste des articles proposés avec stock et montant

### Mouvements
- GET /api/mouvements/types — types de mouvements disponibles
- GET /api/mouvements/articles?dateDebut=&dateFin=&site= — mouvements par article
- GET /api/mouvements/entrees?dateDebut=&dateFin= — entrées marchandises
- GET /api/mouvements/regularisations?dateDebut=&dateFin= — régularisations inventaire
- GET /api/mouvements/reglements?dateDebut=&dateFin= — règlements
- GET /api/mouvements/synthese?dateDebut=&dateFin=&site= — synthèse des mouvements

### Performance / CA
- GET /api/performance/ca?dateDebut=&dateFin=&site=&groupBy=mois — CA global (groupBy: jour ou mois)
- GET /api/performance/hitparade?dateDebut=&dateFin=&site=&limit=20&groupBy=ca — top articles (groupBy: qte, ca ou marge)
- GET /api/performance/ca/nomenclature?dateDebut=&dateFin=&site=&niveau= — CA par nomenclature
- GET /api/performance/ca/fournisseur?dateDebut=&dateFin=&site= — CA par fournisseur
- GET /api/performance/ca/gamme?dateDebut=&dateFin=&site= — CA par gamme (A/B/C/D/Z)
- GET /api/performance/dashboard — indicateurs résumés pour dashboard

### Publicités
- GET /api/publicites?search=&site=&dateDebut=&dateFin=&page=1&limit=50 — liste des publicités
- GET /api/publicites/:code?site= — détail d'une publicité

## Contexte métier CollectFlow
- Application de gestion de gammes pour magasins Foirfouille Nancy
- Gammes A/B/C/D/Z : A=pilier, B=bonne rotation, C=performance, D=saisonnier/niche, Z=sortie
- Les ventes sont suivies par magasin (site) et par mois
- Les utilisateurs arbitrent les classifications gamme par fournisseur

## Stratégie d'analyse
1. Si tu ne connais pas un code fournisseur ou un no_id, commence par chercher avec /api/fournisseurs?search= ou /api/articles?search=
2. Enchaîne plusieurs appels \`call_api\` si nécessaire pour compléter l'analyse
3. Pour le prix d'achat : utilise /api/articles?codefou=CODE (champ pa) ou /api/articles/:id/referentiel
4. Pour le PRMP (prix réel) : utilise /api/stock/article/:id (champ prmp par site)
5. Ajoute toujours \`limit\` pour éviter des réponses trop volumineuses (limit=20 à 100 selon le contexte)

## Format de réponse — IMPORTANT
- Réponds TOUJOURS en **Markdown** : titres ##, **gras**, tableaux \`| col | col |\`, listes \`-\`, blocs de code
- N'utilise JAMAIS de HTML (<div>, <table>, <b>, <br>, etc.)
- Réponds toujours en français
- Sois précis, structuré et complet — ne tronque jamais ta réponse
- Si les données sont nombreuses, résume et mets en avant les points clés`;

// ─── OpenRouter handler ───────────────────────────────────────────────────────

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
        body.tools = TOOLS_OPENROUTER;
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

// ─── Google AI handler ────────────────────────────────────────────────────────

async function handleGoogleAi(messages: Array<{ role: string; content: string }>, config: AiConfig): Promise<Response> {
    if (!config.googleAiKey) {
        return new Response(JSON.stringify({ error: "No Google AI key configured" }), { status: 500 });
    }

    const model = config.googleAiModel ?? "gemini-2.0-flash";
    const encoder = new TextEncoder();

    const stream = new ReadableStream({
        async start(controller) {
            function send(event: object) {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
            }

            try {
                const ai = new GoogleGenAI({ apiKey: config.googleAiKey! });

                const contents: Array<{ role: string; parts: any[] }> = [
                    ...messages.map((m) => ({
                        role: m.role === "assistant" ? "model" : "user",
                        parts: [{ text: m.content }],
                    })),
                ];

                for (let round = 0; round < 10; round++) {
                    const streamResponse = await ai.models.generateContentStream({
                        model,
                        contents: contents as any,
                        config: {
                            systemInstruction: SYSTEM_PROMPT,
                            tools: TOOLS_GOOGLE as any,
                            maxOutputTokens: 8192,
                        },
                    });

                    let collectedText = "";
                    const collectedParts: any[] = [];

                    for await (const chunk of streamResponse) {
                        const text = chunk.text;
                        if (text) {
                            collectedText += text;
                            send({ type: "text", content: text });
                        }
                        const parts = chunk.candidates?.[0]?.content?.parts;
                        if (parts) collectedParts.push(...parts);
                    }

                    const fnCallParts = collectedParts.filter((p: any) => p.functionCall);

                    if (fnCallParts.length === 0) break;

                    contents.push({ role: "model", parts: collectedText ? collectedParts : fnCallParts });

                    const toolResultParts: Array<{ functionResponse: { name: string; response: { output: string } } }> = [];
                    for (const part of fnCallParts) {
                        const fn = part.functionCall as { name: string; args: Record<string, unknown> };
                        const args = fn.args ?? {};
                        send({ type: "tool_start", name: fn.name, args });

                        let result = "";
                        if (fn.name === "call_api") {
                            result = await callFfApi(args.endpoint as string);
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

// ─── POST handler ─────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
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

    const fullMessages: object[] = [
        { role: "system", content: SYSTEM_PROMPT },
        ...messages,
    ];

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

                for (let round = 0; round < 10; round++) {
                    const res = await callOpenRouter(currentMessages, model, apiKey, true, false);
                    if (!res.ok) {
                        send({ type: "error", message: `OpenRouter error: ${await res.text()}` });
                        controller.close();
                        return;
                    }

                    const data = await res.json();
                    if (data.usage) {
                        totalPromptTokens += data.usage.prompt_tokens ?? 0;
                        totalCompletionTokens += data.usage.completion_tokens ?? 0;
                    }

                    const assistantMessage = data.choices?.[0]?.message;
                    if (!assistantMessage) break;
                    currentMessages.push(assistantMessage);

                    const toolCalls = assistantMessage.tool_calls;
                    if (!toolCalls || toolCalls.length === 0) {
                        directAnswer = assistantMessage.content ?? "";
                        break;
                    }

                    const toolResults: object[] = [];
                    for (const tc of toolCalls) {
                        const fnName = tc.function?.name;
                        let args: Record<string, unknown> = {};
                        try { args = JSON.parse(tc.function?.arguments ?? "{}"); } catch { /* ignore */ }

                        send({ type: "tool_start", name: fnName, args });

                        let result = "";
                        if (fnName === "call_api") {
                            result = await callFfApi(args.endpoint as string);
                        } else {
                            result = `Outil inconnu: ${fnName}`;
                        }

                        send({ type: "tool_result", name: fnName, result: result.substring(0, 500) + (result.length > 500 ? "..." : "") });
                        toolResults.push({ role: "tool", tool_call_id: tc.id, content: result });
                    }
                    currentMessages.push(...toolResults);
                }

                if (directAnswer !== null) {
                    send({ type: "text", content: directAnswer });
                    send({ type: "usage", prompt_tokens: totalPromptTokens, completion_tokens: totalCompletionTokens });
                    send({ type: "done" });
                    controller.close();
                    return;
                }

                // Final streaming call after tool use
                const finalRes = await callOpenRouter(currentMessages, model, apiKey, false, true);
                if (!finalRes.ok) {
                    send({ type: "error", message: `OpenRouter error: ${await finalRes.text()}` });
                    controller.close();
                    return;
                }

                const reader = finalRes.body?.getReader();
                if (!reader) { controller.close(); return; }

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
                            if (delta) send({ type: "text", content: delta });
                            if (chunk.usage) finalUsage = chunk.usage;
                        } catch { /* ignore */ }
                    }
                }

                if (finalUsage) {
                    totalPromptTokens += finalUsage.prompt_tokens ?? 0;
                    totalCompletionTokens += finalUsage.completion_tokens ?? 0;
                }

                send({ type: "usage", prompt_tokens: totalPromptTokens, completion_tokens: totalCompletionTokens });
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
