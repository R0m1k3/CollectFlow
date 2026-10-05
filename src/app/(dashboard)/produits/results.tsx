"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { PackageSearch, Loader2, RefreshCw, AlertTriangle, Database, Globe } from "lucide-react";
import { TrendSparkline } from "@/features/grid/components/network-charts";
import { computeNetworkTrend, NB_MAGASINS_RESEAU, type NetworkTrend } from "@/features/grid/lib/network-trend";
import type { ProduitRechercheResultat, ProduitRechercheRow } from "@/features/produits/types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { DataTable, type DataColumn } from "@/components/ui/data-table";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { Terme } from "@/components/ui/tooltip";
import { GLOSSAIRE } from "@/lib/glossaire";
import { fmtDecimal1, fmtEntier, fmtEur2 } from "@/lib/format";
import { couleurMarge } from "@/lib/marge";

/** Intervalle d'interrogation de l'état du job de recherche. */
const POLL_MS = 2000;

/** Réponse du job de recherche, telle que la renvoie l'API. */
interface JobRecherche {
    status: "idle" | "running" | "success" | "error";
    etape?: string;
    error?: string;
    result?: ProduitRechercheResultat;
}

/**
 * Lit une réponse HTTP en **ne présumant pas** qu'elle est du JSON.
 *
 * Un reverse proxy qui coupe la requête répond une page HTML : `res.json()`
 * échouait alors sur « Unexpected token '<' … is not valid JSON », message
 * inexploitable pour l'utilisateur. On traduit ici le statut HTTP.
 */
async function lireJson(res: Response): Promise<Record<string, unknown>> {
    const texte = await res.text();
    let data: Record<string, unknown> | null = null;
    try {
        data = texte ? (JSON.parse(texte) as Record<string, unknown>) : null;
    } catch {
        data = null;
    }
    if (data == null) {
        if (res.status === 504 || res.status === 408) {
            throw new Error("Le serveur a mis trop de temps à répondre (délai dépassé côté proxy). Réessayez.");
        }
        if (res.status === 502 || res.status === 503) {
            throw new Error("Application indisponible ou en cours de redémarrage. Réessayez dans un instant.");
        }
        if (res.status === 401 || res.status === 403) {
            throw new Error("Session expirée. Rechargez la page pour vous reconnecter.");
        }
        throw new Error(`Réponse inattendue du serveur (HTTP ${res.status}).`);
    }
    if (!res.ok) throw new Error(String(data.error ?? `HTTP ${res.status}`));
    return data;
}

/**
 * Les messages du serveur nomment l'outil source (Qlik) : l'utilisateur lit
 * « données du réseau », le message d'origine reste dans le détail technique.
 */
const mentionneOutil = (texte: string | null | undefined) => /qlik/i.test(texte ?? "");

function libelleEtape(etape: string | null): string {
    if (!etape || mentionneOutil(etape)) return "Recherche dans les données du réseau…";
    return etape;
}

/** Bandeau d'avertissement : explication en clair, détail technique replié. */
function Avertissement({ children, detail }: { children: ReactNode; detail?: string | null }) {
    return (
        <div
            role="status"
            className="flex items-start gap-2.5 rounded-xl border border-[var(--accent-warning)]/40 bg-[var(--accent-warning-bg)] px-4 py-3 text-sm text-[var(--text-primary)]"
        >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--accent-warning)]" aria-hidden />
            <div className="min-w-0">
                {children}
                {detail && (
                    <details className="mt-1 text-xs text-[var(--text-secondary)]">
                        <summary className="cursor-pointer">Détail technique</summary>
                        <p className="mt-1 break-words">{detail}</p>
                    </details>
                )}
            </div>
        </div>
    );
}

/**
 * Résultats de recherche produit.
 *
 * La recherche interroge **Qlik d'abord** et peut dépasser la minute : elle est
 * lancée par un `POST` qui rend la main tout de suite, puis on interroge son
 * avancement toutes les 2 s. Une requête HTTP maintenue pendant toute
 * l'extraction se faisait couper par le reverse proxy.
 */
export function ProduitResults({ query }: { query: string }) {
    // `relance` mémorise la dernière demande explicite de rafraîchissement, pour
    // ne forcer le contournement du cache serveur que sur CE terme-là.
    const [relance, setRelance] = useState<{ n: number; q: string }>({ n: 0, q: "" });
    const [resultat, setResultat] = useState<{
        cle: string;
        data: ProduitRechercheResultat | null;
        error: string | null;
        etape: string | null;
    } | null>(null);

    const force = relance.n > 0 && relance.q === query;
    const cle = `${query}|${force ? relance.n : 0}`;
    const tropCourt = query.trim().length < 3;

    // L'état de chargement est **dérivé** (résultat pas encore aligné sur la
    // requête courante) plutôt que posé en début d'effet : appeler setState
    // synchronement dans un effet provoque un rendu en cascade.
    const enAttente = resultat?.cle !== cle || (!resultat?.data && !resultat?.error);
    const loading = !tropCourt && enAttente;

    useEffect(() => {
        if (tropCourt) return;
        let annule = false;
        let timer: ReturnType<typeof setTimeout> | undefined;

        const url = (methode: "POST" | "GET") =>
            `/api/produits/search?q=${encodeURIComponent(query)}${methode === "POST" && force ? "&force=1" : ""}`;

        const appliquer = (job: JobRecherche): boolean => {
            if (annule) return true;
            if (job.status === "success" && job.result) {
                setResultat({ cle, data: job.result, error: null, etape: null });
                return true;
            }
            if (job.status === "error") {
                setResultat({ cle, data: null, error: job.error ?? "La recherche a échoué.", etape: null });
                return true;
            }
            // `idle` = le process a redémarré et a perdu le job : on relance.
            setResultat({ cle, data: null, error: null, etape: job.etape ?? null });
            return false;
        };

        const poll = async () => {
            try {
                const job = (await lireJson(await fetch(url("GET"), { cache: "no-store" }))) as unknown as JobRecherche;
                if (job.status === "idle") {
                    await demarrer();
                    return;
                }
                if (!appliquer(job) && !annule) timer = setTimeout(() => void poll(), POLL_MS);
            } catch (e) {
                if (!annule) setResultat({ cle, data: null, error: e instanceof Error ? e.message : String(e), etape: null });
            }
        };

        const demarrer = async () => {
            try {
                const job = (await lireJson(
                    await fetch(url("POST"), { method: "POST", cache: "no-store" }),
                )) as unknown as JobRecherche;
                if (!appliquer(job) && !annule) timer = setTimeout(() => void poll(), POLL_MS);
            } catch (e) {
                if (!annule) setResultat({ cle, data: null, error: e instanceof Error ? e.message : String(e), etape: null });
            }
        };

        void demarrer();
        return () => { annule = true; if (timer) clearTimeout(timer); };
    }, [cle, query, force, tropCourt]);

    const relancer = () => setRelance((r) => ({ n: r.n + 1, q: query }));
    const data = resultat?.cle === cle ? resultat.data : null;
    const error = resultat?.cle === cle ? resultat.error : null;
    const etape = resultat?.cle === cle ? resultat.etape : null;

    if (!query) {
        return (
            <EmptyState
                icon={PackageSearch}
                title="Recherchez un produit"
                description={
                    <>
                        Saisissez le nom d&apos;un produit (ex. « poêle 28 ») ou son code centrale
                        (ex. « 10000167303 »). Vous verrez ses ventes dans les {NB_MAGASINS_RESEAU} magasins
                        du réseau, puis chez nous s&apos;il est dans notre catalogue.
                    </>
                }
            />
        );
    }

    if (loading) {
        return (
            <div
                aria-busy="true"
                className="flex flex-col items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--bg-surface)] px-6 py-12 text-center"
            >
                <Loader2 className="h-7 w-7 animate-spin text-[var(--accent)]" aria-hidden />
                <p className="text-base font-semibold text-[var(--text-primary)]">{libelleEtape(etape)}</p>
                <p className="max-w-lg text-sm text-[var(--text-secondary)]">
                    Recherche des produits puis de leurs ventes sur les 12 derniers mois.
                    Cela peut prendre plus d&apos;une minute : vous pouvez laisser la page ouverte.
                </p>
            </div>
        );
    }

    if (error) {
        return (
            <ErrorState
                title="La recherche a échoué"
                description={
                    mentionneOutil(error)
                        ? "Les données du réseau n'ont pas répondu. Réessayez dans un instant ; si la recherche est très large, ajoutez un mot plus précis."
                        : error
                }
                detail={mentionneOutil(error) ? error : undefined}
                action={
                    <Button variant="outline" onClick={relancer}>
                        <RefreshCw /> Réessayer
                    </Button>
                }
            />
        );
    }

    if (!data) return null;

    const { rows, source, qlikError, tronque, locauxHorsReseau, dureeMs } = data;

    return (
        <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
                    {source === "qlik"
                        ? <Globe className="h-4 w-4 text-[var(--accent)]" aria-hidden />
                        : <Database className="h-4 w-4 text-[var(--text-muted)]" aria-hidden />}
                    <span>
                        <span className="font-semibold text-[var(--text-primary)]">{fmtEntier(rows.length)}</span>{" "}
                        produit{rows.length > 1 ? "s" : ""} trouvé{rows.length > 1 ? "s" : ""}
                        {source === "qlik" ? " dans le réseau" : " dans notre catalogue"}
                        {tronque && " (liste limitée : précisez la recherche pour tout voir)"}
                        <span className="text-[var(--text-muted)]"> · recherche en {fmtDecimal1(dureeMs / 1000)} s</span>
                    </span>
                </p>
                <Button
                    variant="outline"
                    size="sm"
                    onClick={relancer}
                    title="Interroger à nouveau les données du réseau, sans réutiliser le dernier résultat"
                >
                    <RefreshCw /> Relancer la recherche
                </Button>
            </div>

            {source === "db" && (
                <Avertissement detail={qlikError}>
                    Les données du réseau n&apos;ont pas pu être interrogées : seuls les produits de notre catalogue
                    sont affichés, avec les chiffres du réseau de la dernière mise à jour.
                </Avertissement>
            )}

            {source === "qlik" && qlikError && (
                <Avertissement detail={qlikError}>
                    {rows.length === 0
                        ? "La recherche n'a pas pu être appliquée aux données du réseau. Essayez un terme plus précis (deux mots, ou le code centrale)."
                        : "Produits trouvés, mais leurs ventes dans le réseau n'ont pas pu être chargées."}
                </Avertissement>
            )}

            {rows.length === 0 ? (
                <EmptyState
                    title={<>Aucun produit ne correspond à « {query} »</>}
                    description="Vérifiez l'orthographe, essayez un mot plus court ou le code centrale du produit."
                />
            ) : (
                <>
                    <ResultTable rows={rows} query={query} />
                    <p className="text-[13px] text-[var(--text-secondary)]">
                        Chiffres des magasins du <Terme id="reseau">réseau</Terme> sur les 12 derniers mois
                        (mois en cours exclu). Cliquez sur un produit pour ouvrir sa fiche.
                    </p>
                </>
            )}

            {locauxHorsReseau.length > 0 && (
                <details className="rounded-xl border border-[var(--border)] bg-[var(--bg-surface)]">
                    <summary className="cursor-pointer px-4 py-3 text-sm text-[var(--text-secondary)]">
                        {fmtEntier(locauxHorsReseau.length)} produit{locauxHorsReseau.length > 1 ? "s" : ""} de notre catalogue
                        sans ventes connues dans le réseau (pas de code centrale, ou pas vendu par le réseau)
                    </summary>
                    <ul className="space-y-1.5 px-4 pb-4">
                        {locauxHorsReseau.slice(0, 30).map((l) => (
                            <li key={l.codein} className="text-sm">
                                <Link
                                    href={`/produits?codein=${encodeURIComponent(l.codein)}&q=${encodeURIComponent(query)}`}
                                    className="font-medium text-[var(--accent)] hover:underline"
                                >
                                    {l.libelle1 || l.codein}
                                </Link>
                                <span className="text-[var(--text-muted)]">
                                    {" · "}{l.fournisseur}{" · "}code article <span className="font-mono">{l.codein}</span>
                                </span>
                            </li>
                        ))}
                    </ul>
                </details>
            )}
        </div>
    );
}

// ─── Tableau des résultats ──────────────────────────────────────────────────

type Ligne = ProduitRechercheRow & { trend: NetworkTrend };

const rechercherDans = (r: Ligne) => [r.libelle, r.fournisseur, r.codeCentrale, r.codein, r.nomenclature];

function ResultTable({ rows, query }: { rows: ProduitRechercheRow[]; query: string }) {
    // Tendance calculée une fois par ligne (et non à chaque tri ou rendu).
    const lignes = useMemo<Ligne[]>(
        () => rows.map((r) => ({ ...r, trend: computeNetworkTrend(r.qteByMonth, r.nbMagByMonth) })),
        [rows],
    );

    const colonnes = useMemo<DataColumn<Ligne>[]>(() => [
        {
            id: "produit",
            header: "Produit",
            sortValue: (r) => r.libelle,
            className: "max-w-[320px]",
            cell: (r) => {
                const href = r.codein
                    ? `/produits?codein=${encodeURIComponent(r.codein)}&q=${encodeURIComponent(query)}`
                    : `/produits?cc=${encodeURIComponent(r.codeCentrale)}&q=${encodeURIComponent(query)}`;
                return (
                    <>
                        <Link href={href} className="font-medium text-[var(--accent)] hover:underline">
                            {r.libelle || "—"}
                        </Link>
                        {r.nomenclature && (
                            <div className="truncate text-xs text-[var(--text-muted)]" title={r.nomenclature}>{r.nomenclature}</div>
                        )}
                    </>
                );
            },
        },
        {
            id: "fournisseur",
            header: "Fournisseur",
            sortValue: (r) => r.fournisseur,
            cell: (r) => <span className="text-[var(--text-secondary)]">{r.fournisseur || "—"}</span>,
        },
        {
            id: "codeCentrale",
            header: "Code centrale",
            hint: GLOSSAIRE.codeCentrale.definition,
            cell: (r) => <span className="font-mono text-[13px] text-[var(--text-secondary)]">{r.codeCentrale}</span>,
        },
        {
            id: "magasins",
            header: "Magasins vendeurs",
            hint: GLOSSAIRE.presenceReseau.definition,
            align: "right",
            sortValue: (r) => r.nbMagasinsReseau,
            cell: (r) => (
                <>
                    {fmtEntier(r.nbMagasinsReseau)}
                    <span className="ml-1 text-xs text-[var(--text-muted)]">({fmtEntier(r.tauxPresence * 100)} %)</span>
                </>
            ),
        },
        {
            id: "qteReseau",
            header: "Quantité vendue",
            hint: "Quantité vendue par l'ensemble des magasins du réseau sur les 12 derniers mois.",
            align: "right",
            sortValue: (r) => r.qteReseau,
            cell: (r) => <span className="font-semibold">{fmtEntier(r.qteReseau)}</span>,
        },
        {
            id: "qteParMagasin",
            header: "Quantité par magasin",
            hint: "Quantité moyenne vendue sur 12 mois par un magasin du réseau qui a ce produit.",
            align: "right",
            sortValue: (r) => r.qteParMagasinReseau,
            cell: (r) => fmtDecimal1(r.qteParMagasinReseau),
        },
        {
            id: "prixMoyen",
            header: "Prix moyen",
            hint: "Prix de vente moyen constaté dans le réseau (chiffre d'affaires divisé par la quantité).",
            align: "right",
            sortValue: (r) => r.prixMoyenReseau,
            cell: (r) => (r.prixMoyenReseau != null ? fmtEur2(r.prixMoyenReseau) : "—"),
        },
        {
            id: "caParMagasin",
            header: "CA par magasin",
            hint: GLOSSAIRE.caParMagasin.definition,
            align: "right",
            sortValue: (r) => (r.caParMagasinReseau > 0 ? r.caParMagasinReseau : null),
            cell: (r) => (r.caParMagasinReseau > 0 ? fmtEur2(r.caParMagasinReseau) : "—"),
        },
        {
            id: "marge",
            header: "Taux de marge",
            hint: GLOSSAIRE.marge.definition,
            align: "right",
            sortValue: (r) => r.margePctReseau,
            cell: (r) =>
                r.margePctReseau != null ? (
                    <span className="font-medium" style={{ color: couleurMarge(r.margePctReseau) }}>
                        {fmtDecimal1(r.margePctReseau)} %
                    </span>
                ) : "—",
        },
        {
            id: "tendance",
            header: "Tendance",
            hint: "Ventes par magasin des 4 derniers mois comparées aux 4 premiers mois de la période de 12 mois.",
            align: "center",
            sortValue: (r) => (r.trend.hasData ? r.trend.pct : null),
            cell: (r) => (r.trend.hasData ? <TrendSparkline trend={r.trend} /> : <span className="text-[var(--text-muted)]">—</span>),
        },
        {
            id: "nous",
            header: "Chez nous",
            hint: "Notre stock (tous nos magasins) si le produit est dans notre catalogue.",
            align: "right",
            sortValue: (r) => (r.codein ? (r.stockLocal ?? 0) : null),
            cell: (r) =>
                r.codein ? (
                    <span className="text-[var(--text-secondary)]" title={`Code article ${r.codein}`}>
                        Stock {fmtEntier(r.stockLocal ?? 0)}
                    </span>
                ) : (
                    <Badge title="Le réseau vend ce produit, mais il n'est pas dans notre catalogue">Non référencé</Badge>
                ),
        },
    ], [query]);

    return (
        <DataTable
            rows={lignes}
            columns={colonnes}
            rowKey={(r) => r.codeCentrale}
            searchIn={rechercherDans}
            searchPlaceholder="Filtrer les résultats…"
            pageSize={50}
            unite={lignes.length > 1 ? "produits" : "produit"}
            emptyTitle="Aucun produit"
        />
    );
}
