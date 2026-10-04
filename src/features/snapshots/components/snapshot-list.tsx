"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
    Calendar,
    ChevronRight,
    FileDown,
    History,
    Loader2,
    PencilLine,
    Save,
    Trash2,
} from "lucide-react";
import { getSnapshots } from "../api/get-snapshots";
import { deleteSnapshot } from "../api/delete-snapshot";
import { useGridStore } from "@/features/grid/store/use-grid-store";
import { Button } from "@/components/ui/button";
import { StoreBadge } from "@/components/ui/badge";
import { EmptyState, ErrorState, Skeleton } from "@/components/ui/states";
import { confirmer, toast } from "@/components/ui/feedback";
import { fmtDecimal1, fmtEntier, fmtEur0 } from "@/lib/format";
import { couleurMarge } from "@/lib/marge";
import { isStaleServerActionError, STALE_ACTION_MESSAGE } from "@/lib/stale-action";

type Snapshot = Awaited<ReturnType<typeof getSnapshots>>[number];
/** Modifications enregistrées : codein → gamme avant / après. */
type Changements = Record<string, { before?: string | null; after: string }>;
interface Resume { totalCa?: number; tauxMargeGlobal?: number }

const fmtDateLongue = new Intl.DateTimeFormat("fr-FR", {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
});

function changementsDe(s: Snapshot): Changements {
    return (s.changes ?? {}) as Changements;
}

function resumeDe(s: Snapshot): Resume | null {
    return (s.summaryJson as Resume | null) ?? null;
}

function titreDe(s: Snapshot): string {
    return s.label ?? s.nomFournisseur ?? s.codeFournisseur;
}

/**
 * Onglet resté ouvert pendant un déploiement : les identifiants de Server
 * Action ont changé côté serveur. On propose le rechargement au lieu
 * d'afficher une erreur technique incompréhensible.
 */
async function proposerRechargement() {
    const ok = await confirmer({
        titre: "Page à recharger",
        message: STALE_ACTION_MESSAGE,
        libelleConfirmer: "Recharger la page",
    });
    if (ok) window.location.reload();
}

interface SnapshotListProps {
    type?: "snapshot" | "export";
}

export function SnapshotList({ type }: SnapshotListProps) {
    const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<{ perime: boolean; detail: string } | null>(null);
    const [isDeleting, setIsDeleting] = useState<number | null>(null);

    const restoreSnapshot = useGridStore((state) => state.restoreSnapshot);
    const router = useRouter();

    const estExport = type === "export";

    // Aucun setState avant le premier await : appelable depuis l'effet de montage.
    const fetchSnapshots = useCallback(async () => {
        try {
            const data = await getSnapshots(type);
            setSnapshots(data);
            setError(null);
        } catch (err) {
            setError({
                perime: isStaleServerActionError(err),
                detail: err instanceof Error ? err.message : String(err),
            });
        } finally {
            setLoading(false);
        }
    }, [type]);

    useEffect(() => { void fetchSnapshots(); }, [fetchSnapshots]);

    const reessayer = () => {
        setLoading(true);
        void fetchSnapshots();
    };

    const handleDelete = async (s: Snapshot) => {
        const ok = await confirmer({
            titre: estExport ? "Retirer cet export de l'historique ?" : "Supprimer cette session ?",
            message: estExport
                ? `« ${titreDe(s)} » sera retiré définitivement de votre historique. Le fichier Excel déjà téléchargé n'est pas concerné.`
                : `« ${titreDe(s)} » sera supprimée définitivement : vous ne pourrez plus la reprendre dans la Grille.`,
            libelleConfirmer: "Supprimer",
            danger: true,
        });
        if (!ok) return;
        setIsDeleting(s.id);
        try {
            const res = await deleteSnapshot(s.id);
            if (res.success) {
                setSnapshots((prev) => prev.filter((x) => x.id !== s.id));
                toast.succes(estExport ? "L'export a été retiré de votre historique." : "La session a été supprimée de votre historique.");
            } else {
                toast.erreur(`La suppression a échoué : ${res.error ?? "erreur inconnue"}.`);
            }
        } catch (err) {
            if (isStaleServerActionError(err)) void proposerRechargement();
            else toast.erreur("Une erreur est survenue pendant la suppression. Réessayez dans un instant.");
        } finally {
            setIsDeleting(null);
        }
    };

    const handleLoad = async (s: Snapshot) => {
        const ok = await confirmer({
            titre: "Reprendre dans la Grille ?",
            message: `Vos modifications en cours dans la Grille seront remplacées par celles de ${estExport ? "cet export" : "cette session"}.`,
            libelleConfirmer: "Reprendre dans la Grille",
        });
        if (!ok) return;
        const changes: Record<string, string> = {};
        Object.entries(changementsDe(s)).forEach(([codein, delta]) => {
            changes[codein] = delta.after;
        });
        restoreSnapshot(changes);
        const query = new URLSearchParams();
        if (s.codeFournisseur) query.set("fournisseur", s.codeFournisseur);
        if (s.magasin) query.set("magasin", s.magasin);
        router.push(`/grid?${query.toString()}`);
    };

    if (loading) {
        return (
            <div className="space-y-3" aria-busy="true" aria-label="Chargement de l'historique">
                {Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-24 w-full rounded-xl" />)}
            </div>
        );
    }

    if (error && snapshots.length === 0) {
        return error.perime ? (
            <ErrorState
                title="Page à recharger"
                description={STALE_ACTION_MESSAGE}
                action={<Button onClick={() => window.location.reload()}>Recharger la page</Button>}
            />
        ) : (
            <ErrorState
                title="L'historique n'a pas pu être chargé"
                detail={error.detail}
                action={<Button variant="outline" onClick={reessayer}>Réessayer</Button>}
            />
        );
    }

    if (snapshots.length === 0) {
        return estExport ? (
            <EmptyState
                icon={FileDown}
                title="Aucun export"
                description="Dans la Grille, chaque export des gammes modifiées (menu « Exporter », « Gammes modifiées seulement ») est noté ici, pour retrouver ce qui a été envoyé."
            />
        ) : (
            <EmptyState
                icon={History}
                title="Aucune session enregistrée"
                description="Dans la Grille, ouvrez le menu « Exporter » puis choisissez « Garder une copie dans l'Historique » : vos modifications de gammes seront enregistrées ici et vous pourrez les reprendre plus tard."
            />
        );
    }

    return (
        <ul className="grid gap-3">
            {snapshots.map((s) => {
                const nbModifs = Object.keys(changementsDe(s)).length;
                const resume = resumeDe(s);
                const taux = resume?.tauxMargeGlobal;
                const IconeType = estExport ? FileDown : Save;
                return (
                    <li
                        key={s.id}
                        className="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-xl border border-[var(--border)] bg-[var(--bg-surface)] p-4 shadow-[var(--shadow-sm)] transition-colors hover:border-[var(--accent-border)]"
                    >
                        <div className="flex min-w-0 flex-1 basis-72 items-start gap-4">
                            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-[var(--accent-border)] bg-[var(--accent-bg)]">
                                <IconeType className="h-5 w-5 text-[var(--accent)]" aria-hidden />
                            </div>
                            <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-center gap-2">
                                    <h3 className="truncate text-sm font-semibold text-[var(--text-primary)]">
                                        {titreDe(s)}
                                    </h3>
                                    <StoreBadge code={s.magasin} />
                                </div>
                                <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-[var(--text-secondary)]">
                                    {s.createdAt && (
                                        <span className="inline-flex items-center gap-1.5">
                                            <Calendar className="h-4 w-4 text-[var(--text-muted)]" aria-hidden />
                                            {fmtDateLongue.format(new Date(s.createdAt))}
                                        </span>
                                    )}
                                    <span className="inline-flex items-center gap-1.5">
                                        <PencilLine className="h-4 w-4 text-[var(--text-muted)]" aria-hidden />
                                        {fmtEntier(nbModifs)} changement{nbModifs > 1 ? "s" : ""} de gamme
                                    </span>
                                </div>
                            </div>
                        </div>

                        {resume && (
                            <dl className="flex items-center gap-6 md:border-l md:border-[var(--border)] md:pl-6">
                                <div>
                                    <dt className="text-xs font-medium text-[var(--text-muted)]">Chiffre d&apos;affaires</dt>
                                    <dd className="text-sm font-semibold tabular-nums text-[var(--text-primary)]">
                                        {fmtEur0(resume.totalCa ?? 0)}
                                    </dd>
                                </div>
                                {taux != null && Number.isFinite(taux) && (
                                    <div>
                                        <dt className="text-xs font-medium text-[var(--text-muted)]">Taux de marge</dt>
                                        <dd className="text-sm font-semibold tabular-nums" style={{ color: couleurMarge(taux) }}>
                                            {fmtDecimal1(taux)} %
                                        </dd>
                                    </div>
                                )}
                            </dl>
                        )}

                        <div className="flex items-center gap-2">
                            <Button onClick={() => handleLoad(s)}>
                                Reprendre dans la Grille
                                <ChevronRight />
                            </Button>
                            <Button
                                variant="outline"
                                size="icon"
                                onClick={() => handleDelete(s)}
                                disabled={isDeleting === s.id}
                                aria-label={estExport ? "Supprimer cet export" : "Supprimer cette session"}
                                title="Supprimer"
                                className="text-[var(--text-secondary)] hover:border-[var(--accent-error)] hover:bg-[var(--accent-error-bg)] hover:text-[var(--accent-error)]"
                            >
                                {isDeleting === s.id ? <Loader2 className="animate-spin" /> : <Trash2 />}
                            </Button>
                        </div>
                    </li>
                );
            })}
        </ul>
    );
}
