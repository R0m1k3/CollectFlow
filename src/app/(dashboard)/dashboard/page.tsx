import { pgGetDashboardData, type DashboardTopItem, type DashboardSiteStats, type DashboardMonthStats } from "@/lib/pg-ff-client";
import { TrendingUp, TrendingDown, Minus, Store, ShoppingCart, Euro, Percent, Users } from "lucide-react";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SITE_NAMES: Record<string, string> = { "292": "Frouard", "579": "Houdemont" };

function fmtEur(n: number): string {
    const abs = Math.abs(n);
    if (abs >= 1_000_000) return `${(n / 1_000_000).toLocaleString("fr-FR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} M€`;
    if (abs >= 1_000) return `${(n / 1_000).toLocaleString("fr-FR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} k€`;
    return `${n.toLocaleString("fr-FR", { minimumFractionDigits: 0, maximumFractionDigits: 0 })} €`;
}

function fmtQte(n: number): string {
    return n.toLocaleString("fr-FR", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function fmtPct(n: number, signed = true): string {
    const s = signed && n > 0 ? "+" : "";
    return `${s}${n.toLocaleString("fr-FR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
}

function delta(current: number, previous: number): number | null {
    if (!previous || previous === 0) return null;
    return ((current - previous) / Math.abs(previous)) * 100;
}

function monthLabel(mois: string): string {
    const [y, m] = mois.split("-");
    const names = ["Jan", "Fév", "Mar", "Avr", "Mai", "Jun", "Jul", "Aoû", "Sep", "Oct", "Nov", "Déc"];
    return `${names[parseInt(m) - 1]} ${y.slice(2)}`;
}

function dateLabel(iso: string): string {
    const [y, m, d] = iso.split("-");
    return `${d}/${m}/${y}`;
}

// ---------------------------------------------------------------------------
// Sub-components (server-side, no "use client" needed)
// ---------------------------------------------------------------------------

function DeltaBadge({ pct }: { pct: number | null }) {
    if (pct === null) return <span className="text-xs" style={{ color: "var(--text-muted)" }}>—</span>;
    const isPos = pct >= 0;
    const Icon = pct > 0.5 ? TrendingUp : pct < -0.5 ? TrendingDown : Minus;
    return (
        <span className="inline-flex items-center gap-0.5 text-xs font-semibold"
            style={{ color: isPos ? "#10b981" : "#ef4444" }}>
            <Icon className="w-3 h-3" />
            {fmtPct(pct)}
        </span>
    );
}

function KpiCard({ label, value, sub, delta: d, icon: Icon }: {
    label: string; value: string; sub?: string; delta?: number | null;
    icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
}) {
    return (
        <div className="rounded-xl p-4 flex flex-col gap-2" style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)" }}>
            <div className="flex items-center justify-between">
                <span className="text-xs font-medium uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>{label}</span>
                <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: "var(--accent-bg)", border: "1px solid var(--accent-border)" }}>
                    <Icon className="w-4 h-4" style={{ color: "var(--accent)" }} />
                </div>
            </div>
            <span className="text-2xl font-bold tracking-tight" style={{ color: "var(--text-primary)" }}>{value}</span>
            <div className="flex items-center gap-2">
                {d !== undefined && <DeltaBadge pct={d} />}
                {sub && <span className="text-xs" style={{ color: "var(--text-muted)" }}>{sub}</span>}
            </div>
        </div>
    );
}

function SiteCard({ site }: { site: DashboardSiteStats }) {
    const name = SITE_NAMES[site.site] ?? site.site;
    const txMarge = site.ca_hier > 0 ? (site.marge_hier / site.ca_hier) * 100 : 0;
    const dCa = delta(site.ca_hier, site.ca_n1);
    const dTickets = delta(site.tickets_hier, site.tickets_n1);

    return (
        <div className="rounded-xl p-5 flex flex-col gap-4" style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)" }}>
            <div className="flex items-center gap-2">
                <Store className="w-4 h-4" style={{ color: "var(--accent)" }} />
                <span className="text-base font-bold" style={{ color: "var(--text-primary)" }}>{name}</span>
                <span className="text-xs ml-auto" style={{ color: "var(--text-muted)" }}>site {site.site}</span>
            </div>
            <div className="grid grid-cols-2 gap-3">
                <div>
                    <div className="text-xs mb-1" style={{ color: "var(--text-muted)" }}>CA</div>
                    <div className="text-lg font-bold" style={{ color: "var(--text-primary)" }}>{fmtEur(site.ca_hier)}</div>
                    <div className="flex items-center gap-1.5">
                        <DeltaBadge pct={dCa} />
                        {site.ca_n1 > 0 && <span className="text-xs" style={{ color: "var(--text-muted)" }}>N-1 {fmtEur(site.ca_n1)}</span>}
                    </div>
                </div>
                <div>
                    <div className="text-xs mb-1" style={{ color: "var(--text-muted)" }}>Trafic (tickets)</div>
                    <div className="text-lg font-bold" style={{ color: "var(--text-primary)" }}>{fmtQte(site.tickets_hier)}</div>
                    <div className="flex items-center gap-1.5">
                        <DeltaBadge pct={dTickets} />
                        {site.tickets_n1 > 0 && <span className="text-xs" style={{ color: "var(--text-muted)" }}>N-1 {fmtQte(site.tickets_n1)}</span>}
                    </div>
                </div>
                <div>
                    <div className="text-xs mb-1" style={{ color: "var(--text-muted)" }}>Marge</div>
                    <div className="text-lg font-bold" style={{ color: "var(--text-primary)" }}>{fmtEur(site.marge_hier)}</div>
                </div>
                <div>
                    <div className="text-xs mb-1" style={{ color: "var(--text-muted)" }}>Tx Marge</div>
                    <div className="text-lg font-bold" style={{ color: txMarge >= 25 ? "#10b981" : txMarge >= 15 ? "#f59e0b" : "#ef4444" }}>
                        {fmtPct(txMarge, false)}
                    </div>
                </div>
            </div>
            <div className="text-xs pt-2" style={{ color: "var(--text-muted)", borderTop: "1px solid var(--border)" }}>
                {fmtQte(site.qte_hier)} articles · {fmtQte(site.lignes_hier)} lignes
            </div>
        </div>
    );
}

function Top10Table({ title, items, sortKey }: {
    title: string; items: DashboardTopItem[]; sortKey: "ca" | "qte" | "marge";
}) {
    const maxVal = items[0]?.[sortKey] ?? 1;
    return (
        <div className="rounded-xl overflow-hidden flex flex-col" style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)" }}>
            <div className="px-4 py-3 flex items-center gap-2" style={{ borderBottom: "1px solid var(--border)" }}>
                <span className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>{title}</span>
            </div>
            <div className="flex flex-col divide-y" style={{ borderColor: "var(--border)" }}>
                {items.length === 0 && (
                    <div className="px-4 py-8 text-center text-sm" style={{ color: "var(--text-muted)" }}>
                        Aucune donnée pour hier
                    </div>
                )}
                {items.map((item, i) => {
                    const val = item[sortKey];
                    const barPct = maxVal > 0 ? (val / maxVal) * 100 : 0;
                    const txMarge = item.ca > 0 ? (item.marge / item.ca) * 100 : 0;
                    return (
                        <div key={item.codein} className="px-4 py-2.5 flex flex-col gap-1">
                            <div className="flex items-center gap-2">
                                <span className="text-xs font-bold w-5 shrink-0 text-center rounded"
                                    style={{ color: i === 0 ? "#f59e0b" : i === 1 ? "#94a3b8" : i === 2 ? "#92400e" : "var(--text-muted)" }}>
                                    {i + 1}
                                </span>
                                <span className="text-xs flex-1 truncate" style={{ color: "var(--text-primary)" }} title={item.libelle1}>
                                    {item.libelle1 ?? item.codein}
                                </span>
                                <span className="text-xs font-semibold shrink-0" style={{ color: "var(--text-primary)" }}>
                                    {sortKey === "qte" ? fmtQte(val) : fmtEur(val)}
                                </span>
                            </div>
                            <div className="flex items-center gap-2 pl-7">
                                <div className="flex-1 h-1 rounded-full overflow-hidden" style={{ background: "var(--border)" }}>
                                    <div className="h-full rounded-full" style={{ width: `${barPct}%`, background: "var(--accent)" }} />
                                </div>
                                <span className="text-xs shrink-0" style={{ color: "var(--text-muted)" }}>
                                    {sortKey !== "ca" && `CA ${fmtEur(item.ca)} • `}
                                    {fmtPct(txMarge, false)} marge
                                </span>
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

function EvolutionTable({ evolution }: { evolution: DashboardMonthStats[] }) {
    // Regrouper par mois YYYY-MM → data
    const byMois = new Map(evolution.map(e => [e.mois, e]));

    // Calculer les 12 derniers mois complets (pas le mois en cours)
    const now = new Date();
    const months12: string[] = [];
    for (let i = 13; i >= 2; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        months12.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
    }

    const rows = months12.map(mois => {
        const [y, m] = mois.split("-");
        const prevMois = `${parseInt(y) - 1}-${m}`;
        const n = byMois.get(mois);
        const n1 = byMois.get(prevMois);
        const dCa = n && n1 ? delta(n.ca, n1.ca) : null;
        const dQte = n && n1 ? delta(n.qte, n1.qte) : null;
        return { mois, n, n1, dCa, dQte };
    });

    // Trouver les maxCA pour les barres
    const maxCa = Math.max(...rows.map(r => Math.max(r.n?.ca ?? 0, r.n1?.ca ?? 0)), 1);

    return (
        <div className="rounded-xl overflow-hidden" style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)" }}>
            <div className="px-4 py-3 flex items-center justify-between" style={{ borderBottom: "1px solid var(--border)" }}>
                <span className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>Évolution mensuelle — CA réseau</span>
                <span className="text-xs" style={{ color: "var(--text-muted)" }}>N vs N-1 · 12 mois complets</span>
            </div>
            <div className="overflow-x-auto">
                <table className="w-full text-xs">
                    <thead>
                        <tr style={{ borderBottom: "1px solid var(--border)" }}>
                            <th className="px-4 py-2 text-left font-medium" style={{ color: "var(--text-muted)" }}>Mois</th>
                            <th className="px-3 py-2 text-right font-medium" style={{ color: "var(--text-muted)" }}>CA N</th>
                            <th className="px-3 py-2 text-right font-medium" style={{ color: "var(--text-muted)" }}>CA N-1</th>
                            <th className="px-3 py-2 text-right font-medium" style={{ color: "var(--text-muted)" }}>Δ CA</th>
                            <th className="px-3 py-2 text-right font-medium" style={{ color: "var(--text-muted)" }}>Qté N</th>
                            <th className="px-3 py-2 text-right font-medium" style={{ color: "var(--text-muted)" }}>Qté N-1</th>
                            <th className="px-3 py-2 text-right font-medium" style={{ color: "var(--text-muted)" }}>Δ Qté</th>
                            <th className="px-3 py-2 text-right font-medium" style={{ color: "var(--text-muted)" }}>Tx Marge N</th>
                            <th className="px-4 py-2 font-medium min-w-[120px]" style={{ color: "var(--text-muted)" }}>Tendance</th>
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map(({ mois, n, n1, dCa, dQte }) => {
                            const txN = n && n.ca > 0 ? (n.marge / n.ca) * 100 : null;
                            const barN = n ? (n.ca / maxCa) * 100 : 0;
                            const barN1 = n1 ? (n1.ca / maxCa) * 100 : 0;
                            const isPositive = dCa !== null && dCa >= 0;
                            return (
                                <tr key={mois} style={{ borderBottom: "1px solid var(--border)" }}>
                                    <td className="px-4 py-2 font-semibold" style={{ color: "var(--text-primary)" }}>
                                        {monthLabel(mois)}
                                    </td>
                                    <td className="px-3 py-2 text-right font-medium" style={{ color: "var(--text-primary)" }}>
                                        {n ? fmtEur(n.ca) : "—"}
                                    </td>
                                    <td className="px-3 py-2 text-right" style={{ color: "var(--text-secondary)" }}>
                                        {n1 ? fmtEur(n1.ca) : "—"}
                                    </td>
                                    <td className="px-3 py-2 text-right">
                                        {dCa !== null ? (
                                            <span className="font-semibold" style={{ color: isPositive ? "#10b981" : "#ef4444" }}>
                                                {fmtPct(dCa)}
                                            </span>
                                        ) : "—"}
                                    </td>
                                    <td className="px-3 py-2 text-right font-medium" style={{ color: "var(--text-primary)" }}>
                                        {n ? fmtQte(n.qte) : "—"}
                                    </td>
                                    <td className="px-3 py-2 text-right" style={{ color: "var(--text-secondary)" }}>
                                        {n1 ? fmtQte(n1.qte) : "—"}
                                    </td>
                                    <td className="px-3 py-2 text-right">
                                        {dQte !== null ? (
                                            <span className="font-semibold" style={{ color: dQte >= 0 ? "#10b981" : "#ef4444" }}>
                                                {fmtPct(dQte)}
                                            </span>
                                        ) : "—"}
                                    </td>
                                    <td className="px-3 py-2 text-right">
                                        {txN !== null ? (
                                            <span style={{ color: txN >= 25 ? "#10b981" : txN >= 15 ? "#f59e0b" : "#ef4444" }}>
                                                {fmtPct(txN, false)}
                                            </span>
                                        ) : "—"}
                                    </td>
                                    <td className="px-4 py-2">
                                        <div className="flex flex-col gap-0.5">
                                            <div className="flex items-center gap-1">
                                                <span className="text-[10px] w-5 shrink-0" style={{ color: "var(--accent)" }}>N</span>
                                                <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ background: "var(--border)" }}>
                                                    <div className="h-full rounded-full" style={{ width: `${barN}%`, background: "var(--accent)" }} />
                                                </div>
                                            </div>
                                            <div className="flex items-center gap-1">
                                                <span className="text-[10px] w-5 shrink-0" style={{ color: "var(--text-muted)" }}>N-1</span>
                                                <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ background: "var(--border)" }}>
                                                    <div className="h-full rounded-full" style={{ width: `${barN1}%`, background: "var(--text-muted)" }} />
                                                </div>
                                            </div>
                                        </div>
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
        </div>
    );
}

// ---------------------------------------------------------------------------
// Page principale
// ---------------------------------------------------------------------------

export default async function DashboardPage() {
    let data;
    try {
        data = await pgGetDashboardData();
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("[Dashboard] pgGetDashboardData failed:", e);
        return (
            <div className="p-8 text-center">
                <p className="text-sm" style={{ color: "var(--text-muted)" }}>
                    Impossible de charger le tableau de bord : {msg.slice(0, 500)}
                </p>
            </div>
        );
    }

    const { dateHier, sites, top10Ca, top10Qte, top10Marge, evolution, debug } = data;

    // Totaux réseau
    const totalCa = sites.reduce((s, r) => s + r.ca_hier, 0);
    const totalCaN1 = sites.reduce((s, r) => s + r.ca_n1, 0);
    const totalTickets = sites.reduce((s, r) => s + r.tickets_hier, 0);
    const totalTicketsN1 = sites.reduce((s, r) => s + r.tickets_n1, 0);
    const totalQte = sites.reduce((s, r) => s + r.qte_hier, 0);
    const totalMarge = sites.reduce((s, r) => s + r.marge_hier, 0);
    const txMarge = totalCa > 0 ? (totalMarge / totalCa) * 100 : 0;
    const totalLignes = sites.reduce((s, r) => s + r.lignes_hier, 0);

    return (
        <div className="flex flex-col gap-6 p-6 pb-12 max-w-screen-2xl mx-auto">
            {/* Header */}
            <div>
                <h1 className="text-2xl font-bold tracking-tight" style={{ color: "var(--text-primary)" }}>
                    Tableau de Bord
                </h1>
                <p className="text-sm mt-0.5" style={{ color: "var(--text-muted)" }}>
                    Données du <span className="font-semibold" style={{ color: "var(--text-secondary)" }}>{dateLabel(dateHier)}</span>
                    {" "}· Comparaison vs même date N-1
                </p>
            </div>

            {/* Debug probe — à supprimer une fois les colonnes confirmées */}
            <div className="rounded-lg px-4 py-2 text-xs font-mono break-all" style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)", color: "var(--text-muted)" }}>
                🔍 cumstat=&quot;{debug.cumstatCol ?? "∅"}&quot; · mvtart={debug.mvtartCount} · statop_rows={debug.statopCount} · {debug.extra}<br/>
                cols=[{debug.statopCols.join(" | ")}]
            </div>

            {/* KPI réseau */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <KpiCard
                    label="CA Réseau"
                    value={fmtEur(totalCa)}
                    delta={delta(totalCa, totalCaN1)}
                    sub={`N-1 : ${fmtEur(totalCaN1)}`}
                    icon={Euro}
                />
                <KpiCard
                    label="Trafic (tickets)"
                    value={fmtQte(totalTickets)}
                    delta={delta(totalTickets, totalTicketsN1)}
                    sub={`N-1 : ${fmtQte(totalTicketsN1)}`}
                    icon={Users}
                />
                <KpiCard
                    label="Marge Brute"
                    value={fmtEur(totalMarge)}
                    sub={`${fmtQte(totalQte)} articles · ${fmtQte(totalLignes)} lignes`}
                    icon={TrendingUp}
                />
                <KpiCard
                    label="Taux de Marge"
                    value={fmtPct(txMarge, false)}
                    icon={Percent}
                />
            </div>

            {/* Par magasin */}
            <div>
                <h2 className="text-sm font-semibold mb-3 uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
                    Par magasin
                </h2>
                {sites.length === 0 ? (
                    <p className="text-sm" style={{ color: "var(--text-muted)" }}>Aucune donnée pour hier.</p>
                ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {sites.map(s => <SiteCard key={s.site} site={s} />)}
                    </div>
                )}
            </div>

            {/* Hit Parade */}
            <div>
                <h2 className="text-sm font-semibold mb-3 uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
                    Hit Parade — réseau · {dateLabel(dateHier)}
                </h2>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <Top10Table title="Top 10 Chiffre d'affaires" items={top10Ca} sortKey="ca" />
                    <Top10Table title="Top 10 Quantité vendue" items={top10Qte} sortKey="qte" />
                    <Top10Table title="Top 10 Marge brute" items={top10Marge} sortKey="marge" />
                </div>
            </div>

            {/* Évolution N/N-1 */}
            <div>
                <h2 className="text-sm font-semibold mb-3 uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
                    Évolution annuelle
                </h2>
                <EvolutionTable evolution={evolution} />
            </div>
        </div>
    );
}
