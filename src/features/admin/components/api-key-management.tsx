"use client";

/**
 * CollectFlow — Gestion des clés de l'API `/api/v1`.
 *
 * La clé générée n'est affichable qu'une fois : elle est mise en évidence après
 * création, puis irrécupérable (seul son hachage est stocké côté base).
 */

import { useState, useEffect, useCallback, type FormEvent } from "react";
import { KeyRound, Plus, Loader2, Copy, Check, Ban, Trash2, AlertTriangle } from "lucide-react";
import { getApiKeys, createApiKey, revokeApiKey, deleteApiKey, type ApiKeyRow } from "../api/api-key-actions";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input, Label, Select } from "@/components/ui/form-controls";
import { EmptyState, ErrorState, Skeleton } from "@/components/ui/states";
import { confirmer, toast } from "@/components/ui/feedback";
import { isStaleServerActionError, STALE_ACTION_MESSAGE } from "@/lib/stale-action";

type Role = "admin" | "user";

const ROLES = [
    { value: "user", label: "Utilisateur" },
    { value: "admin", label: "Administrateur" },
] as const;

const LIBELLE_ROLE: Record<string, string> = { admin: "Administrateur", user: "Utilisateur" };

function fmtDate(iso: string | null): string {
    if (!iso) return "—";
    return new Date(iso).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" });
}

function messageErreur(e: unknown): string {
    if (isStaleServerActionError(e)) return STALE_ACTION_MESSAGE;
    return e instanceof Error ? e.message : String(e);
}

export function ApiKeyManagement() {
    const [keys, setKeys] = useState<ApiKeyRow[]>([]);
    const [loading, setLoading] = useState(true);
    const [erreurChargement, setErreurChargement] = useState<string | null>(null);
    const [creating, setCreating] = useState(false);
    const [name, setName] = useState("");
    const [role, setRole] = useState<Role>("user");
    const [freshKey, setFreshKey] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);
    const [enCours, setEnCours] = useState<number | null>(null);

    // Pas de setState synchrone ici : `loading` démarre déjà à true, et le premier
    // statement est un await. Cela évite une cascade de rendus au montage.
    const refresh = useCallback(async () => {
        try {
            setKeys(await getApiKeys());
            setErreurChargement(null);
        } catch (e) {
            setErreurChargement(messageErreur(e));
        } finally {
            setLoading(false);
        }
    }, []);

    // Chargement initial depuis la base — la donnée vient d'un système externe, pas
    // d'un état dérivé. `refresh` n'appelle setState qu'après un await.
    useEffect(() => { void refresh(); }, [refresh]);

    const reessayer = () => {
        setLoading(true);
        void refresh();
    };

    const handleCreate = async (e: FormEvent) => {
        e.preventDefault();
        const nom = name.trim();
        if (!nom || creating) return;
        setCreating(true);
        try {
            const res = await createApiKey(nom, role);
            if (res.success) {
                setFreshKey(res.key);
                setName("");
                setCopied(false);
                toast.succes(`Clé « ${nom} » créée. Copiez-la maintenant : elle ne sera plus affichée.`);
                await refresh();
            } else {
                toast.erreur(res.error);
            }
        } catch (err) {
            toast.erreur(`La clé n'a pas pu être créée : ${messageErreur(err)}`);
        } finally {
            setCreating(false);
        }
    };

    const copier = async () => {
        if (!freshKey) return;
        try {
            await navigator.clipboard.writeText(freshKey);
            setCopied(true);
            toast.succes("Clé copiée dans le presse-papiers.");
        } catch {
            toast.erreur("La copie automatique a échoué : sélectionnez la clé et copiez-la à la main.");
        }
    };

    const handleRevoke = async (k: ApiKeyRow) => {
        const ok = await confirmer({
            titre: `Révoquer la clé « ${k.name} » ?`,
            message: "Les scripts et outils qui l'utilisent seront refusés dès leur prochain appel. La clé reste dans la liste pour garder la trace de son utilisation.",
            libelleConfirmer: "Révoquer",
            danger: true,
        });
        if (!ok) return;
        setEnCours(k.id);
        try {
            const res = await revokeApiKey(k.id);
            if (res.success) toast.succes(`La clé « ${k.name} » est révoquée.`);
            else toast.erreur(res.error ?? "La clé n'a pas pu être révoquée.");
            await refresh();
        } catch (err) {
            toast.erreur(`La clé n'a pas pu être révoquée : ${messageErreur(err)}`);
        } finally {
            setEnCours(null);
        }
    };

    const handleDelete = async (k: ApiKeyRow) => {
        const ok = await confirmer({
            titre: `Supprimer définitivement la clé « ${k.name} » ?`,
            message: "Elle disparaîtra de la liste, avec la trace de sa dernière utilisation.",
            libelleConfirmer: "Supprimer",
            danger: true,
        });
        if (!ok) return;
        setEnCours(k.id);
        try {
            const res = await deleteApiKey(k.id);
            if (res.success) toast.succes(`La clé « ${k.name} » a été supprimée.`);
            else toast.erreur(res.error ?? "La clé n'a pas pu être supprimée.");
            await refresh();
        } catch (err) {
            toast.erreur(`La clé n'a pas pu être supprimée : ${messageErreur(err)}`);
        } finally {
            setEnCours(null);
        }
    };

    return (
        <Card>
            <CardHeader
                title="Clés d'accès à l'API"
                description={
                    <>
                        Une clé permet à un script ou à un outil externe (ChatGPT, tableur…) de lire les données de
                        CollectFlow sans se connecter. Depuis un navigateur déjà connecté, aucune clé n&apos;est nécessaire.
                    </>
                }
            />
            <CardContent className="space-y-5">
                {/* Clé fraîchement créée — visible une seule fois */}
                {freshKey && (
                    <div className="space-y-3 rounded-xl border border-[var(--accent-border)] bg-[var(--accent-bg)] p-4">
                        <p className="flex items-start gap-2 text-sm font-semibold text-[var(--text-primary)]">
                            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--accent)]" aria-hidden />
                            Copiez cette clé maintenant : elle ne sera plus jamais affichée.
                        </p>
                        <div className="flex items-center gap-2">
                            <code className="flex-1 break-all rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] px-3 py-2 font-mono text-[13px] text-[var(--text-primary)]">
                                {freshKey}
                            </code>
                            <Button variant="outline" onClick={copier}>
                                {copied ? <Check className="text-[var(--accent-success)]" /> : <Copy />}
                                {copied ? "Copiée" : "Copier"}
                            </Button>
                        </div>
                        <Button variant="ghost" size="sm" onClick={() => setFreshKey(null)}>
                            J&apos;ai copié la clé, la masquer
                        </Button>
                    </div>
                )}

                {/* Création */}
                <form onSubmit={handleCreate} className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-end">
                    <div>
                        <Label htmlFor="cle-nom">Nom de la clé</Label>
                        <Input
                            id="cle-nom"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            placeholder="ex. Export comptabilité"
                            className="w-full"
                            autoComplete="off"
                        />
                    </div>
                    <Select
                        id="cle-role"
                        label="Droits"
                        value={role}
                        onChange={(v) => setRole(v as Role)}
                        options={ROLES}
                    />
                    <Button type="submit" disabled={creating || !name.trim()}>
                        {creating ? <Loader2 className="animate-spin" /> : <Plus />}
                        Créer la clé
                    </Button>
                </form>
                <p className="-mt-2 text-xs text-[var(--text-muted)]">
                    Donnez un nom qui dit à quoi sert la clé : vous saurez laquelle révoquer le jour où l&apos;outil n&apos;est plus utilisé.
                    La clé s&apos;envoie dans l&apos;en-tête <code className="font-mono">X-API-Key</code> de chaque appel.
                </p>

                {/* Liste */}
                {loading ? (
                    <div className="space-y-2" aria-busy="true" aria-label="Chargement des clés">
                        {Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-10 w-full" />)}
                    </div>
                ) : erreurChargement ? (
                    <ErrorState
                        title="La liste des clés n'a pas pu être chargée"
                        detail={erreurChargement}
                        action={<Button variant="outline" onClick={reessayer}>Réessayer</Button>}
                    />
                ) : keys.length === 0 ? (
                    <EmptyState
                        icon={KeyRound}
                        title="Aucune clé pour le moment"
                        description="Créez une clé ci-dessus pour permettre à un outil externe d'interroger l'API."
                    />
                ) : (
                    <div className="overflow-x-auto rounded-lg border border-[var(--border)]">
                        <table className="w-full">
                            <thead className="bg-[var(--bg-elevated)] text-[13px] font-semibold text-[var(--text-secondary)]">
                                <tr>
                                    <th scope="col" className="px-3 py-2 text-left">Nom</th>
                                    <th scope="col" className="px-3 py-2 text-left">Début de la clé</th>
                                    <th scope="col" className="px-3 py-2 text-left">Droits</th>
                                    <th scope="col" className="px-3 py-2 text-left">Créée le</th>
                                    <th scope="col" className="px-3 py-2 text-left">Dernière utilisation</th>
                                    <th scope="col" className="px-3 py-2 text-right"><span className="sr-only">Actions</span></th>
                                </tr>
                            </thead>
                            <tbody>
                                {keys.map((k) => (
                                    <tr key={k.id} className="border-t border-[var(--border)]">
                                        <td className="px-3 py-2 text-sm font-medium text-[var(--text-primary)]">
                                            <span className={k.revokedAt ? "inline-flex items-center gap-2 opacity-60" : "inline-flex items-center gap-2"}>
                                                <KeyRound className="h-4 w-4 text-[var(--text-muted)]" aria-hidden />
                                                {k.name}
                                            </span>
                                            {k.revokedAt && (
                                                <Badge ton="erreur" className="ml-2" title={`Révoquée le ${fmtDate(k.revokedAt)}`}>Révoquée</Badge>
                                            )}
                                        </td>
                                        <td className="px-3 py-2 font-mono text-sm text-[var(--text-secondary)]">{k.keyPrefix}…</td>
                                        <td className="px-3 py-2 text-sm text-[var(--text-secondary)]">{LIBELLE_ROLE[k.role] ?? k.role}</td>
                                        <td className="px-3 py-2 text-sm whitespace-nowrap text-[var(--text-secondary)]">{fmtDate(k.createdAt)}</td>
                                        <td className="px-3 py-2 text-sm whitespace-nowrap text-[var(--text-secondary)]">
                                            {k.lastUsedAt ? fmtDate(k.lastUsedAt) : "Jamais"}
                                        </td>
                                        <td className="px-3 py-2 text-right whitespace-nowrap">
                                            {!k.revokedAt ? (
                                                <Button
                                                    variant="ghost"
                                                    size="sm"
                                                    onClick={() => handleRevoke(k)}
                                                    disabled={enCours === k.id}
                                                    className="text-[var(--accent-error)] hover:bg-[var(--accent-error-bg)] hover:text-[var(--accent-error)]"
                                                >
                                                    {enCours === k.id ? <Loader2 className="animate-spin" /> : <Ban />}
                                                    Révoquer
                                                </Button>
                                            ) : (
                                                <Button
                                                    variant="ghost"
                                                    size="sm"
                                                    onClick={() => handleDelete(k)}
                                                    disabled={enCours === k.id}
                                                    className="text-[var(--text-secondary)]"
                                                >
                                                    {enCours === k.id ? <Loader2 className="animate-spin" /> : <Trash2 />}
                                                    Supprimer
                                                </Button>
                                            )}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </CardContent>
        </Card>
    );
}
