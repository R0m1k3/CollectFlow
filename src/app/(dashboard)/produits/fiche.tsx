"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
    ArrowLeft, Package, Warehouse, ShoppingCart, Globe, Layers,
    RefreshCw, Loader2, CheckCircle, AlertCircle, WifiOff, LayoutGrid,
} from "lucide-react";
import { HeatmapCell } from "@/features/grid/components/heatmap-cell";
import { NetworkLineChart, DualLineChart, TrendSparkline } from "@/features/grid/components/network-charts";
import { computeNetworkTrend, trendLabel, TREND_COLOR, NB_MAGASINS_RESEAU } from "@/features/grid/lib/network-trend";
import { formatMonthLabel, formatDate, SITE_LABELS, ffMonthToQlik } from "@/features/grid/lib/months";
import { useQlikSyncJob } from "@/features/qlik-sync/use-qlik-sync-job";
import { computeComparatif, indiceVerdict } from "@/features/produits/lib/compare-reseau";
import type { ProduitFiche } from "@/features/produits/types";
import { OpportunitesFamille } from "./opportunites";

// ─── Formatteurs partagés ────────────────────────────────────────────────────

const fmtEur = (v: number) =>
    new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(v);
const fmtQte = (v: number) => new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 }).format(v);
const fmtDec = (v: number, d = 1) => new Intl.NumberFormat("fr-FR", { minimumFractionDigits: d, maximumFractionDigits: d }).format(v);

// ─── Briques de présentation ─────────────────────────────────────────────────

function Card({ title, icon: Icon, children, action }: {
    title: string;
    icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
    children: React.ReactNode;
    action?: React.ReactNode;
}) {
    return (
        <section className="apple-card">
            <div className="apple-card-header flex items-center justify-between gap-3">
                <h2 className="flex items-center gap-2 text-[13px] font-semibold" style={{ color: "var(--text-primary)" }}>
                    <Icon className="w-4 h-4" style={{ color: "var(--accent)" }} />
                    {title}
                </h2>
                {action}
            </div>
            <div className="apple-card-content">{children}</div>
        </section>
    );
}

function Field({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
    return (
        <div className="min-w-0">
            <div className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
                {label}
            </div>
            <div className={`text-[13px] truncate ${mono ? "font-mono" : ""}`} style={{ color: "var(--text-primary)" }}>
                {value ?? "—"}
            </div>
        </div>
    );
}

function Stat({ label, value, hint, color }: { label: string; value: string; hint?: string; color?: string }) {
    return (
        <div className="rounded-xl p-3" style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)" }}>
            <div className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
                {label}
            </div>
            <div className="text-[19px] font-black tabular-nums leading-tight mt-0.5" style={{ color: color ?? "var(--text-primary)" }}>
                {value}
            </div>
            {hint && <div className="text-[10px] mt-0.5" style={{ color: "var(--text-muted)" }}>{hint}</div>}
        </div>
    );
}

// ─── Bouton d'extraction Qlik pour un seul code centrale ─────────────────────

function SyncProduitButton({ codeCentrale }: { codeCentrale: string }) {
    const router = useRouter();
    const { status, message, start } = useQlikSyncJob({
        target: { mode: "produit", codeCentrale },
        onSuccess: () => router.refresh(),
    });

    return (
        <div className="flex items-center gap-2">
            {message && (
                <span
                    className="text-[10px] leading-tight text-right max-w-[280px]"
                    style={{ color: status === "error" ? "var(--accent-error)" : "var(--text-muted)" }}
                    title={message}
                >
                    {message}
                </span>
            )}
            <button
                onClick={start}
                disabled={status === "running"}
                className="btn-action btn-action-secondary flex items-center gap-1.5 disabled:opacity-60"
                title="Extraire les données réseau Qlik pour ce seul produit"
            >
                {status === "running" ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    : status === "success" ? <CheckCircle className="w-3.5 h-3.5 text-emerald-500" />
                        : status === "error" ? <AlertCircle className="w-3.5 h-3.5 text-rose-500" />
                            : <RefreshCw className="w-3.5 h-3.5" />}
                {status === "running" ? "Extraction…" : "Charger les données réseau"}
            </button>
        </div>
    );
}

// ─── Fiche ───────────────────────────────────────────────────────────────────

export function ProduitFicheView({ fiche, backQuery }: { fiche: ProduitFiche; backQuery: string }) {
    const { detail, fournisseurs, stock, commandesEnCours, gammes, months, reseau } = fiche;
    const [magasin, setMagasin] = useState<string>("TOTAL");

    const sitesDisponibles = useMemo(() => {
        const sites = new Set<string>([...Object.keys(fiche.mensuelParSite), ...stock.map((s) => s.site)]);
        return [...sites].filter(Boolean).sort();
    }, [fiche.mensuelParSite, stock]);

    // Série affichée selon le magasin sélectionné.
    const serie = magasin === "TOTAL" ? fiche.mensuelTotal : (fiche.mensuelParSite[magasin] ?? {});
    const totauxAffiches = magasin === "TOTAL" ? fiche.totaux : (fiche.totauxParSite[magasin] ?? { qte: 0, ca: 0, marge: 0, tauxMarge: 0 });

    const trend = useMemo(() => computeNetworkTrend(reseau?.qteByMonth ?? null), [reseau]);
    const comparatif = useMemo(() => computeComparatif(fiche), [fiche]);
    const verdict = indiceVerdict(comparatif.indiceQte);

    const fournisseurPrincipal = fournisseurs.find((f) => f.principal) ?? fournisseurs[0];

    return (
        <div className="space-y-5">
            {/* En-tête */}
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                    <Link
                        href={backQuery ? `/produits?q=${encodeURIComponent(backQuery)}` : "/produits"}
                        className="inline-flex items-center gap-1.5 text-[12px] mb-1.5 hover:underline"
                        style={{ color: "var(--text-muted)" }}
                    >
                        <ArrowLeft className="w-3.5 h-3.5" />
                        Retour aux résultats
                    </Link>
                    <h2 className="text-[20px] font-semibold tracking-[-0.3px]" style={{ color: "var(--text-primary)" }}>
                        {detail.libelle1 || "Sans libellé"}
                    </h2>
                    <p className="text-[12px] mt-0.5" style={{ color: "var(--text-muted)" }}>
                        <span className="font-mono">{detail.codein}</span>
                        {detail.code_centrale && <> · centrale <span className="font-mono">{detail.code_centrale}</span></>}
                        {fournisseurPrincipal && <> · {fournisseurPrincipal.nomfou}</>}
                    </p>
                </div>
                {fournisseurPrincipal?.codefou && (
                    <Link
                        href={`/grid?fournisseur=${encodeURIComponent(fournisseurPrincipal.codefou)}&magasin=TOTAL`}
                        className="btn-action btn-action-secondary flex items-center gap-1.5"
                        title="Ouvrir la grille d'arbitrage de ce fournisseur"
                    >
                        <LayoutGrid className="w-3.5 h-3.5" />
                        Voir dans la Grille
                    </Link>
                )}
            </div>

            {/* Identité */}
            <Card title="Identité" icon={Package}>
                <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4">
                    <Field label="Code article" value={detail.codein} mono />
                    <Field label="Code centrale" value={detail.code_centrale || "—"} mono />
                    <Field label="GTIN" value={detail.gtin || "—"} mono />
                    <Field label="Référence fou." value={detail.reference || "—"} mono />
                    <Field label="PCB" value={detail.pcb != null ? fmtQte(detail.pcb) : "—"} />
                    <Field label="Gamme actuelle" value={gammes[0]?.gamme_code ?? "—"} />
                    <Field label="Secteur" value={detail.libelle1nom ?? "—"} />
                    <Field label="Famille" value={detail.libelle2 ?? "—"} />
                    <Field label="Sous-famille" value={detail.libelle3 ?? "—"} />
                    <Field label="Prix d'achat" value={detail.pa != null ? fmtEur(detail.pa) : "—"} />
                    <Field label="PV central" value={detail.pv_central != null ? fmtEur(detail.pv_central) : "—"} />
                    <Field label="En commande" value={commandesEnCours > 0 ? fmtQte(commandesEnCours) : "—"} />
                </div>

                {fournisseurs.length > 0 && (
                    <div className="mt-4 pt-3" style={{ borderTop: "1px solid var(--border)" }}>
                        <div className="text-[10px] font-semibold uppercase tracking-wide mb-1.5" style={{ color: "var(--text-muted)" }}>
                            Fournisseurs référencés
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                            {fournisseurs.map((f) => (
                                <span
                                    key={f.codefou}
                                    className="rounded-lg px-2 py-1 text-[11px]"
                                    style={{
                                        background: f.principal ? "var(--accent-bg)" : "var(--bg-elevated)",
                                        border: `1px solid ${f.principal ? "var(--accent-border)" : "var(--border)"}`,
                                        color: f.principal ? "var(--accent)" : "var(--text-secondary)",
                                    }}
                                    title={f.reference ? `Réf. ${f.reference}` : undefined}
                                >
                                    {f.nomfou}
                                    {f.principal && <span className="ml-1 font-semibold">· principal</span>}
                                </span>
                            ))}
                        </div>
                    </div>
                )}

                {gammes.length > 1 && (
                    <div className="mt-3 pt-3" style={{ borderTop: "1px solid var(--border)" }}>
                        <div className="text-[10px] font-semibold uppercase tracking-wide mb-1.5" style={{ color: "var(--text-muted)" }}>
                            Historique de gamme
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                            {gammes.slice(0, 10).map((g, i) => (
                                <span
                                    key={`${g.saison_no_id}-${i}`}
                                    className="rounded-lg px-2 py-1 text-[11px]"
                                    style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)", color: "var(--text-secondary)" }}
                                >
                                    {g.saison_libelle || g.saison_code || `Saison ${g.saison_no_id}`}
                                    <span className="ml-1.5 font-bold" style={{ color: "var(--text-primary)" }}>{g.gamme_code}</span>
                                </span>
                            ))}
                        </div>
                    </div>
                )}
            </Card>

            {/* Stock */}
            <Card title="Stock temps réel" icon={Warehouse}>
                {stock.length === 0 ? (
                    <p className="text-[13px]" style={{ color: "var(--text-muted)" }}>Aucune ligne de stock pour ce produit.</p>
                ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        {stock.map((s) => (
                            <div key={s.site} className="rounded-xl p-3" style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)" }}>
                                <div className="flex items-center justify-between mb-2">
                                    <span className="text-[12px] font-semibold" style={{ color: "var(--text-primary)" }}>
                                        {SITE_LABELS[s.site]?.nom ?? s.site}
                                    </span>
                                    <span
                                        className="text-[16px] font-black tabular-nums"
                                        style={{ color: s.qte < 0 ? "var(--accent-error)" : "var(--text-primary)" }}
                                    >
                                        {fmtQte(s.qte)}
                                    </span>
                                </div>
                                <div className="grid grid-cols-2 gap-2 text-[11px]" style={{ color: "var(--text-secondary)" }}>
                                    <div>Dispo : <span className="tabular-nums">{fmtQte(s.stockdispo)}</span></div>
                                    <div>Valeur : <span className="tabular-nums">{fmtEur(s.valstock)}</span></div>
                                    <div>PRMP : <span className="tabular-nums">{s.prmp > 0 ? fmtEur(s.prmp) : "—"}</span></div>
                                    <div>Dern. vente : {formatDate(s.dernierevente)}</div>
                                    <div className="col-span-2">Dern. réception : {formatDate(s.dernierereception)}</div>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </Card>

            {/* Ventes 12 mois glissants */}
            <Card
                title="Ventes · 12 mois glissants"
                icon={ShoppingCart}
                action={
                    <div className="segment-control">
                        {["TOTAL", ...sitesDisponibles].map((code) => (
                            <button
                                key={code}
                                onClick={() => setMagasin(code)}
                                className={`segment-btn ${magasin === code ? "active" : ""}`}
                            >
                                {code === "TOTAL" ? "Total" : (SITE_LABELS[code]?.label ?? code)}
                            </button>
                        ))}
                    </div>
                }
            >
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
                    <Stat label="Quantité vendue" value={fmtQte(totauxAffiches.qte)} />
                    <Stat label="CA (TTC)" value={fmtEur(totauxAffiches.ca)} />
                    <Stat label="Marge" value={fmtEur(totauxAffiches.marge)} />
                    <Stat
                        label="Taux de marge"
                        value={`${fmtDec(totauxAffiches.tauxMarge)} %`}
                        color={totauxAffiches.tauxMarge >= 40 ? "#22c55e" : totauxAffiches.tauxMarge >= 25 ? "#f59e0b" : undefined}
                    />
                </div>

                <div className="overflow-x-auto">
                    <table className="w-full border-collapse text-[12px]">
                        <thead>
                            <tr>
                                <th className="px-2 py-1.5 text-left text-[10px] font-semibold uppercase" style={{ color: "var(--text-muted)" }}>
                                    Mois
                                </th>
                                {months.map((m) => (
                                    <th key={m} className="px-1 py-1.5 text-center text-[10px] font-semibold whitespace-nowrap" style={{ color: "var(--text-muted)" }}>
                                        {formatMonthLabel(m)}
                                    </th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            <tr>
                                <td className="px-2 py-1 text-[11px] font-medium whitespace-nowrap" style={{ color: "var(--text-secondary)" }}>
                                    Ventes
                                </td>
                                {months.map((m) => (
                                    <td key={m} className="px-0.5 py-1 min-w-[46px]">
                                        <HeatmapCell
                                            value={serie[m]?.qte ?? 0}
                                            tooltipStock={serie[m]?.stockFinMois ?? null}
                                            tooltipReceptions={serie[m]?.qteRecue ?? null}
                                        />
                                    </td>
                                ))}
                            </tr>
                            <tr>
                                <td className="px-2 py-1 text-[11px] font-medium whitespace-nowrap" style={{ color: "var(--text-secondary)" }}>
                                    CA (TTC)
                                </td>
                                {months.map((m) => (
                                    <td key={m} className="px-0.5 py-1 text-center tabular-nums text-[11px]" style={{ color: "var(--text-muted)" }}>
                                        {serie[m]?.ca ? Math.round(serie[m].ca).toLocaleString("fr-FR") : "—"}
                                    </td>
                                ))}
                            </tr>
                            <tr>
                                <td className="px-2 py-1 text-[11px] font-medium whitespace-nowrap" style={{ color: "var(--text-secondary)" }}>
                                    Stock fin de mois
                                </td>
                                {months.map((m) => (
                                    <td key={m} className="px-0.5 py-1 text-center tabular-nums text-[11px]" style={{ color: "var(--text-muted)" }}>
                                        {serie[m]?.stockFinMois ? Math.round(serie[m].stockFinMois).toLocaleString("fr-FR") : "—"}
                                    </td>
                                ))}
                            </tr>
                        </tbody>
                    </table>
                </div>

                <NetworkLineChart
                    labels={months.map(ffMonthToQlik)}
                    values={months.map((m) => serie[m]?.qte ?? 0)}
                    color="#0ea5e9"
                />
            </Card>

            {/* Réseau Qlik */}
            <Card
                title="Réseau Qlik"
                icon={Globe}
                action={detail.code_centrale ? <SyncProduitButton codeCentrale={detail.code_centrale} /> : undefined}
            >
                {!detail.code_centrale ? (
                    <p className="text-[13px]" style={{ color: "var(--text-muted)" }}>
                        Ce produit n&apos;a pas de code centrale : il n&apos;est pas référencé centralement et n&apos;existe donc pas dans Qlik.
                    </p>
                ) : !reseau ? (
                    <div className="flex items-start gap-3 rounded-xl p-4" style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)" }}>
                        <WifiOff className="w-4 h-4 mt-0.5 shrink-0" style={{ color: "var(--text-muted)" }} />
                        <div className="text-[13px]" style={{ color: "var(--text-secondary)" }}>
                            Aucune donnée réseau en cache pour ce produit.
                            <div className="text-[12px] mt-0.5" style={{ color: "var(--text-muted)" }}>
                                Lancez l&apos;extraction ci-dessus : elle ne porte que sur ce code centrale et prend quelques secondes.
                            </div>
                        </div>
                    </div>
                ) : (
                    <>
                        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
                            <Stat label="CA réseau" value={fmtEur(reseau.caReseau)} />
                            <Stat label="Qté réseau" value={fmtQte(reseau.qteReseau)} />
                            <Stat
                                label="Magasins"
                                value={`${reseau.nbMagasinsReseau}`}
                                hint={`sur ${NB_MAGASINS_RESEAU} · ${fmtDec((reseau.nbMagasinsReseau / NB_MAGASINS_RESEAU) * 100, 0)} %`}
                            />
                            <Stat label="CA / magasin" value={fmtEur(reseau.caParMagasinReseau)} />
                            <Stat
                                label="Marge % réseau"
                                value={comparatif.tauxMargeReseau != null ? `${fmtDec(comparatif.tauxMargeReseau)} %` : "—"}
                            />
                            <Stat
                                label="Tendance 12 m"
                                value={trend.pct != null ? `${trend.pct >= 0 ? "+" : ""}${Math.round(trend.pct * 100)} %` : "—"}
                                hint={trendLabel(trend.pct)}
                                color={TREND_COLOR[trend.direction]}
                            />
                        </div>

                        <p className="text-[11px] mt-3" style={{ color: "var(--text-muted)" }}>
                            Période {reseau.periode ?? "12 mois"} · extrait le {formatDate(reseau.fetchedAt)}
                        </p>

                        {trend.hasData && (
                            <div className="mt-3">
                                <div className="text-[10px] font-semibold uppercase tracking-wide mb-1" style={{ color: "var(--text-muted)" }}>
                                    Quantités vendues réseau, mois par mois
                                </div>
                                <NetworkLineChart labels={trend.labels} values={trend.values} color={TREND_COLOR[trend.direction]} />
                            </div>
                        )}

                        {/* Détail mensuel complet (CA, marge, magasins) si disponible */}
                        {reseau.metricsByMonth && Object.keys(reseau.metricsByMonth).length > 0 && (
                            <div className="mt-4 overflow-x-auto">
                                <div className="text-[10px] font-semibold uppercase tracking-wide mb-1.5" style={{ color: "var(--text-muted)" }}>
                                    Détail mensuel réseau
                                </div>
                                <table className="w-full border-collapse text-[11px]">
                                    <thead>
                                        <tr>
                                            <th className="px-2 py-1.5 text-left font-semibold" style={{ color: "var(--text-muted)" }}>Mesure</th>
                                            {months.map((m) => (
                                                <th key={m} className="px-1 py-1.5 text-center font-semibold whitespace-nowrap" style={{ color: "var(--text-muted)" }}>
                                                    {formatMonthLabel(m)}
                                                </th>
                                            ))}
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {([
                                            { key: "qte", label: "Quantité", fmt: (v: number) => fmtQte(v) },
                                            { key: "ca", label: "CA", fmt: (v: number) => Math.round(v).toLocaleString("fr-FR") },
                                            { key: "nbMag", label: "Magasins", fmt: (v: number) => fmtQte(v) },
                                            { key: "margePct", label: "Marge %", fmt: (v: number) => `${fmtDec(Math.abs(v) <= 1 ? v * 100 : v)} %` },
                                        ] as const).map((row) => (
                                            <tr key={row.key}>
                                                <td className="px-2 py-1 font-medium whitespace-nowrap" style={{ color: "var(--text-secondary)" }}>
                                                    {row.label}
                                                </td>
                                                {months.map((m) => {
                                                    const v = reseau.metricsByMonth?.[ffMonthToQlik(m)]?.[row.key];
                                                    return (
                                                        <td key={m} className="px-1 py-1 text-center tabular-nums" style={{ color: "var(--text-muted)" }}>
                                                            {v != null ? row.fmt(v) : "—"}
                                                        </td>
                                                    );
                                                })}
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                                <p className="text-[10px] mt-1.5" style={{ color: "var(--text-muted)" }}>
                                    Les mois sans CA ni marge proviennent de la mesure « Quantité COMP », qui ne porte que la quantité.
                                </p>
                            </div>
                        )}
                    </>
                )}
            </Card>

            {/* Comparatif local vs réseau */}
            {comparatif.hasReseau && (
                <Card title="Nous vs. un magasin moyen du réseau" icon={Globe}>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                        <Stat
                            label="Indice de performance"
                            value={comparatif.indiceQte != null ? `${Math.round(comparatif.indiceQte)} %` : "—"}
                            hint={verdict.label}
                            color={verdict.color}
                        />
                        <Stat
                            label="Nos ventes / magasin"
                            value={fmtQte(comparatif.qteLocaleParMagasin)}
                            hint={`${comparatif.nbMagasinsLocaux} magasin${comparatif.nbMagasinsLocaux > 1 ? "s" : ""} · 12 mois`}
                        />
                        <Stat
                            label="Réseau / magasin"
                            value={fmtQte(comparatif.qteReseauParMagasin)}
                            hint={`${comparatif.nbMagasinsReseau} magasins · 12 mois`}
                        />
                        <Stat
                            label="Présence réseau"
                            value={comparatif.tauxPresence != null ? `${fmtDec(comparatif.tauxPresence * 100, 0)} %` : "—"}
                            hint={`${comparatif.nbMagasinsReseau} / ${NB_MAGASINS_RESEAU} magasins`}
                        />
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3">
                        <div className="rounded-xl p-3 text-[12px]" style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)" }}>
                            <div className="text-[10px] font-semibold uppercase tracking-wide mb-1" style={{ color: "var(--text-muted)" }}>
                                CA par magasin · indicatif
                            </div>
                            <div className="flex items-center justify-between" style={{ color: "var(--text-secondary)" }}>
                                <span>Nous : <span className="font-semibold tabular-nums" style={{ color: "var(--text-primary)" }}>{fmtEur(comparatif.caLocalParMagasin)}</span></span>
                                <span>Réseau : <span className="font-semibold tabular-nums" style={{ color: "var(--text-primary)" }}>{comparatif.caReseauParMagasin != null ? fmtEur(comparatif.caReseauParMagasin) : "—"}</span></span>
                            </div>
                        </div>
                        <div className="rounded-xl p-3 text-[12px]" style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)" }}>
                            <div className="text-[10px] font-semibold uppercase tracking-wide mb-1" style={{ color: "var(--text-muted)" }}>
                                Taux de marge · indicatif
                            </div>
                            <div className="flex items-center justify-between" style={{ color: "var(--text-secondary)" }}>
                                <span>Nous : <span className="font-semibold tabular-nums" style={{ color: "var(--text-primary)" }}>{fmtDec(comparatif.tauxMargeLocal)} %</span></span>
                                <span>Réseau : <span className="font-semibold tabular-nums" style={{ color: "var(--text-primary)" }}>{comparatif.tauxMargeReseau != null ? `${fmtDec(comparatif.tauxMargeReseau)} %` : "—"}</span></span>
                            </div>
                        </div>
                    </div>

                    <p className="text-[11px] mt-2" style={{ color: "var(--text-muted)" }}>
                        L&apos;indice compare les <strong>quantités</strong> par magasin, seule base commune fiable.
                        Notre CA est TTC (issu des mouvements de caisse) ; la base du CA Qlik n&apos;est pas
                        documentée — montants et marges sont donc donnés à titre indicatif.
                    </p>

                    {comparatif.hasMonthly && (
                        <div className="mt-4">
                            <div className="text-[10px] font-semibold uppercase tracking-wide mb-1" style={{ color: "var(--text-muted)" }}>
                                Quantité par magasin, mois par mois
                            </div>
                            <DualLineChart
                                labels={comparatif.monthly.map((m) => ffMonthToQlik(m.mois))}
                                series={[
                                    { name: "Nous / magasin", values: comparatif.monthly.map((m) => m.local), color: "#0ea5e9" },
                                    { name: "Réseau / magasin", values: comparatif.monthly.map((m) => m.reseau), color: "#f59e0b" },
                                ]}
                            />
                        </div>
                    )}
                </Card>
            )}

            {/* Opportunités de la même famille */}
            {detail.nom_no_id != null && (
                <Card title="Opportunités · même famille" icon={Layers}>
                    <OpportunitesFamille
                        nomNoId={detail.nom_no_id}
                        currentCodein={detail.codein}
                        familleLabel={detail.libelle3 ?? detail.libelle2 ?? ""}
                    />
                </Card>
            )}

            {/* Sparkline discrète en pied de fiche, cohérente avec la Grille */}
            {trend.hasData && (
                <div className="flex items-center justify-end gap-2 text-[11px]" style={{ color: "var(--text-muted)" }}>
                    <span>Tendance réseau :</span>
                    <TrendSparkline trend={trend} />
                </div>
            )}
        </div>
    );
}
