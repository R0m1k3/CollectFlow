"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
    ArrowLeft, Package, Warehouse, ShoppingCart, Globe, Layers, Truck, Scale,
    RefreshCw, Loader2, CheckCircle, AlertCircle, WifiOff, LayoutGrid, Info,
    type LucideIcon,
} from "lucide-react";
import { HeatmapCell } from "@/features/grid/components/heatmap-cell";
import { NetworkLineChart, DualLineChart, TrendSparkline } from "@/features/grid/components/network-charts";
import {
    computeNetworkTrend, computeStoresSeries, trendLabel, NB_MAGASINS_RESEAU, type NetworkTrend,
} from "@/features/grid/lib/network-trend";
import { formatMonthLabel, formatDate, ffMonthToQlik } from "@/features/grid/lib/months";
import { useQlikSyncJob } from "@/features/qlik-sync/use-qlik-sync-job";
import { computeComparatif, indiceVerdict, normalizeMargePct } from "@/features/produits/lib/compare-reseau";
import type { ProduitFiche } from "@/features/produits/types";
import { Card, CardContent, CardHeader, Field } from "@/components/ui/card";
import { StatCard } from "@/components/ui/stat-card";
import { Badge, GammeBadge, StoreBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/tabs";
import { EmptyState } from "@/components/ui/states";
import { Terme, Tooltip } from "@/components/ui/tooltip";
import { toast } from "@/components/ui/feedback";
import { CODE_TOUS_MAGASINS, LIBELLE_TOUS_MAGASINS, nomMagasin } from "@/lib/magasins";
import { fmtDecimal1, fmtEntier, fmtEur0, fmtEur2 } from "@/lib/format";
import { couleurMarge } from "@/lib/marge";
import { cn } from "@/lib/utils";
import { OpportunitesFamille } from "./opportunites";

// ─── Briques de présentation ─────────────────────────────────────────────────

/** Bloc de la fiche : carte du thème, titre avec icône, actions à droite. */
function Bloc({ titre, icone: Icone, description, actions, children }: {
    titre: ReactNode;
    icone: LucideIcon;
    description?: ReactNode;
    actions?: ReactNode;
    children: ReactNode;
}) {
    return (
        <Card>
            <CardHeader
                title={
                    <span className="inline-flex items-center gap-2">
                        <Icone className="h-4 w-4 shrink-0 text-[var(--accent)]" aria-hidden />
                        {titre}
                    </span>
                }
                description={description}
                actions={actions}
            />
            <CardContent>{children}</CardContent>
        </Card>
    );
}

/** Libellé avec une explication libre au survol (comme `<Terme>`, hors glossaire). */
function Aide({ texte, children }: { texte: ReactNode; children: ReactNode }) {
    return (
        <Tooltip content={texte}>
            <span tabIndex={0} className="inline-flex cursor-help items-center gap-1 outline-none">
                {children}
                <Info className="h-3.5 w-3.5 shrink-0 opacity-60" aria-hidden />
            </span>
        </Tooltip>
    );
}

/** Sous-titre d'une partie de bloc. */
function SousTitre({ titre, description }: { titre: ReactNode; description?: ReactNode }) {
    return (
        <div className="mb-2">
            <h3 className="text-sm font-semibold text-[var(--text-primary)]">{titre}</h3>
            {description && <p className="mt-0.5 text-[13px] text-[var(--text-secondary)]">{description}</p>}
        </div>
    );
}

/** Classes des petits tableaux mensuels (en-tête et première colonne figée). */
const TH_COL = "whitespace-nowrap px-2 py-2 text-right text-[13px] font-semibold text-[var(--text-secondary)]";
const TH_COIN = "sticky left-0 z-[1] whitespace-nowrap bg-[var(--bg-elevated)] px-3 py-2 text-left text-[13px] font-semibold text-[var(--text-secondary)]";
const TH_LIGNE = "sticky left-0 z-[1] whitespace-nowrap bg-[var(--bg-surface)] px-3 py-2 text-left font-medium text-[var(--text-secondary)]";
const TD = "whitespace-nowrap px-2 py-2 text-right tabular-nums text-[var(--text-primary)]";

/** Couleur de la tendance, prise dans le thème (lisible en clair comme en sombre). */
const COULEUR_TENDANCE: Record<NetworkTrend["direction"], string> = {
    up: "var(--accent-success)",
    down: "var(--accent-error)",
    flat: "var(--text-secondary)",
};

/** Couleur du verdict de l'indice de performance, prise dans le thème. */
const COULEUR_VERDICT: Record<string, string> = {
    "Forte surperformance": "var(--accent-success)",
    Surperformance: "var(--accent-success)",
    "Dans la moyenne réseau": "var(--text-primary)",
    "Sous-performance": "var(--accent-warning)",
    "Forte sous-performance": "var(--accent-error)",
};

/** Période Qlik `"2025-09_2026-08"` → « de septembre 2025 à août 2026 ». */
function libellePeriode(periode: string | null | undefined): string {
    const m = /^(\d{4})-(\d{2})_(\d{4})-(\d{2})$/.exec(periode ?? "");
    if (!m) return periode ? `période ${periode}` : "12 derniers mois";
    const mois = (annee: string, num: string) =>
        new Date(Number(annee), Number(num) - 1, 1).toLocaleDateString("fr-FR", { month: "long", year: "numeric" });
    return `de ${mois(m[1], m[2])} à ${mois(m[3], m[4])}`;
}

// ─── Détail mensuel réseau ───────────────────────────────────────────────────

/** Les mesures Qlik d'un mois, telles que stockées dans `metricsByMonth`. */
type MoisReseau = { qte: number; ca?: number; nbMag?: number; caMag?: number; margePct?: number };

/**
 * Lignes du tableau « Détail mensuel réseau ». Deux d'entre elles sont dérivées
 * (qté/magasin, prix moyen) : le cube Qlik ne les renvoie pas, mais ce sont les
 * chiffres qu'on lit réellement pour arbitrer.
 */
const LIGNES_MENSUELLES_RESEAU: Array<{
    label: string;
    get: (v: MoisReseau) => number | undefined;
    fmt: (n: number) => string;
}> = [
    { label: "Quantité vendue", get: (v) => v.qte, fmt: fmtEntier },
    { label: "Magasins vendeurs", get: (v) => v.nbMag, fmt: fmtEntier },
    { label: "Quantité par magasin", get: (v) => (v.nbMag && v.nbMag > 0 ? v.qte / v.nbMag : undefined), fmt: fmtDecimal1 },
    { label: "Chiffre d'affaires (€)", get: (v) => v.ca, fmt: fmtEntier },
    { label: "Prix moyen", get: (v) => (v.ca != null && v.qte > 0 ? v.ca / v.qte : undefined), fmt: fmtEur2 },
    { label: "Taux de marge", get: (v) => normalizeMargePct(v.margePct) ?? undefined, fmt: (n) => `${fmtDecimal1(n)} %` },
];

// ─── Mise à jour des données du réseau pour un seul code centrale ───────────

function SyncProduitButton({ codeCentrale }: { codeCentrale: string }) {
    const router = useRouter();
    const { status, message, start } = useQlikSyncJob({
        target: { mode: "produit", codeCentrale },
        onSuccess: () => router.refresh(),
    });

    // Un échec n'est notifié que s'il suit un clic ici : la reprise d'un ancien
    // job au chargement de la fiche ne doit pas afficher de message d'erreur.
    const demandeRef = useRef(false);
    useEffect(() => {
        if (status === "error" && demandeRef.current) {
            demandeRef.current = false;
            toast.erreur(`La mise à jour des données du réseau a échoué. ${message}`.trim());
        } else if (status === "success") {
            demandeRef.current = false;
        }
    }, [status, message]);

    const lancer = () => {
        demandeRef.current = true;
        void start();
    };

    return (
        <div className="flex flex-wrap items-center justify-end gap-2">
            <span role="status" aria-live="polite" className="text-[13px]">
                {status === "running" && (
                    <span className="text-[var(--text-secondary)]">Mise à jour en cours, quelques secondes…</span>
                )}
                {status === "success" && (
                    <span className="inline-flex items-center gap-1 text-[var(--accent-success)]">
                        <CheckCircle className="h-4 w-4" aria-hidden /> Données du réseau mises à jour
                    </span>
                )}
                {status === "error" && (
                    <Tooltip content={message || "Erreur inconnue"}>
                        <span tabIndex={0} className="inline-flex cursor-help items-center gap-1 text-[var(--accent-error)] outline-none">
                            <AlertCircle className="h-4 w-4" aria-hidden /> La mise à jour a échoué
                        </span>
                    </Tooltip>
                )}
            </span>
            <Button
                variant="outline"
                size="sm"
                onClick={lancer}
                disabled={status === "running"}
                title="Recharger les ventes du réseau pour ce seul produit (quelques secondes)"
            >
                {status === "running" ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                {status === "running" ? "Mise à jour…" : "Mettre à jour les données du réseau"}
            </Button>
        </div>
    );
}

// ─── Fiche ───────────────────────────────────────────────────────────────────

export function ProduitFicheView({ fiche, backQuery }: { fiche: ProduitFiche; backQuery: string }) {
    const { detail, codeCentrale, libelleReseau, fournisseurReseau, fournisseurs, stock, commandesEnCours, gammes, months, reseau } = fiche;
    const [magasin, setMagasin] = useState<string>(CODE_TOUS_MAGASINS);

    const sitesDisponibles = useMemo(() => {
        const sites = new Set<string>([...Object.keys(fiche.mensuelParSite), ...stock.map((s) => s.site)]);
        return [...sites].filter(Boolean).sort();
    }, [fiche.mensuelParSite, stock]);

    // Série affichée selon le magasin sélectionné.
    const tous = magasin === CODE_TOUS_MAGASINS;
    const serie = tous ? fiche.mensuelTotal : (fiche.mensuelParSite[magasin] ?? {});
    const totauxAffiches = tous ? fiche.totaux : (fiche.totauxParSite[magasin] ?? { qte: 0, ca: 0, marge: 0, tauxMarge: 0 });

    /** Magasins vendeurs par mois — dénominateur de la tendance ET 3e bande du graphique. */
    const nbMagByMonth = useMemo(() => {
        const detailMensuel = reseau?.metricsByMonth;
        if (!detailMensuel) return null;
        const parMois: Record<string, number> = {};
        for (const [mois, mesures] of Object.entries(detailMensuel)) {
            // Mois présent sans `nbMag` = mois extrait sans vente = zéro magasin
            // (cf. get-product-rows.ts) : sinon la série est amputée et la courbe
            // disparaît sur les anciens caches.
            const nb = Number(mesures?.nbMag);
            parMois[mois] = Number.isFinite(nb) ? nb : 0;
        }
        return parMois;
    }, [reseau]);
    const trend = useMemo(
        () => computeNetworkTrend(reseau?.qteByMonth ?? null, nbMagByMonth),
        [reseau, nbMagByMonth],
    );
    const magasinsParMois = useMemo(() => computeStoresSeries(nbMagByMonth), [nbMagByMonth]);
    const comparatif = useMemo(() => computeComparatif(fiche), [fiche]);
    const verdict = indiceVerdict(comparatif.indiceQte);

    const fournisseurPrincipal = fournisseurs.find((f) => f.principal) ?? fournisseurs[0];
    /** Nom de fournisseur à afficher : notre catalogue d'abord, sinon celui du réseau. */
    const fournisseurAffiche = fournisseurPrincipal?.nomfou || fournisseurReseau || null;
    const titre = detail?.libelle1 || libelleReseau || codeCentrale || "Sans libellé";

    // Indicateurs réseau dérivés (le cache ne stocke que les mesures brutes Qlik).
    const qteParMagasinReseau = reseau && reseau.nbMagasinsReseau > 0 ? reseau.qteReseau / reseau.nbMagasinsReseau : null;
    const prixMoyenReseau = reseau && reseau.qteReseau > 0 ? reseau.caReseau / reseau.qteReseau : null;
    const margeReseau = normalizeMargePct(reseau?.margePctReseau);

    const lienGrille = (codefou: string) => `/grid?fournisseur=${encodeURIComponent(codefou)}&magasin=TOTAL`;

    return (
        <div className="space-y-6">
            {/* En-tête de la fiche */}
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                    <Link
                        href={backQuery ? `/produits?q=${encodeURIComponent(backQuery)}` : "/produits"}
                        className="mb-2 inline-flex items-center gap-1.5 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:underline"
                    >
                        <ArrowLeft className="h-4 w-4" aria-hidden />
                        {backQuery ? "Retour aux résultats" : "Retour à la recherche"}
                    </Link>
                    <h2 className="text-xl font-semibold text-[var(--text-primary)]">{titre}</h2>
                    <p className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-[var(--text-secondary)]">
                        {detail && (
                            <span>Code article <span className="font-mono text-[var(--text-primary)]">{detail.codein}</span></span>
                        )}
                        {codeCentrale && (
                            <span>Code centrale <span className="font-mono text-[var(--text-primary)]">{codeCentrale}</span></span>
                        )}
                        {fournisseurAffiche && <span>Fournisseur : {fournisseurAffiche}</span>}
                    </p>
                </div>
                {fournisseurPrincipal?.codefou && (
                    <Button asChild variant="outline">
                        <Link href={lienGrille(fournisseurPrincipal.codefou)} title="Ouvrir la révision d'assortiment de ce fournisseur">
                            <LayoutGrid /> Réviser l&apos;assortiment du fournisseur
                        </Link>
                    </Button>
                )}
            </div>

            {!detail && (
                <div
                    role="note"
                    className="flex items-start gap-3 rounded-xl border border-[var(--accent-border)] bg-[var(--accent-bg)] px-4 py-3 text-sm text-[var(--text-primary)]"
                >
                    <Info className="mt-0.5 h-4 w-4 shrink-0 text-[var(--accent)]" aria-hidden />
                    <div>
                        Ce produit est vendu dans le réseau mais <strong>n&apos;est pas dans notre catalogue</strong>.
                        <div className="mt-0.5 text-[var(--text-secondary)]">
                            Seules les données du réseau sont disponibles : pas de stock, de ventes ni de gamme chez nous.
                        </div>
                    </div>
                </div>
            )}

            {/* ─── Réseau — la donnée qui motive la recherche ─────────────── */}
            <Bloc
                titre={<>Ventes dans le <Terme id="reseau">réseau</Terme> · 12 derniers mois</>}
                icone={Globe}
                actions={codeCentrale ? <SyncProduitButton codeCentrale={codeCentrale} /> : undefined}
            >
                {!codeCentrale ? (
                    <p className="text-sm text-[var(--text-secondary)]">
                        Ce produit n&apos;a pas de <Terme id="codeCentrale">code centrale</Terme> : il n&apos;est pas suivi
                        par la centrale d&apos;achat, il n&apos;y a donc pas de données du réseau.
                    </p>
                ) : !reseau ? (
                    <EmptyState
                        icon={WifiOff}
                        className="py-8"
                        title="Pas encore de données du réseau pour ce produit"
                        description="Cliquez sur « Mettre à jour les données du réseau » ci-dessus : la mise à jour ne porte que sur ce produit et prend quelques secondes."
                    />
                ) : (
                    <>
                        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                            <StatCard
                                label={<Terme id="presenceReseau" />}
                                value={fmtEntier(reseau.nbMagasinsReseau)}
                                hint={`sur ${NB_MAGASINS_RESEAU}, soit ${fmtEntier((reseau.nbMagasinsReseau / NB_MAGASINS_RESEAU) * 100)} % du réseau`}
                            />
                            <StatCard label="Quantité vendue" value={fmtEntier(reseau.qteReseau)} hint="par tout le réseau" />
                            <StatCard
                                label="Quantité par magasin"
                                value={qteParMagasinReseau != null ? fmtDecimal1(qteParMagasinReseau) : "—"}
                                hint="par magasin qui le vend"
                            />
                            <StatCard
                                label="Prix de vente moyen"
                                value={prixMoyenReseau != null ? fmtEur2(prixMoyenReseau) : "—"}
                                hint="chiffre d'affaires ÷ quantité"
                            />
                            <StatCard label="Chiffre d'affaires" value={fmtEur0(reseau.caReseau)} hint="de tout le réseau" />
                            <StatCard label={<Terme id="caParMagasin" />} value={fmtEur0(reseau.caParMagasinReseau)} />
                            <StatCard
                                label={<Terme id="marge">Taux de marge</Terme>}
                                value={
                                    margeReseau != null
                                        ? <span style={{ color: couleurMarge(margeReseau) }}>{fmtDecimal1(margeReseau)} %</span>
                                        : "—"
                                }
                            />
                            <StatCard
                                label={
                                    <Aide texte="Ventes par magasin des 4 derniers mois comparées à celles des 4 premiers mois de la période.">
                                        Tendance
                                    </Aide>
                                }
                                value={
                                    trend.pct != null
                                        ? (
                                            <span style={{ color: COULEUR_TENDANCE[trend.direction] }}>
                                                {trend.pct >= 0 ? "+" : ""}{fmtEntier(trend.pct * 100)} %
                                            </span>
                                        )
                                        : "—"
                                }
                                hint={trendLabel(trend.pct, trend.nouveau)}
                            />
                        </div>

                        <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
                            <Field label="Libellé dans le réseau">{libelleReseau || "—"}</Field>
                            <Field label="Fournisseur dans le réseau">{fournisseurReseau || "—"}</Field>
                        </div>

                        <p className="mt-4 text-[13px] text-[var(--text-muted)]">
                            Ventes {libellePeriode(reseau.periode)} · données du réseau mises à jour le {formatDate(reseau.fetchedAt)} ·
                            {" "}le mois en cours n&apos;est pas compté (incomplet).
                        </p>

                        {trend.hasData && (
                            <section className="mt-6">
                                <SousTitre
                                    titre="Évolution mois par mois"
                                    description="La quantité vendue par magasin d'abord ; les volumes et le nombre de magasins vendeurs pour le contexte."
                                />
                                <NetworkLineChart
                                    labels={trend.labels}
                                    values={trend.values}
                                    stores={magasinsParMois?.values}
                                    perStore={trend.perStore}
                                />
                            </section>
                        )}

                        {/* Détail mensuel complet (CA, marge, magasins) si disponible */}
                        {reseau.metricsByMonth && Object.keys(reseau.metricsByMonth).length > 0 && (
                            <section className="mt-6">
                                <SousTitre titre="Détail mensuel dans le réseau" />
                                <div className="overflow-x-auto rounded-lg border border-[var(--border)]">
                                    <table className="w-full border-collapse text-sm">
                                        <thead className="bg-[var(--bg-elevated)]">
                                            <tr>
                                                <th scope="col" className={TH_COIN}>Mesure</th>
                                                {months.map((m) => (
                                                    <th key={m} scope="col" className={TH_COL}>{formatMonthLabel(m)}</th>
                                                ))}
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {LIGNES_MENSUELLES_RESEAU.map((row) => (
                                                <tr key={row.label} className="border-t border-[var(--border)]">
                                                    <th scope="row" className={TH_LIGNE}>{row.label}</th>
                                                    {months.map((m) => {
                                                        const cell = reseau.metricsByMonth?.[ffMonthToQlik(m)];
                                                        const v = cell ? row.get(cell) : undefined;
                                                        return (
                                                            <td key={m} className={TD}>
                                                                {v != null ? row.fmt(v) : <span className="text-[var(--text-muted)]">—</span>}
                                                            </td>
                                                        );
                                                    })}
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                                <p className="mt-2 text-[13px] text-[var(--text-muted)]">
                                    Pour certains mois, les données du réseau ne donnent que la quantité : le chiffre
                                    d&apos;affaires et la marge y sont alors absents.{" "}
                                    <Aide texte="Détail technique : ces mois proviennent de la mesure Qlik « Quantité COMP », qui ne porte que la quantité.">
                                        Pourquoi ?
                                    </Aide>
                                </p>
                            </section>
                        )}
                    </>
                )}
            </Bloc>

            {/* ─── Fournisseur ─────────────────────────────────────────────── */}
            <Bloc titre="Fournisseur" icone={Truck}>
                {fournisseurs.length === 0 ? (
                    <p className="text-sm text-[var(--text-secondary)]">
                        {fournisseurReseau
                            ? <>Aucun fournisseur dans notre catalogue. Dans les données du réseau, le fournisseur est <strong className="text-[var(--text-primary)]">{fournisseurReseau}</strong>.</>
                            : "Aucun fournisseur connu pour ce produit."}
                    </p>
                ) : (
                    <div className="space-y-2">
                        <ul className="space-y-2">
                            {fournisseurs.map((f) => (
                                <li
                                    key={f.codefou}
                                    className={cn(
                                        "flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-3",
                                        f.principal
                                            ? "border-[var(--accent-border)] bg-[var(--accent-bg)]"
                                            : "border-[var(--border)] bg-[var(--bg-elevated)]",
                                    )}
                                >
                                    <div className="min-w-0">
                                        <div className="flex flex-wrap items-center gap-2 text-sm font-semibold text-[var(--text-primary)]">
                                            {f.nomfou}
                                            {f.principal && <Badge ton="accent">Fournisseur principal</Badge>}
                                        </div>
                                        <div className="mt-0.5 text-xs text-[var(--text-muted)]">
                                            Code fournisseur <span className="font-mono">{f.codefou}</span>
                                        </div>
                                    </div>
                                    <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm text-[var(--text-secondary)]">
                                        <span>Référence : <span className="font-mono text-[var(--text-primary)]">{f.reference || "—"}</span></span>
                                        <span className="inline-flex items-center gap-1">
                                            <Terme id="pcb" /> :
                                            <span className="tabular-nums text-[var(--text-primary)]">{f.pcb != null ? fmtEntier(f.pcb) : "—"}</span>
                                        </span>
                                        <Link
                                            href={lienGrille(f.codefou)}
                                            className="font-medium text-[var(--accent)] hover:underline"
                                            title="Ouvrir la révision d'assortiment de ce fournisseur"
                                        >
                                            Réviser l&apos;assortiment
                                        </Link>
                                    </div>
                                </li>
                            ))}
                        </ul>
                        {fournisseurReseau && (
                            <p className="text-[13px] text-[var(--text-muted)]">
                                Fournisseur indiqué par les données du réseau : {fournisseurReseau}
                            </p>
                        )}
                    </div>
                )}
            </Bloc>

            {/* ─── Identité catalogue (produits référencés uniquement) ──────── */}
            {detail && (
                <Bloc titre="Identité du produit" icone={Package}>
                    <div className="grid grid-cols-2 gap-x-6 gap-y-4 md:grid-cols-3 lg:grid-cols-4">
                        <Field label={<Terme id="codeInterne" />}><span className="font-mono">{detail.codein}</span></Field>
                        <Field label={<Terme id="codeCentrale" />}><span className="font-mono">{detail.code_centrale || "—"}</span></Field>
                        <Field label="Fournisseur">{fournisseurAffiche ?? "—"}</Field>
                        <Field label={<Terme id="gtin" />}><span className="font-mono">{detail.gtin || "—"}</span></Field>
                        <Field label="Référence fournisseur"><span className="font-mono">{detail.reference || "—"}</span></Field>
                        <Field label={<Terme id="pcb" />}>{detail.pcb != null ? fmtEntier(detail.pcb) : "—"}</Field>
                        <Field label={<Terme id="gammeInit" />}><GammeBadge code={gammes[0]?.gamme_code} avecNom /></Field>
                        <Field label="Secteur">{detail.libelle1nom ?? "—"}</Field>
                        <Field label="Rayon">{detail.libelle2 ?? "—"}</Field>
                        <Field label="Famille">{detail.libelle3 ?? "—"}</Field>
                        <Field label="Prix d'achat">{detail.pa != null ? fmtEur2(detail.pa) : "—"}</Field>
                        <Field
                            label={
                                <Aide texte="Prix de vente plancher fixé par la centrale d'achat (souvent non renseigné).">
                                    Prix de vente minimum (centrale)
                                </Aide>
                            }
                        >
                            {detail.pv_central != null ? fmtEur2(detail.pv_central) : "—"}
                        </Field>
                        <Field
                            label={<Aide texte="Quantité commandée au fournisseur et pas encore reçue.">Quantité en commande</Aide>}
                        >
                            {commandesEnCours > 0 ? fmtEntier(commandesEnCours) : "—"}
                        </Field>
                    </div>

                    {gammes.length > 1 && (
                        <div className="mt-5 border-t border-[var(--border)] pt-4">
                            <SousTitre titre="Historique de gamme" description="Saison la plus récente en premier." />
                            <ul className="flex flex-wrap gap-2">
                                {gammes.slice(0, 10).map((g, i) => (
                                    <li
                                        key={`${g.saison_no_id}-${i}`}
                                        className="inline-flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] px-2.5 py-1 text-[13px] text-[var(--text-secondary)]"
                                    >
                                        {g.saison_libelle || g.saison_code || `Saison ${g.saison_no_id}`}
                                        <GammeBadge code={g.gamme_code} />
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}
                </Bloc>
            )}

            {/* ─── Stock ───────────────────────────────────────────────────── */}
            {detail && (
                <Bloc titre="Stock en temps réel" icone={Warehouse}>
                    {stock.length === 0 ? (
                        <p className="text-sm text-[var(--text-secondary)]">Aucun stock enregistré pour ce produit dans nos magasins.</p>
                    ) : (
                        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                            {stock.map((s) => (
                                <div key={s.site} className="rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] p-4">
                                    <div className="mb-3 flex items-start justify-between gap-2">
                                        <StoreBadge code={s.site} />
                                        <div className="text-right">
                                            <div className="text-xs text-[var(--text-muted)]">Stock</div>
                                            <div
                                                className="text-xl font-bold tabular-nums"
                                                style={{ color: s.qte < 0 ? "var(--accent-error)" : "var(--text-primary)" }}
                                            >
                                                {fmtEntier(s.qte)}
                                            </div>
                                            {s.qte < 0 && <Terme id="stockNegatif" className="text-xs text-[var(--accent-error)]" />}
                                        </div>
                                    </div>
                                    <div className="grid grid-cols-2 gap-x-4 gap-y-3">
                                        <Field label="Stock disponible"><span className="tabular-nums">{fmtEntier(s.stockdispo)}</span></Field>
                                        <Field label="Valeur du stock"><span className="tabular-nums">{fmtEur0(s.valstock)}</span></Field>
                                        <Field label={<Terme id="prmp" />}><span className="tabular-nums">{s.prmp > 0 ? fmtEur2(s.prmp) : "—"}</span></Field>
                                        <Field label="Dernière vente">{formatDate(s.dernierevente)}</Field>
                                        <Field label="Dernière réception">{formatDate(s.dernierereception)}</Field>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </Bloc>
            )}

            {/* ─── Nos ventes, 12 mois glissants ───────────────────────────── */}
            {detail && (
                <Bloc
                    titre="Nos ventes · 12 derniers mois"
                    icone={ShoppingCart}
                    description="Chiffre d'affaires TTC, tiré des caisses de nos magasins."
                    actions={
                        <Segmented
                            items={[
                                { value: CODE_TOUS_MAGASINS, label: LIBELLE_TOUS_MAGASINS },
                                ...sitesDisponibles.map((code) => ({ value: code, label: nomMagasin(code, { court: true }) })),
                            ]}
                            value={magasin}
                            onChange={setMagasin}
                        />
                    }
                >
                    <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
                        <StatCard label="Quantité vendue" value={fmtEntier(totauxAffiches.qte)} />
                        <StatCard label="Chiffre d'affaires TTC" value={fmtEur0(totauxAffiches.ca)} />
                        <StatCard label={<Terme id="marge" />} value={fmtEur0(totauxAffiches.marge)} />
                        <StatCard
                            label="Taux de marge"
                            value={
                                totauxAffiches.ca > 0
                                    ? <span style={{ color: couleurMarge(totauxAffiches.tauxMarge) }}>{fmtDecimal1(totauxAffiches.tauxMarge)} %</span>
                                    : "—"
                            }
                        />
                    </div>

                    <div className="overflow-x-auto rounded-lg border border-[var(--border)]">
                        <table className="w-full border-collapse text-sm">
                            <thead className="bg-[var(--bg-elevated)]">
                                <tr>
                                    <th scope="col" className={TH_COIN}>Mois</th>
                                    {months.map((m) => (
                                        <th key={m} scope="col" className={cn(TH_COL, "text-center")}>{formatMonthLabel(m)}</th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody>
                                <tr className="border-t border-[var(--border)]">
                                    <th scope="row" className={TH_LIGNE}>Quantité vendue</th>
                                    {months.map((m) => (
                                        <td key={m} className="min-w-[52px] px-1 py-1.5">
                                            <HeatmapCell
                                                value={serie[m]?.qte ?? 0}
                                                tooltipStock={serie[m]?.stockFinMois ?? null}
                                                tooltipReceptions={serie[m]?.qteRecue ?? null}
                                            />
                                        </td>
                                    ))}
                                </tr>
                                <tr className="border-t border-[var(--border)]">
                                    <th scope="row" className={TH_LIGNE}>Chiffre d&apos;affaires TTC (€)</th>
                                    {months.map((m) => (
                                        <td key={m} className={TD}>
                                            {serie[m]?.ca ? fmtEntier(serie[m].ca) : <span className="text-[var(--text-muted)]">—</span>}
                                        </td>
                                    ))}
                                </tr>
                                <tr className="border-t border-[var(--border)]">
                                    <th scope="row" className={TH_LIGNE}>Stock en fin de mois</th>
                                    {months.map((m) => (
                                        <td key={m} className={TD}>
                                            {serie[m]?.stockFinMois ? fmtEntier(serie[m].stockFinMois) : <span className="text-[var(--text-muted)]">—</span>}
                                        </td>
                                    ))}
                                </tr>
                            </tbody>
                        </table>
                    </div>

                    <NetworkLineChart
                        labels={months.map(ffMonthToQlik)}
                        values={months.map((m) => serie[m]?.qte ?? 0)}
                    />
                </Bloc>
            )}

            {/* ─── Comparatif local vs réseau ──────────────────────────────── */}
            {detail && comparatif.hasReseau && (
                <Bloc
                    titre="Nous comparés à un magasin moyen du réseau"
                    icone={Scale}
                    description="Sur 12 mois, nos ventes par magasin rapportées à celles d'un magasin du réseau qui vend ce produit."
                >
                    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                        <StatCard
                            label={
                                <Aide texte="100 % = nous vendons autant par magasin qu'un magasin moyen du réseau qui a ce produit. Au-dessus, nous vendons mieux ; en dessous, moins bien.">
                                    Indice de performance
                                </Aide>
                            }
                            value={
                                comparatif.indiceQte != null
                                    ? <span style={{ color: COULEUR_VERDICT[verdict.label] ?? "var(--text-primary)" }}>{fmtEntier(comparatif.indiceQte)} %</span>
                                    : "—"
                            }
                            hint={verdict.label}
                        />
                        <StatCard
                            label="Nos ventes par magasin"
                            value={fmtEntier(comparatif.qteLocaleParMagasin)}
                            hint={`${comparatif.nbMagasinsLocaux} magasin${comparatif.nbMagasinsLocaux > 1 ? "s" : ""} · 12 mois`}
                        />
                        <StatCard
                            label="Ventes par magasin du réseau"
                            value={fmtEntier(comparatif.qteReseauParMagasin)}
                            hint={`${fmtEntier(comparatif.nbMagasinsReseau)} magasins vendeurs · 12 mois`}
                        />
                        <StatCard
                            label={<Terme id="presenceReseau">Présence dans le réseau</Terme>}
                            value={comparatif.tauxPresence != null ? `${fmtEntier(comparatif.tauxPresence * 100)} %` : "—"}
                            hint={`${fmtEntier(comparatif.nbMagasinsReseau)} magasins vendeurs sur ${NB_MAGASINS_RESEAU}`}
                        />
                    </div>

                    <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
                        <Comparaison
                            titre={<Terme id="caParMagasin">Chiffre d&apos;affaires par magasin</Terme>}
                            nous={fmtEur0(comparatif.caLocalParMagasin)}
                            reseau={comparatif.caReseauParMagasin != null ? fmtEur0(comparatif.caReseauParMagasin) : "—"}
                        />
                        <Comparaison
                            titre={<Terme id="marge">Taux de marge</Terme>}
                            nous={<span style={{ color: couleurMarge(comparatif.tauxMargeLocal) }}>{fmtDecimal1(comparatif.tauxMargeLocal)} %</span>}
                            reseau={
                                comparatif.tauxMargeReseau != null
                                    ? <span style={{ color: couleurMarge(comparatif.tauxMargeReseau) }}>{fmtDecimal1(comparatif.tauxMargeReseau)} %</span>
                                    : "—"
                            }
                        />
                    </div>

                    <p className="mt-3 text-[13px] text-[var(--text-secondary)]">
                        L&apos;indice compare les <strong>quantités</strong> vendues par magasin, seule base commune fiable.
                        Notre chiffre d&apos;affaires est TTC (caisses) ; la base de celui du réseau n&apos;est pas connue :
                        montants et marges sont donc donnés à titre indicatif.
                    </p>

                    {comparatif.hasMonthly && (
                        <section className="mt-6">
                            <SousTitre titre="Quantité vendue par magasin, mois par mois" />
                            <DualLineChart
                                labels={comparatif.monthly.map((m) => ffMonthToQlik(m.mois))}
                                series={[
                                    { name: "Nous, par magasin", values: comparatif.monthly.map((m) => m.local), color: "var(--viz-1)" },
                                    { name: "Réseau, par magasin", values: comparatif.monthly.map((m) => m.reseau), color: "var(--viz-2)" },
                                ]}
                            />
                        </section>
                    )}
                </Bloc>
            )}

            {/* ─── Opportunités de la même famille ─────────────────────────── */}
            {detail?.nom_no_id != null && (
                <Bloc titre="Opportunités dans la même famille" icone={Layers}>
                    <OpportunitesFamille
                        nomNoId={detail.nom_no_id}
                        currentCodein={detail.codein}
                        familleLabel={detail.libelle3 ?? detail.libelle2 ?? ""}
                    />
                </Bloc>
            )}

            {/* Sparkline discrète en pied de fiche, cohérente avec la Grille */}
            {trend.hasData && (
                <div className="flex items-center justify-end gap-2 text-[13px] text-[var(--text-secondary)]">
                    <span>Tendance dans le réseau :</span>
                    <TrendSparkline trend={trend} />
                </div>
            )}
        </div>
    );
}

/** Deux valeurs côte à côte, nous et le réseau, à titre indicatif. */
function Comparaison({ titre, nous, reseau }: { titre: ReactNode; nous: ReactNode; reseau: ReactNode }) {
    return (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] p-4">
            <div className="mb-2 text-[13px] font-medium text-[var(--text-secondary)]">
                {titre} <span className="font-normal text-[var(--text-muted)]">· indicatif</span>
            </div>
            <div className="flex flex-wrap items-baseline justify-between gap-3 text-sm text-[var(--text-secondary)]">
                <span>Nous : <span className="text-base font-semibold tabular-nums text-[var(--text-primary)]">{nous}</span></span>
                <span>Réseau : <span className="text-base font-semibold tabular-nums text-[var(--text-primary)]">{reseau}</span></span>
            </div>
        </div>
    );
}
