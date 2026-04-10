"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { Send, Bot, User, Database, Loader2, AlertCircle, ChevronDown, Trash2, DollarSign } from "lucide-react";
import { cn } from "@/lib/utils";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface ModelInfo {
    id: string;
    name: string;
    free: boolean;
    promptPrice: number;   // $ per token
    completionPrice: number;
}

interface ToolEvent {
    name: string;
    args: Record<string, unknown>;
    result?: string;
}

interface Message {
    role: "user" | "assistant";
    content: string;
    toolEvents?: ToolEvent[];
}

interface SessionUsage {
    promptTokens: number;
    completionTokens: number;
    costUsd: number;
}

const DEFAULT_MODEL = "google/gemini-2.0-flash-001";

// Compute cost from token counts and model pricing
function computeCost(promptTokens: number, completionTokens: number, model: ModelInfo | null): number {
    if (!model) return 0;
    return promptTokens * model.promptPrice + completionTokens * model.completionPrice;
}

function formatCost(usd: number): string {
    if (usd === 0) return "Gratuit";
    if (usd < 0.001) return `$${(usd * 1000).toFixed(4)}m`;
    return `$${usd.toFixed(6)}`;
}

function ToolCallBlock({ event }: { event: ToolEvent }) {
    const [open, setOpen] = useState(false);

    const label = event.name === "execute_sql"
        ? `SQL: ${String(event.args.query ?? "").substring(0, 60)}${String(event.args.query ?? "").length > 60 ? "…" : ""}`
        : event.name === "get_db_schema"
            ? "Schéma DB"
            : event.name;

    return (
        <div className="my-1 rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] overflow-hidden text-xs">
            <button
                onClick={() => setOpen(!open)}
                className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-[var(--bg-base)] transition-colors"
            >
                <Database className="w-3.5 h-3.5 text-[var(--accent)] shrink-0" />
                <span className="flex-1 text-[var(--text-secondary)] font-mono truncate">{label}</span>
                <ChevronDown className={cn("w-3.5 h-3.5 text-[var(--text-muted)] transition-transform", open && "rotate-180")} />
            </button>
            {open && event.result && (
                <pre className="px-3 pb-3 pt-1 text-[10px] text-[var(--text-secondary)] overflow-x-auto whitespace-pre-wrap break-words max-h-48 overflow-y-auto">
                    {event.result}
                </pre>
            )}
        </div>
    );
}

function MessageBubble({ msg }: { msg: Message }) {
    const isUser = msg.role === "user";

    return (
        <div className={cn("flex gap-3 mb-4", isUser && "flex-row-reverse")}>
            {/* Avatar */}
            <div className={cn(
                "w-8 h-8 rounded-full flex items-center justify-center shrink-0 mt-0.5",
                isUser ? "bg-[var(--accent)] text-white" : "bg-[var(--bg-elevated)] border border-[var(--border)]"
            )}>
                {isUser
                    ? <User className="w-4 h-4" />
                    : <Bot className="w-4 h-4 text-[var(--accent)]" />
                }
            </div>

            {/* Content */}
            <div className={cn("flex-1 max-w-[85%]", isUser && "flex flex-col items-end")}>
                {/* Tool events (assistant only) */}
                {msg.toolEvents && msg.toolEvents.length > 0 && (
                    <div className="w-full mb-2">
                        {msg.toolEvents.map((ev, i) => (
                            <ToolCallBlock key={i} event={ev} />
                        ))}
                    </div>
                )}

                {/* Text bubble */}
                {msg.content && (
                    <div className={cn(
                        "rounded-2xl px-4 py-3 text-sm leading-relaxed break-words",
                        isUser
                            ? "bg-[var(--accent)] text-white rounded-tr-md"
                            : "bg-[var(--bg-elevated)] border border-[var(--border)] text-[var(--text-primary)] rounded-tl-md"
                    )}>
                        {isUser ? msg.content : (
                            <ReactMarkdown
                                remarkPlugins={[remarkGfm]}
                                components={{
                                    p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
                                    h1: ({ children }) => <h1 className="text-base font-bold mb-2 mt-3 first:mt-0">{children}</h1>,
                                    h2: ({ children }) => <h2 className="text-sm font-bold mb-2 mt-3 first:mt-0">{children}</h2>,
                                    h3: ({ children }) => <h3 className="text-sm font-semibold mb-1 mt-2 first:mt-0">{children}</h3>,
                                    ul: ({ children }) => <ul className="list-disc list-inside mb-2 space-y-0.5">{children}</ul>,
                                    ol: ({ children }) => <ol className="list-decimal list-inside mb-2 space-y-0.5">{children}</ol>,
                                    li: ({ children }) => <li className="ml-2">{children}</li>,
                                    code: ({ inline, children }: { inline?: boolean; children?: React.ReactNode }) =>
                                        inline
                                            ? <code className="px-1 py-0.5 rounded bg-[var(--bg-base)] border border-[var(--border)] font-mono text-xs text-[var(--accent)]">{children}</code>
                                            : <pre className="my-2 p-3 rounded-lg bg-[var(--bg-base)] border border-[var(--border)] overflow-x-auto"><code className="font-mono text-xs text-[var(--text-primary)] whitespace-pre">{children}</code></pre>,
                                    strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
                                    em: ({ children }) => <em className="italic">{children}</em>,
                                    blockquote: ({ children }) => <blockquote className="border-l-2 border-[var(--accent)] pl-3 my-2 text-[var(--text-secondary)] italic">{children}</blockquote>,
                                    table: ({ children }) => <div className="overflow-x-auto my-2"><table className="w-full text-xs border-collapse">{children}</table></div>,
                                    thead: ({ children }) => <thead className="bg-[var(--bg-base)]">{children}</thead>,
                                    th: ({ children }) => <th className="border border-[var(--border)] px-2 py-1 text-left font-semibold">{children}</th>,
                                    td: ({ children }) => <td className="border border-[var(--border)] px-2 py-1">{children}</td>,
                                    hr: () => <hr className="border-[var(--border)] my-3" />,
                                    a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer" className="text-[var(--accent)] underline hover:opacity-80">{children}</a>,
                                }}
                            >
                                {msg.content}
                            </ReactMarkdown>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}

export default function AdminAiChatPage() {
    const [models, setModels] = useState<ModelInfo[]>([]);
    const [selectedModel, setSelectedModel] = useState<string>(DEFAULT_MODEL);
    const [messages, setMessages] = useState<Message[]>([]);
    const [input, setInput] = useState("");
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [loadingModels, setLoadingModels] = useState(true);
    const [sessionUsage, setSessionUsage] = useState<SessionUsage>({ promptTokens: 0, completionTokens: 0, costUsd: 0 });

    const messagesEndRef = useRef<HTMLDivElement>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const abortRef = useRef<AbortController | null>(null);

    const selectedModelInfo = models.find(m => m.id === selectedModel) ?? null;

    // Fetch models
    useEffect(() => {
        setLoadingModels(true);
        fetch("/api/openrouter/models")
            .then(r => r.json())
            .then(d => {
                if (d.models) setModels(d.models);
            })
            .catch(() => { })
            .finally(() => setLoadingModels(false));
    }, []);

    // Auto-scroll
    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [messages, loading]);

    const sendMessage = useCallback(async () => {
        if (!input.trim() || loading) return;

        const userMsg: Message = { role: "user", content: input.trim() };
        setInput("");
        setError(null);
        setMessages(prev => [...prev, userMsg]);
        setLoading(true);

        // Build messages to send (excluding tool events, which are local display only)
        const apiMessages = [...messages, userMsg].map(m => ({
            role: m.role,
            content: m.content,
        }));

        const assistantMsg: Message = { role: "assistant", content: "", toolEvents: [] };
        setMessages(prev => [...prev, assistantMsg]);

        abortRef.current = new AbortController();

        try {
            const res = await fetch("/api/admin/ai-chat", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ messages: apiMessages, model: selectedModel }),
                signal: abortRef.current.signal,
            });

            if (!res.ok) {
                const err = await res.json();
                throw new Error(err.error || "Erreur serveur");
            }

            const reader = res.body!.getReader();
            const decoder = new TextDecoder();
            let buffer = "";
            const pendingToolEvents: ToolEvent[] = [];
            let lastToolStart: ToolEvent | null = null;

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split("\n");
                buffer = lines.pop() ?? "";

                for (const line of lines) {
                    if (!line.startsWith("data: ")) continue;
                    const raw = line.slice(6).trim();
                    try {
                        const event = JSON.parse(raw);

                        if (event.type === "text") {
                            setMessages(prev => {
                                const copy = [...prev];
                                const last = { ...copy[copy.length - 1] };
                                last.content += event.content;
                                copy[copy.length - 1] = last;
                                return copy;
                            });
                        } else if (event.type === "tool_start") {
                            lastToolStart = { name: event.name, args: event.args };
                        } else if (event.type === "tool_result") {
                            if (lastToolStart) {
                                const ev: ToolEvent = { ...lastToolStart, result: event.result };
                                pendingToolEvents.push(ev);
                                lastToolStart = null;
                                setMessages(prev => {
                                    const copy = [...prev];
                                    const last = { ...copy[copy.length - 1] };
                                    last.toolEvents = [...pendingToolEvents];
                                    copy[copy.length - 1] = last;
                                    return copy;
                                });
                            }
                        } else if (event.type === "usage") {
                            const pt = event.prompt_tokens ?? 0;
                            const ct = event.completion_tokens ?? 0;
                            const cost = computeCost(pt, ct, selectedModelInfo);
                            setSessionUsage(prev => ({
                                promptTokens: prev.promptTokens + pt,
                                completionTokens: prev.completionTokens + ct,
                                costUsd: prev.costUsd + cost,
                            }));
                        } else if (event.type === "error") {
                            setError(event.message);
                        }
                    } catch { /* ignore */ }
                }
            }
        } catch (err) {
            if ((err as Error).name !== "AbortError") {
                setError(err instanceof Error ? err.message : "Erreur inconnue");
            }
        } finally {
            setLoading(false);
        }
    }, [input, loading, messages, selectedModel, selectedModelInfo]);

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    };

    const clearConversation = () => {
        setMessages([]);
        setSessionUsage({ promptTokens: 0, completionTokens: 0, costUsd: 0 });
        setError(null);
        if (loading && abortRef.current) {
            abortRef.current.abort();
            setLoading(false);
        }
    };

    return (
        <div className="flex flex-col h-full max-h-full">
            {/* Header */}
            <div className="flex items-center justify-between mb-4 shrink-0">
                <div>
                    <h1 className="text-xl font-semibold text-[var(--text-primary)] flex items-center gap-2">
                        <Bot className="w-5 h-5 text-[var(--accent)]" />
                        Admin AI Chat
                    </h1>
                    <p className="text-xs text-[var(--text-muted)] mt-0.5">
                        Accès direct à la base de données · Admin uniquement
                    </p>
                </div>

                {/* Usage / Cost */}
                <div className="flex items-center gap-3">
                    <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--bg-elevated)] border border-[var(--border)] text-xs text-[var(--text-secondary)]">
                        <DollarSign className="w-3.5 h-3.5 text-[var(--accent)]" />
                        <span className="font-mono font-semibold">{formatCost(sessionUsage.costUsd)}</span>
                        <span className="text-[var(--text-muted)]">session</span>
                        {sessionUsage.promptTokens > 0 && (
                            <span className="text-[var(--text-muted)] ml-1">
                                ({sessionUsage.promptTokens + sessionUsage.completionTokens} tok)
                            </span>
                        )}
                    </div>

                    <button
                        onClick={clearConversation}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[var(--border)] text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)] transition-colors"
                    >
                        <Trash2 className="w-3.5 h-3.5" />
                        Effacer
                    </button>
                </div>
            </div>

            {/* Model selector */}
            <div className="mb-4 shrink-0">
                <div className="flex items-center gap-3 p-3 rounded-xl bg-[var(--bg-elevated)] border border-[var(--border)]">
                    <span className="text-xs font-medium text-[var(--text-muted)] shrink-0">Modèle</span>
                    {loadingModels ? (
                        <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            Chargement des modèles…
                        </div>
                    ) : (
                        <div className="flex items-center gap-3 flex-1 min-w-0">
                            <select
                                value={selectedModel}
                                onChange={e => setSelectedModel(e.target.value)}
                                className="flex-1 min-w-0 text-sm bg-transparent text-[var(--text-primary)] border-none outline-none cursor-pointer"
                            >
                                {models.map(m => (
                                    <option key={m.id} value={m.id}>
                                        {m.name} {m.free ? "(Gratuit)" : ""}
                                    </option>
                                ))}
                            </select>
                            {selectedModelInfo && !selectedModelInfo.free && (
                                <div className="flex items-center gap-2 text-[10px] text-[var(--text-muted)] shrink-0 font-mono">
                                    <span>in: ${(selectedModelInfo.promptPrice * 1_000_000).toFixed(2)}/M</span>
                                    <span>·</span>
                                    <span>out: ${(selectedModelInfo.completionPrice * 1_000_000).toFixed(2)}/M</span>
                                </div>
                            )}
                            {selectedModelInfo?.free && (
                                <span className="text-[10px] text-emerald-500 font-semibold shrink-0">GRATUIT</span>
                            )}
                        </div>
                    )}
                </div>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto min-h-0 rounded-xl bg-[var(--bg-base)] border border-[var(--border)] p-4">
                {messages.length === 0 && (
                    <div className="h-full flex flex-col items-center justify-center text-center gap-4">
                        <div className="w-16 h-16 rounded-2xl bg-[var(--accent-bg)] border border-[var(--accent-border)] flex items-center justify-center">
                            <Bot className="w-8 h-8 text-[var(--accent)]" />
                        </div>
                        <div>
                            <p className="text-[var(--text-primary)] font-medium mb-1">Assistant Admin CollectFlow</p>
                            <p className="text-sm text-[var(--text-muted)] max-w-md">
                                Posez des questions sur vos données, demandez des analyses, ou explorez la base de données.
                            </p>
                        </div>
                        <div className="grid grid-cols-2 gap-2 max-w-lg mt-2">
                            {[
                                "Combien de produits par fournisseur ?",
                                "Quels sont les 10 produits avec le plus de CA ?",
                                "Montre-moi les snapshots récents",
                                "Répartition des gammes A/B/C/D/Z",
                            ].map(suggestion => (
                                <button
                                    key={suggestion}
                                    onClick={() => { setInput(suggestion); textareaRef.current?.focus(); }}
                                    className="text-xs text-left px-3 py-2 rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] hover:bg-[var(--bg-base)] text-[var(--text-secondary)] transition-colors"
                                >
                                    {suggestion}
                                </button>
                            ))}
                        </div>
                    </div>
                )}

                {messages.map((msg, i) => (
                    <MessageBubble key={i} msg={msg} />
                ))}

                {loading && messages[messages.length - 1]?.role !== "assistant" && (
                    <div className="flex gap-3 mb-4">
                        <div className="w-8 h-8 rounded-full flex items-center justify-center bg-[var(--bg-elevated)] border border-[var(--border)]">
                            <Bot className="w-4 h-4 text-[var(--accent)]" />
                        </div>
                        <div className="flex items-center gap-1.5 px-4 py-3 rounded-2xl rounded-tl-md bg-[var(--bg-elevated)] border border-[var(--border)]">
                            <span className="w-1.5 h-1.5 bg-[var(--accent)] rounded-full animate-bounce [animation-delay:0ms]" />
                            <span className="w-1.5 h-1.5 bg-[var(--accent)] rounded-full animate-bounce [animation-delay:150ms]" />
                            <span className="w-1.5 h-1.5 bg-[var(--accent)] rounded-full animate-bounce [animation-delay:300ms]" />
                        </div>
                    </div>
                )}

                {error && (
                    <div className="flex items-start gap-2 p-3 rounded-xl bg-[var(--accent-error-bg)] border border-[var(--accent-error-border,var(--border))] text-sm text-[var(--accent-error)] mb-4">
                        <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                        <span>{error}</span>
                    </div>
                )}

                <div ref={messagesEndRef} />
            </div>

            {/* Input */}
            <div className="mt-3 shrink-0">
                <div className="flex items-end gap-2 p-2 rounded-xl bg-[var(--bg-elevated)] border border-[var(--border)] focus-within:border-[var(--accent)] transition-colors">
                    <textarea
                        ref={textareaRef}
                        value={input}
                        onChange={e => setInput(e.target.value)}
                        onKeyDown={handleKeyDown}
                        placeholder="Posez une question… (Entrée pour envoyer, Shift+Entrée pour nouvelle ligne)"
                        rows={1}
                        className="flex-1 resize-none bg-transparent text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none py-2 px-2 max-h-32 overflow-y-auto"
                        style={{ minHeight: "40px" }}
                        onInput={(e) => {
                            const el = e.currentTarget;
                            el.style.height = "auto";
                            el.style.height = Math.min(el.scrollHeight, 128) + "px";
                        }}
                        disabled={loading}
                    />
                    <button
                        onClick={sendMessage}
                        disabled={!input.trim() || loading}
                        className="w-9 h-9 rounded-lg bg-[var(--accent)] text-white flex items-center justify-center hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity shrink-0"
                    >
                        {loading
                            ? <Loader2 className="w-4 h-4 animate-spin" />
                            : <Send className="w-4 h-4" />
                        }
                    </button>
                </div>
                <p className="text-[10px] text-[var(--text-muted)] mt-1.5 text-center">
                    L&apos;IA peut exécuter des requêtes SELECT sur la base de données · Les modifications ne sont pas autorisées
                </p>
            </div>
        </div>
    );
}
