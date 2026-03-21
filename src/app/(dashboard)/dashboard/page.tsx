import { pgGetDashboardData, type DashboardTopItem, type DashboardSiteStats, type DashboardSiteTop10 } from "@/lib/pg-ff-client";
import { TrendingUp, TrendingDown, Minus, Store, Euro, Users } from "lucide-react";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SITE_NAMES: Record<string, string> = {
    "F01": "Frouard",
    "F02": "Houdemont",
    "292": "Frouard",
    "579": "Houdemont",
};

function fmtEur(n: number): string {
    const abs = Math.abs(n);
    if (abs >= 1_000_000) return `${(n / 1_000_000).toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} M€`;
    return `${n.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
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

function dateLabel(iso: string): string {
    const [y, m, d] = iso.split("-");
    return `${d}/${m}/${y}`;
}

// ---------------------------------------------------------------------------
// Sub-components
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
            </div>
        </div>
    );
}

function Top10Table({ title, items, sortKey }: {
    title: string; items: DashboardTopItem[]; sortKey: "ca" | "qte" | "marge";
}) {
    const maxVal = items[0]?.[sortKey] ?? 1;
    return (
        <div className="rounded-xl flex flex-col" style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)" }}>
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
                                    {sortKey === "ca" && `${fmtQte(item.qte)} pcs · `}
                                    {sortKey !== "ca" && `CA ${fmtEur(item.ca)} · `}
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

function SiteHitParade({ siteData, dateHier }: { siteData: DashboardSiteTop10; dateHier: string }) {
    const name = SITE_NAMES[siteData.site] ?? siteData.site;
    return (
        <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
                <Store className="w-4 h-4" style={{ color: "var(--accent)" }} />
                <h3 className="text-sm font-bold" style={{ color: "var(--text-primary)" }}>{name}</h3>
                <span className="text-xs" style={{ color: "var(--text-muted)" }}>· {dateLabel(dateHier)}</span>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <Top10Table title="Top 10 CA" items={siteData.ca} sortKey="ca" />
                <Top10Table title="Top 10 Quantité" items={siteData.qte} sortKey="qte" />
                <Top10Table title="Top 10 Marge" items={siteData.marge} sortKey="marge" />
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

    const { dateHier, dateN1, sites, top10BySite } = data;

    const totalCa = sites.reduce((s, r) => s + r.ca_hier, 0);
    const totalCaN1 = sites.reduce((s, r) => s + r.ca_n1, 0);
    const totalTickets = sites.reduce((s, r) => s + r.tickets_hier, 0);
    const totalTicketsN1 = sites.reduce((s, r) => s + r.tickets_n1, 0);

    return (
        <div className="flex flex-col gap-6 pb-12">
            {/* Header */}
            <div>
                <h1 className="text-2xl font-bold tracking-tight" style={{ color: "var(--text-primary)" }}>
                    Tableau de Bord
                </h1>
                <p className="text-sm mt-0.5" style={{ color: "var(--text-muted)" }}>
                    Données du <span className="font-semibold" style={{ color: "var(--text-secondary)" }}>{dateLabel(dateHier)}</span>
                    {" "}· Comparaison vs même jour de semaine N-1
                    {dateN1 && <span> ({dateLabel(dateN1)})</span>}
                </p>
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
                    label="Magasins actifs"
                    value={`${sites.length}`}
                    sub={sites.map(s => SITE_NAMES[s.site] ?? s.site).join(" · ")}
                    icon={TrendingUp}
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

            {/* Hit Parade par magasin */}
            <div>
                <h2 className="text-sm font-semibold mb-4 uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
                    Hit Parade par magasin
                </h2>
                {top10BySite.length === 0 ? (
                    <p className="text-sm" style={{ color: "var(--text-muted)" }}>Aucune donnée pour hier.</p>
                ) : (
                    <div className="flex flex-col gap-8">
                        {top10BySite.map(s => (
                            <SiteHitParade key={s.site} siteData={s} dateHier={dateHier} />
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}
