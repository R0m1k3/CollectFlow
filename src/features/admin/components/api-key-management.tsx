"use client";

/**
 * CollectFlow — Gestion des clés de l'API `/api/v1`.
 *
 * La clé générée n'est affichable qu'une fois : elle est mise en évidence après
 * création, puis irrécupérable (seul son hachage est stocké côté base).
 */

import { useState, useEffect, useCallback } from "react";
import { KeyRound, Plus, Loader2, Copy, Check, Ban, Trash2, AlertTriangle } from "lucide-react";
import { getApiKeys, createApiKey, revokeApiKey, deleteApiKey, type ApiKeyRow } from "../api/api-key-actions";

function fmtDate(iso: string | null): string {
    if (!iso) return "—";
    return new Date(iso).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" });
}

export function ApiKeyManagement() {
    const [keys, setKeys] = useState<ApiKeyRow[]>([]);
    const [loading, setLoading] = useState(true);
    const [creating, setCreating] = useState(false);
    const [name, setName] = useState("");
    const [role, setRole] = useState<"admin" | "user">("user");
    const [freshKey, setFreshKey] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Pas de setState synchrone ici : `loading` démarre déjà à true, et le premier
    // statement est un await. Cela évite une cascade de rendus au montage.
    const refresh = useCallback(async () => {
        try {
            setKeys(await getApiKeys());
            setError(null);
        } catch (e) {
            setError(e instanceof Error ? e.message : "Erreur de chargement");
        } finally {
            setLoading(false);
        }
    }, []);

    // Chargement initial depuis la base — la donnée vient d'un système externe, pas
    // d'un état dérivé. `refresh` n'appelle setState qu'après un await.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { refresh(); }, [refresh]);

    const handleCreate = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!name.trim() || creating) return;
        setCreating(true);
        setError(null);
        const res = await createApiKey(name.trim(), role);
        if (res.success) {
            setFreshKey(res.key);
            setName("");
            setCopied(false);
            await refresh();
        } else {
            setError(res.error);
        }
        setCreating(false);
    };

    const handleRevoke = async (id: number) => {
        await revokeApiKey(id);
        await refresh();
    };

    const handleDelete = async (id: number) => {
        await deleteApiKey(id);
        await refresh();
    };

    return (
        <div className="space-y-4">
            <p className="text-[12px] text-[var(--text-secondary)]">
                Les clés donnent accès à l&apos;API de lecture <code className="font-mono">/api/v1</code> (grille,
                recherche, métriques réseau) depuis un script ou un outil externe, via l&apos;en-tête{" "}
                <code className="font-mono">X-API-Key</code>. Depuis un navigateur connecté, la session suffit.
            </p>

            {/* Clé fraîchement créée — visible une seule fois */}
            {freshKey && (
                <div className="rounded-xl p-3.5 space-y-2"
                    style={{ background: "var(--accent-bg)", border: "1px solid var(--accent-border)" }}>
                    <div className="flex items-start gap-2 text-[12px] font-semibold" style={{ color: "var(--text-primary)" }}>
                        <AlertTriangle className="w-4 h-4 shrink-0 mt-px" style={{ color: "var(--accent)" }} />
                        Copiez cette clé maintenant — elle ne sera plus jamais affichée.
                    </div>
                    <div className="flex items-center gap-2">
                        <code className="flex-1 rounded-lg px-2.5 py-2 text-[12px] font-mono break-all"
                            style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)", color: "var(--text-primary)" }}>
                            {freshKey}
                        </code>
                        <button
                            type="button"
                            onClick={() => { navigator.clipboard.writeText(freshKey); setCopied(true); }}
                            className="rounded-lg px-2.5 py-2 shrink-0"
                            style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)", color: "var(--text-secondary)" }}
                            title="Copier"
                        >
                            {copied ? <Check className="w-4 h-4 text-emerald-500" /> : <Copy className="w-4 h-4" />}
                        </button>
                    </div>
                    <button
                        type="button"
                        onClick={() => setFreshKey(null)}
                        className="text-[11px] underline"
                        style={{ color: "var(--text-muted)" }}
                    >
                        J&apos;ai copié la clé, masquer
                    </button>
                </div>
            )}

            {/* Création */}
            <form onSubmit={handleCreate} className="flex flex-col sm:flex-row gap-2">
                <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Nom de la clé (ex. Export comptabilité)"
                    className="flex-1 rounded-lg px-3 py-2 text-[13px] outline-none"
                    style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)", color: "var(--text-primary)" }}
                />
                <select
                    value={role}
                    onChange={(e) => setRole(e.target.value as "admin" | "user")}
                    className="rounded-lg px-3 py-2 text-[13px] outline-none"
                    style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)", color: "var(--text-primary)" }}
                >
                    <option value="user">Rôle : utilisateur</option>
                    <option value="admin">Rôle : administrateur</option>
                </select>
                <button
                    type="submit"
                    disabled={creating || !name.trim()}
                    className="rounded-lg px-4 py-2 text-[13px] font-semibold text-white disabled:opacity-50 flex items-center justify-center gap-1.5"
                    style={{ background: "var(--accent)" }}
                >
                    {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                    Créer
                </button>
            </form>

            {error && (
                <p className="text-[12px]" style={{ color: "var(--accent-error)" }}>{error}</p>
            )}

            {/* Liste */}
            {loading ? (
                <div className="flex items-center gap-2 text-[12px]" style={{ color: "var(--text-muted)" }}>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" /> Chargement…
                </div>
            ) : keys.length === 0 ? (
                <p className="text-[12px]" style={{ color: "var(--text-muted)" }}>Aucune clé pour le moment.</p>
            ) : (
                <div className="rounded-xl overflow-hidden" style={{ border: "1px solid var(--border)" }}>
                    <table className="w-full text-[12px]">
                        <thead>
                            <tr style={{ background: "var(--bg-elevated)" }}>
                                <th className="text-left px-3 py-2 font-semibold" style={{ color: "var(--text-secondary)" }}>Nom</th>
                                <th className="text-left px-3 py-2 font-semibold" style={{ color: "var(--text-secondary)" }}>Préfixe</th>
                                <th className="text-left px-3 py-2 font-semibold" style={{ color: "var(--text-secondary)" }}>Rôle</th>
                                <th className="text-left px-3 py-2 font-semibold" style={{ color: "var(--text-secondary)" }}>Créée</th>
                                <th className="text-left px-3 py-2 font-semibold" style={{ color: "var(--text-secondary)" }}>Dernier usage</th>
                                <th className="px-3 py-2"></th>
                            </tr>
                        </thead>
                        <tbody>
                            {keys.map((k) => (
                                <tr key={k.id} style={{ borderTop: "1px solid var(--border)", opacity: k.revokedAt ? 0.55 : 1 }}>
                                    <td className="px-3 py-2 font-medium" style={{ color: "var(--text-primary)" }}>
                                        <span className="inline-flex items-center gap-1.5">
                                            <KeyRound className="w-3.5 h-3.5" style={{ color: "var(--text-muted)" }} />
                                            {k.name}
                                        </span>
                                        {k.revokedAt && (
                                            <span className="ml-2 rounded px-1.5 py-px text-[9px] font-bold uppercase"
                                                style={{ background: "var(--accent-error-bg)", color: "var(--accent-error)" }}>
                                                Révoquée
                                            </span>
                                        )}
                                    </td>
                                    <td className="px-3 py-2 font-mono" style={{ color: "var(--text-secondary)" }}>{k.keyPrefix}…</td>
                                    <td className="px-3 py-2" style={{ color: "var(--text-secondary)" }}>{k.role}</td>
                                    <td className="px-3 py-2" style={{ color: "var(--text-muted)" }}>{fmtDate(k.createdAt)}</td>
                                    <td className="px-3 py-2" style={{ color: "var(--text-muted)" }}>{fmtDate(k.lastUsedAt)}</td>
                                    <td className="px-3 py-2 text-right whitespace-nowrap">
                                        {!k.revokedAt ? (
                                            <button
                                                onClick={() => handleRevoke(k.id)}
                                                className="inline-flex items-center gap-1 rounded-lg px-2 py-1"
                                                style={{ color: "var(--accent-error)" }}
                                                title="Révoquer"
                                            >
                                                <Ban className="w-3.5 h-3.5" /> Révoquer
                                            </button>
                                        ) : (
                                            <button
                                                onClick={() => handleDelete(k.id)}
                                                className="inline-flex items-center gap-1 rounded-lg px-2 py-1"
                                                style={{ color: "var(--text-muted)" }}
                                                title="Supprimer définitivement"
                                            >
                                                <Trash2 className="w-3.5 h-3.5" /> Supprimer
                                            </button>
                                        )}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}
