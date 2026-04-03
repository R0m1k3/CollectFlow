import { pgGetDashboardData, type DashboardTopItem, type DashboardSiteStats, type DashboardSiteTop10 } from "@/lib/pg-ff-client";
import { unstable_cache } from "next/cache";

const getCachedDashboardData = unstable_cache(
    pgGetDashboardData,
    ["dashboard-data"],
    { revalidate: 600 } // 10 minutes
);
import { TrendingUp, TrendingDown, Minus, Store, Euro, Users, ShoppingCart, Award, BarChart3 } from "lucide-react";

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
// Design tokens (inline color helpers)
// ---------------------------------------------------------------------------

const clrPositive = "#22c55e";
const clrNegative = "#ef4444";
const clrGold = "#f59e0b";
const clrSilver = "#94a3b8";
const clrBronze = "#cd7c2b";

const tableAccents = {
    ca: { bar: "#3b82f6", header: "rgba(59,130,246,0.12)", border: "rgba(59,130,246,0.3)", label: "#60a5fa" },
    qte: { bar: "#8b5cf6", header: "rgba(139,92,246,0.12)", border: "rgba(139,92,246,0.3)", label: "#a78bfa" },
    marge: { bar: "#10b981", header: "rgba(16,185,129,0.12)", border: "rgba(16,185,129,0.3)", label: "#34d399" },
};

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function DeltaBadge({ pct, large = false }: { pct: number | null; large?: boolean }) {
    if (pct === null) return <span style={{ color: "var(--text-muted)", fontSize: large ? "0.9rem" : "0.7rem" }}>—</span>;
    const isPos = pct >= 0;
    const Icon = pct > 0.5 ? TrendingUp : pct < -0.5 ? TrendingDown : Minus;
    const color = isPos ? clrPositive : clrNegative;
    const bg = isPos ? "rgba(34,197,94,0.1)" : "rgba(239,68,68,0.1)";
    const borderClr = isPos ? "rgba(34,197,94,0.25)" : "rgba(239,68,68,0.25)";
    return (
        <span
            className="inline-flex items-center gap-1 font-bold"
            style={{
                color,
                background: bg,
                border: `1px solid ${borderClr}`,
                borderRadius: "9999px",
                padding: large ? "0.25rem 0.75rem" : "0.15rem 0.5rem",
                fontSize: large ? "0.95rem" : "0.7rem",
                letterSpacing: "-0.01em",
            }}
        >
            <Icon style={{ width: large ? "1rem" : "0.7rem", height: large ? "1rem" : "0.7rem" }} />
            {fmtPct(pct)}
        </span>
    );
}

function NetworkKpiCard({
    label, value, valueSub, delta: d, n1Value, n1Label, dateHier, dateN1, icon: Icon, accentColor,
}: {
    label: string;
    value: string;
    valueSub?: string;
    delta?: number | null;
    n1Value: string;
    n1Label: string;
    dateHier: string;
    dateN1: string;
    icon: React.ComponentType<{ style?: React.CSSProperties }>;
    accentColor: string;
}) {
    return (
        <div
            className="rounded-2xl flex flex-col gap-5"
            style={{
                background: "var(--bg-elevated)",
                border: "1px solid var(--border)",
                padding: "1.5rem",
                position: "relative",
                overflow: "hidden",
                boxShadow: "0 4px 24px rgba(0,0,0,0.18), 0 1px 4px rgba(0,0,0,0.12)",
            }}
        >
            {/* Decorative glow */}
            <div style={{
                position: "absolute",
                top: "-30px",
                right: "-30px",
                width: "120px",
                height: "120px",
                borderRadius: "50%",
                background: `radial-gradient(circle, ${accentColor}22 0%, transparent 70%)`,
                pointerEvents: "none",
            }} />

            <div className="flex items-start justify-between">
                <div className="flex flex-col gap-1">
                    <span
                        className="text-xs font-semibold uppercase tracking-widest"
                        style={{ color: "var(--text-muted)", letterSpacing: "0.1em" }}
                    >
                        {label}
                    </span>
                    <div className="flex items-baseline gap-2" style={{ marginTop: "0.25rem" }}>
                        <span
                            className="font-bold tracking-tight"
                            style={{ fontSize: "2rem", lineHeight: 1, color: "var(--text-primary)" }}
                        >
                            {value}
                        </span>
                        {valueSub && (
                            <span style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>{valueSub}</span>
                        )}
                    </div>
                </div>
                <div
                    className="flex items-center justify-center rounded-xl shrink-0"
                    style={{
                        width: "2.75rem",
                        height: "2.75rem",
                        background: `${accentColor}18`,
                        border: `1px solid ${accentColor}30`,
                    }}
                >
                    <Icon style={{ width: "1.25rem", height: "1.25rem", color: accentColor }} />
                </div>
            </div>

            {/* Delta badge */}
            {d !== undefined && (
                <div className="flex items-center gap-3">
                    <DeltaBadge pct={d} large />
                    <span style={{ fontSize: "0.78rem", color: "var(--text-muted)" }}>
                        vs même jour N-1
                    </span>
                </div>
            )}

            {/* Divider */}
            <div style={{ height: "1px", background: "var(--border)", margin: "0 -1.5rem" }} />

            {/* N-1 comparison row */}
            <div className="flex items-center justify-between">
                <div className="flex flex-col gap-0.5">
                    <span style={{ fontSize: "0.68rem", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.07em" }}>
                        Hier — {dateHier}
                    </span>
                    <span style={{ fontSize: "1rem", fontWeight: 600, color: "var(--text-secondary)" }}>
                        {value}
                    </span>
                </div>
                <div style={{ width: "1px", height: "2rem", background: "var(--border)" }} />
                <div className="flex flex-col gap-0.5 items-end">
                    <span style={{ fontSize: "0.68rem", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.07em" }}>
                        N-1 — {dateN1}
                    </span>
                    <span style={{ fontSize: "1rem", fontWeight: 600, color: "var(--text-muted)" }}>
                        {n1Value}
                    </span>
                </div>
            </div>
        </div>
    );
}

function StoreCard({ site, dateHier, dateN1 }: { site: DashboardSiteStats; dateHier: string; dateN1: string }) {
    const name = SITE_NAMES[site.site] ?? site.site;
    const dCa = delta(site.ca_hier, site.ca_n1);
    const dTickets = delta(site.tickets_hier, site.tickets_n1);
    const isPos = dCa !== null && dCa >= 0;

    return (
        <div
            className="rounded-2xl flex flex-col"
            style={{
                background: "var(--bg-elevated)",
                border: "1px solid var(--border)",
                overflow: "hidden",
                position: "relative",
                boxShadow: "0 4px 24px rgba(0,0,0,0.18), 0 1px 4px rgba(0,0,0,0.12)",
            }}
        >
            {/* Top accent bar */}
            <div style={{
                height: "3px",
                background: isPos
                    ? "linear-gradient(90deg, #22c55e, #10b981)"
                    : "linear-gradient(90deg, #ef4444, #f97316)",
            }} />

            <div style={{ padding: "1.5rem", display: "flex", flexDirection: "column", gap: "1.25rem" }}>
                {/* Store header */}
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <div
                            className="rounded-xl flex items-center justify-center"
                            style={{
                                width: "2.5rem",
                                height: "2.5rem",
                                background: "var(--accent-bg)",
                                border: "1px solid var(--accent-border)",
                            }}
                        >
                            <Store style={{ width: "1.1rem", height: "1.1rem", color: "var(--accent)" }} />
                        </div>
                        <div>
                            <div style={{ fontSize: "1.05rem", fontWeight: 700, color: "var(--text-primary)", lineHeight: 1.2 }}>
                                {name}
                            </div>
                            <div style={{ fontSize: "0.7rem", color: "var(--text-muted)", marginTop: "0.1rem" }}>
                                Site {site.site}
                            </div>
                        </div>
                    </div>
                </div>

                {/* Metrics row */}
                <div
                    className="grid grid-cols-2 gap-4"
                >
                    {/* CA */}
                    <div
                        className="rounded-xl flex flex-col gap-2"
                        style={{ background: "rgba(59,130,246,0.06)", border: "1px solid rgba(59,130,246,0.15)", padding: "1rem" }}
                    >
                        <div className="flex items-center gap-1.5">
                            <Euro style={{ width: "0.8rem", height: "0.8rem", color: "#60a5fa" }} />
                            <span style={{ fontSize: "0.65rem", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", color: "#60a5fa" }}>
                                Chiffre d&apos;affaires
                            </span>
                        </div>
                        <div className="flex items-baseline gap-2">
                            <div style={{ fontSize: "1.35rem", fontWeight: 800, color: "var(--text-primary)", letterSpacing: "-0.02em", lineHeight: 1 }}>
                                {fmtEur(site.ca_hier)}
                            </div>
                            <DeltaBadge pct={dCa} large />
                        </div>
                        <div className="flex items-center gap-1.5">
                            <span style={{ fontSize: "0.7rem", color: "var(--text-muted)" }}>N-1 :</span>
                            <span style={{ fontSize: "0.75rem", fontWeight: 600, color: "var(--text-muted)" }}>
                                {site.ca_n1 > 0 ? fmtEur(site.ca_n1) : "—"}
                            </span>
                        </div>
                    </div>

                    {/* Tickets */}
                    <div
                        className="rounded-xl flex flex-col gap-2"
                        style={{ background: "rgba(139,92,246,0.06)", border: "1px solid rgba(139,92,246,0.15)", padding: "1rem" }}
                    >
                        <div className="flex items-center gap-1.5">
                            <Users style={{ width: "0.8rem", height: "0.8rem", color: "#a78bfa" }} />
                            <span style={{ fontSize: "0.65rem", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", color: "#a78bfa" }}>
                                Trafic tickets
                            </span>
                        </div>
                        <div style={{ fontSize: "1.35rem", fontWeight: 800, color: "var(--text-primary)", letterSpacing: "-0.02em", lineHeight: 1 }}>
                            {fmtQte(site.tickets_hier)}
                        </div>
                        <div className="flex items-center gap-1.5">
                            <DeltaBadge pct={dTickets} />
                            {site.tickets_n1 > 0 && (
                                <span style={{ fontSize: "0.7rem", color: "var(--text-muted)" }}>
                                    N-1 : {fmtQte(site.tickets_n1)}
                                </span>
                            )}
                        </div>
                    </div>
                </div>

                {/* Date footer */}
                <div
                    className="flex items-center justify-between rounded-lg"
                    style={{ background: "var(--bg-base)", border: "1px solid var(--border)", padding: "0.5rem 0.75rem" }}
                >
                    <span style={{ fontSize: "0.68rem", color: "var(--text-muted)" }}>
                        Hier : <strong style={{ color: "var(--text-secondary)" }}>{dateLabel(dateHier)}</strong>
                    </span>
                    <span style={{ fontSize: "0.68rem", color: "var(--text-muted)" }}>
                        N-1 : <strong style={{ color: "var(--text-secondary)" }}>{dateLabel(dateN1)}</strong>
                    </span>
                </div>
            </div>
        </div>
    );
}

function RankBadge({ rank }: { rank: number }) {
    if (rank === 0) return (
        <span style={{
            width: "1.4rem", height: "1.4rem", borderRadius: "50%",
            background: "linear-gradient(135deg, #f59e0b, #d97706)",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: "0.6rem", fontWeight: 800, color: "#fff", flexShrink: 0,
            boxShadow: "0 0 8px rgba(245,158,11,0.5)",
        }}>1</span>
    );
    if (rank === 1) return (
        <span style={{
            width: "1.4rem", height: "1.4rem", borderRadius: "50%",
            background: "linear-gradient(135deg, #94a3b8, #64748b)",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: "0.6rem", fontWeight: 800, color: "#fff", flexShrink: 0,
        }}>2</span>
    );
    if (rank === 2) return (
        <span style={{
            width: "1.4rem", height: "1.4rem", borderRadius: "50%",
            background: "linear-gradient(135deg, #cd7c2b, #a05c1e)",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: "0.6rem", fontWeight: 800, color: "#fff", flexShrink: 0,
        }}>3</span>
    );
    return (
        <span style={{
            width: "1.4rem", height: "1.4rem", borderRadius: "50%",
            background: "var(--bg-base)",
            border: "1px solid var(--border)",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: "0.6rem", fontWeight: 600, color: "var(--text-muted)", flexShrink: 0,
        }}>{rank + 1}</span>
    );
}

function Top10Table({ title, items, sortKey, accent }: {
    title: string;
    items: DashboardTopItem[];
    sortKey: "ca" | "qte" | "marge";
    accent: typeof tableAccents.ca;
}) {
    return (
        <div
            style={{
                background: "var(--bg-elevated)",
                border: `1px solid ${accent.border}`,
                borderRadius: "1rem",
                overflow: "hidden",
                flex: 1,
                minWidth: 0,
                boxShadow: "0 4px 24px rgba(0,0,0,0.22), 0 1px 6px rgba(0,0,0,0.14)",
                display: "flex",
                flexDirection: "column",
            }}
        >
            {/* ── Header strip ── */}
            <div
                style={{
                    background: accent.header,
                    borderBottom: `1px solid ${accent.border}`,
                    padding: "0.625rem 0.875rem",
                    display: "flex",
                    alignItems: "center",
                    gap: "0.5rem",
                }}
            >
                <div
                    style={{
                        width: "1.6rem",
                        height: "1.6rem",
                        borderRadius: "0.4rem",
                        background: `${accent.bar}22`,
                        border: `1px solid ${accent.bar}44`,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        flexShrink: 0,
                    }}
                >
                    {sortKey === "ca" && <Euro style={{ width: "0.75rem", height: "0.75rem", color: accent.bar }} />}
                    {sortKey === "qte" && <ShoppingCart style={{ width: "0.75rem", height: "0.75rem", color: accent.bar }} />}
                    {sortKey === "marge" && <BarChart3 style={{ width: "0.75rem", height: "0.75rem", color: accent.bar }} />}
                </div>
                <span style={{
                    fontSize: "0.7rem",
                    fontWeight: 700,
                    color: accent.label,
                    textTransform: "uppercase" as const,
                    letterSpacing: "0.09em",
                }}>
                    {title}
                </span>
                {/* column labels */}
                <div style={{ marginLeft: "auto", display: "flex", gap: "0.5rem", alignItems: "center" }}>
                    {sortKey === "ca" && (
                        <>
                            <span style={{ fontSize: "0.6rem", color: accent.label, opacity: 0.7, fontVariantNumeric: "tabular-nums" as const, letterSpacing: "0.05em" }}>QTÉ</span>
                            <span style={{ fontSize: "0.6rem", color: accent.label, opacity: 0.7, letterSpacing: "0.05em", marginLeft: "0.5rem" }}>CA</span>
                        </>
                    )}
                    {sortKey === "qte" && (
                        <span style={{ fontSize: "0.6rem", color: accent.label, opacity: 0.7, letterSpacing: "0.05em" }}>QTÉ</span>
                    )}
                    {sortKey === "marge" && (
                        <span style={{ fontSize: "0.6rem", color: accent.label, opacity: 0.7, letterSpacing: "0.05em" }}>MARGE</span>
                    )}
                </div>
            </div>

            {/* ── Rows ── */}
            {items.length === 0 ? (
                <div style={{ padding: "2rem", textAlign: "center", fontSize: "0.78rem", color: "var(--text-muted)" }}>
                    Aucune donnée
                </div>
            ) : (
                items.map((item, i) => {
                    const txMarge = item.ca > 0 ? (item.marge / item.ca) * 100 : 0;
                    const margeColor = txMarge > 25 ? "#22c55e" : txMarge > 15 ? "#f59e0b" : "var(--text-muted)";
                    const margeBg = txMarge > 25 ? "rgba(34,197,94,0.1)" : txMarge > 15 ? "rgba(245,158,11,0.1)" : "rgba(100,116,139,0.1)";
                    const margeBorder = txMarge > 25 ? "rgba(34,197,94,0.25)" : txMarge > 15 ? "rgba(245,158,11,0.25)" : "rgba(100,116,139,0.18)";
                    const isEven = i % 2 === 0;
                    const isTopThree = i < 3;

                    return (
                        <div
                            key={item.codein}
                            style={{
                                padding: "0.45rem 0.875rem",
                                borderBottom: i < items.length - 1 ? "1px solid var(--border)" : undefined,
                                background: isEven ? "transparent" : "rgba(255,255,255,0.022)",
                                display: "flex",
                                flexDirection: "column",
                                gap: "0.2rem",
                            }}
                        >
                            {/* ── Primary row: rank + name + main value ── */}
                            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", minWidth: 0 }}>
                                <RankBadge rank={i} />

                                <span
                                    title={item.libelle1}
                                    style={{
                                        flex: 1,
                                        fontSize: "0.775rem",
                                        fontWeight: isTopThree ? 600 : 400,
                                        color: isTopThree ? "var(--text-primary)" : "var(--text-secondary)",
                                        overflow: "hidden",
                                        textOverflow: "ellipsis",
                                        whiteSpace: "nowrap",
                                        minWidth: 0,
                                        lineHeight: 1.3,
                                    }}
                                >
                                    {item.libelle1 ?? item.codein}
                                </span>

                                {/* Main sort-key value */}
                                <span style={{
                                    fontSize: "0.825rem",
                                    fontWeight: 700,
                                    color: isTopThree ? "var(--text-primary)" : "var(--text-secondary)",
                                    flexShrink: 0,
                                    fontVariantNumeric: "tabular-nums" as const,
                                    fontFamily: "ui-monospace, 'Cascadia Code', 'Fira Code', monospace",
                                    letterSpacing: "-0.01em",
                                }}>
                                    {sortKey === "qte"
                                        ? `${fmtQte(item.qte)} pcs`
                                        : sortKey === "marge"
                                        ? fmtEur(item.marge)
                                        : fmtEur(item.ca)}
                                </span>
                            </div>

                            {/* ── Secondary info row ── */}
                            <div style={{
                                display: "flex",
                                alignItems: "center",
                                gap: "0.5rem",
                                paddingLeft: "1.9rem",
                                flexWrap: "wrap" as const,
                            }}>
                                {/* For CA table: show qte + marge */}
                                {sortKey === "ca" && (
                                    <>
                                        <span style={{
                                            fontSize: "0.65rem",
                                            color: "var(--text-muted)",
                                            fontVariantNumeric: "tabular-nums" as const,
                                            fontFamily: "ui-monospace, 'Cascadia Code', 'Fira Code', monospace",
                                        }}>
                                            {fmtQte(item.qte)}&thinsp;pcs
                                        </span>
                                        <span style={{ fontSize: "0.55rem", color: "var(--border)", lineHeight: 1 }}>│</span>
                                        <span style={{
                                            fontSize: "0.65rem",
                                            color: "var(--text-muted)",
                                            fontVariantNumeric: "tabular-nums" as const,
                                            fontFamily: "ui-monospace, 'Cascadia Code', 'Fira Code', monospace",
                                        }}>
                                            mg&thinsp;{fmtEur(item.marge)}
                                        </span>
                                    </>
                                )}

                                {/* For QTE table: show CA + marge */}
                                {sortKey === "qte" && (
                                    <>
                                        <span style={{
                                            fontSize: "0.65rem",
                                            color: "var(--text-muted)",
                                            fontVariantNumeric: "tabular-nums" as const,
                                            fontFamily: "ui-monospace, 'Cascadia Code', 'Fira Code', monospace",
                                        }}>
                                            CA&thinsp;{fmtEur(item.ca)}
                                        </span>
                                        <span style={{ fontSize: "0.55rem", color: "var(--border)", lineHeight: 1 }}>│</span>
                                        <span style={{
                                            fontSize: "0.65rem",
                                            color: "var(--text-muted)",
                                            fontVariantNumeric: "tabular-nums" as const,
                                            fontFamily: "ui-monospace, 'Cascadia Code', 'Fira Code', monospace",
                                        }}>
                                            mg&thinsp;{fmtEur(item.marge)}
                                        </span>
                                    </>
                                )}

                                {/* For Marge table: show CA + qte */}
                                {sortKey === "marge" && (
                                    <>
                                        <span style={{
                                            fontSize: "0.65rem",
                                            color: "var(--text-muted)",
                                            fontVariantNumeric: "tabular-nums" as const,
                                            fontFamily: "ui-monospace, 'Cascadia Code', 'Fira Code', monospace",
                                        }}>
                                            CA&thinsp;{fmtEur(item.ca)}
                                        </span>
                                        <span style={{ fontSize: "0.55rem", color: "var(--border)", lineHeight: 1 }}>│</span>
                                        <span style={{
                                            fontSize: "0.65rem",
                                            color: "var(--text-muted)",
                                            fontVariantNumeric: "tabular-nums" as const,
                                            fontFamily: "ui-monospace, 'Cascadia Code', 'Fira Code', monospace",
                                        }}>
                                            {fmtQte(item.qte)}&thinsp;pcs
                                        </span>
                                    </>
                                )}

                                {/* Taux de marge pill — always shown */}
                                <span style={{
                                    marginLeft: "auto",
                                    fontSize: "0.6rem",
                                    fontWeight: 600,
                                    color: margeColor,
                                    background: margeBg,
                                    border: `1px solid ${margeBorder}`,
                                    borderRadius: "9999px",
                                    padding: "0.1rem 0.375rem",
                                    fontVariantNumeric: "tabular-nums" as const,
                                    letterSpacing: "0.01em",
                                    flexShrink: 0,
                                }}>
                                    {fmtPct(txMarge, false)}
                                </span>
                            </div>
                        </div>
                    );
                })
            )}
        </div>
    );
}

function SiteHitParade({ siteData, dateHier }: { siteData: DashboardSiteTop10; dateHier: string }) {
    const name = SITE_NAMES[siteData.site] ?? siteData.site;

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
            {/* ── Section header ── */}
            <div
                style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "1rem",
                    background: "var(--bg-elevated)",
                    border: "1px solid var(--border)",
                    borderRadius: "0.875rem",
                    padding: "0.875rem 1.25rem",
                    boxShadow: "0 4px 24px rgba(0,0,0,0.22), 0 1px 6px rgba(0,0,0,0.14)",
                    position: "relative" as const,
                    overflow: "hidden",
                }}
            >
                {/* subtle glow behind icon */}
                <div style={{
                    position: "absolute",
                    left: "-10px",
                    top: "-10px",
                    width: "80px",
                    height: "80px",
                    borderRadius: "50%",
                    background: `radial-gradient(circle, ${clrGold}18 0%, transparent 70%)`,
                    pointerEvents: "none",
                }} />

                <div
                    style={{
                        width: "2.5rem",
                        height: "2.5rem",
                        borderRadius: "0.625rem",
                        background: `${clrGold}15`,
                        border: `1px solid ${clrGold}35`,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        flexShrink: 0,
                        position: "relative" as const,
                    }}
                >
                    <Award style={{ width: "1.1rem", height: "1.1rem", color: clrGold }} />
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: "0.1rem" }}>
                    <div style={{ display: "flex", alignItems: "baseline", gap: "0.5rem" }}>
                        <h3 style={{
                            fontSize: "1.05rem",
                            fontWeight: 800,
                            color: "var(--text-primary)",
                            lineHeight: 1,
                            letterSpacing: "-0.02em",
                            margin: 0,
                        }}>
                            Hit Parade
                        </h3>
                        <span style={{
                            fontSize: "1.05rem",
                            fontWeight: 800,
                            color: clrGold,
                            lineHeight: 1,
                            letterSpacing: "-0.02em",
                        }}>
                            {name}
                        </span>
                    </div>
                    <p style={{ fontSize: "0.68rem", color: "var(--text-muted)", margin: 0 }}>
                        Données du {dateLabel(dateHier)}&ensp;·&ensp;Site {siteData.site}
                        &ensp;·&ensp;Top 10 produits par CA, Quantité et Marge
                    </p>
                </div>

                {/* Store badge */}
                <div style={{
                    marginLeft: "auto",
                    display: "flex",
                    alignItems: "center",
                    gap: "0.4rem",
                    background: "var(--accent-bg)",
                    border: "1px solid var(--accent-border)",
                    borderRadius: "0.5rem",
                    padding: "0.3rem 0.625rem",
                    flexShrink: 0,
                }}>
                    <Store style={{ width: "0.75rem", height: "0.75rem", color: "var(--accent)" }} />
                    <span style={{ fontSize: "0.7rem", fontWeight: 600, color: "var(--accent)" }}>{name}</span>
                </div>
            </div>

            {/* ── Three tables side by side ── */}
            <div
                className="grid grid-cols-1 md:grid-cols-3 gap-4"
                style={{ alignItems: "start" }}
            >
                <Top10Table title="Top CA" items={siteData.ca} sortKey="ca" accent={tableAccents.ca} />
                <Top10Table title="Top Quantité" items={siteData.qte} sortKey="qte" accent={tableAccents.qte} />
                <Top10Table title="Top Marge" items={siteData.marge} sortKey="marge" accent={tableAccents.marge} />
            </div>
        </div>
    );
}

// ---------------------------------------------------------------------------
// Section divider
// ---------------------------------------------------------------------------

function SectionHeader({ label, sub }: { label: string; sub?: string }) {
    return (
        <div className="flex items-end justify-between" style={{ paddingBottom: "0.75rem", borderBottom: "1px solid var(--border)" }}>
            <div>
                <h2 style={{ fontSize: "0.65rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.12em", color: "var(--text-muted)" }}>
                    {label}
                </h2>
                {sub && <p style={{ fontSize: "0.78rem", color: "var(--text-secondary)", marginTop: "0.15rem" }}>{sub}</p>}
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
        data = await getCachedDashboardData();
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("[Dashboard] pgGetDashboardData failed:", e);
        return (
            <div
                className="rounded-2xl flex flex-col items-center gap-3"
                style={{
                    margin: "3rem auto",
                    maxWidth: "480px",
                    background: "var(--bg-elevated)",
                    border: "1px solid var(--border)",
                    padding: "2.5rem",
                    textAlign: "center",
                }}
            >
                <div
                    className="rounded-xl flex items-center justify-center"
                    style={{ width: "3rem", height: "3rem", background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.25)" }}
                >
                    <TrendingDown style={{ width: "1.25rem", height: "1.25rem", color: "#ef4444" }} />
                </div>
                <p style={{ fontSize: "0.85rem", color: "var(--text-muted)" }}>
                    Impossible de charger le tableau de bord
                </p>
                <p style={{ fontSize: "0.72rem", color: "var(--text-muted)", fontFamily: "monospace" }}>
                    {msg.slice(0, 300)}
                </p>
            </div>
        );
    }

    const { dateHier, dateN1, sites, top10BySite } = data;

    const totalCa = sites.reduce((s, r) => s + r.ca_hier, 0);
    const totalCaN1 = sites.reduce((s, r) => s + r.ca_n1, 0);
    const totalTickets = sites.reduce((s, r) => s + r.tickets_hier, 0);
    const totalTicketsN1 = sites.reduce((s, r) => s + r.tickets_n1, 0);

    const dCaReseau = delta(totalCa, totalCaN1);
    const dTicketsReseau = delta(totalTickets, totalTicketsN1);

    const dHier = dateLabel(dateHier);
    const dN1 = dateN1 ? dateLabel(dateN1) : "—";

    return (
        <div className="flex flex-col gap-10 pb-16" style={{ width: "100%" }}>

            {/* ── PAGE HEADER ─────────────────────────────────────────────── */}
            <div
                className="flex items-start justify-between rounded-2xl"
                style={{
                    background: "var(--bg-elevated)",
                    border: "1px solid var(--border)",
                    padding: "1.5rem 2rem",
                    position: "relative",
                    overflow: "hidden",
                    boxShadow: "0 4px 24px rgba(0,0,0,0.18), 0 1px 4px rgba(0,0,0,0.12)",
                }}
            >
                {/* subtle background pattern */}
                <div style={{
                    position: "absolute", inset: 0, pointerEvents: "none",
                    background: "radial-gradient(ellipse 60% 80% at 90% 50%, var(--accent-bg) 0%, transparent 70%)",
                }} />

                <div style={{ position: "relative" }}>
                    <h1
                        className="font-bold tracking-tight"
                        style={{ fontSize: "1.75rem", color: "var(--text-primary)", lineHeight: 1 }}
                    >
                        Tableau de Bord
                    </h1>
                    <p style={{ fontSize: "0.82rem", color: "var(--text-muted)", marginTop: "0.4rem" }}>
                        Données du{" "}
                        <strong style={{ color: "var(--text-secondary)" }}>{dHier}</strong>
                        {" · "}
                        Comparaison vs même jour de semaine N-1{" "}
                        <strong style={{ color: "var(--text-secondary)" }}>({dN1})</strong>
                    </p>
                </div>

                <div
                    className="flex items-center gap-2 rounded-xl shrink-0"
                    style={{
                        position: "relative",
                        background: "var(--accent-bg)",
                        border: "1px solid var(--accent-border)",
                        padding: "0.5rem 0.875rem",
                    }}
                >
                    <Store style={{ width: "0.85rem", height: "0.85rem", color: "var(--accent)" }} />
                    <span style={{ fontSize: "0.75rem", fontWeight: 600, color: "var(--accent)" }}>
                        {sites.length} magasin{sites.length > 1 ? "s" : ""} actif{sites.length > 1 ? "s" : ""}
                    </span>
                </div>
            </div>

            {/* ── KPI RÉSEAU ──────────────────────────────────────────────── */}
            <div className="flex flex-col gap-4">
                <SectionHeader label="Performance réseau" sub="Agrégat tous magasins — hier vs N-1" />

                <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                    <NetworkKpiCard
                        label="CA Réseau"
                        value={fmtEur(totalCa)}
                        delta={dCaReseau}
                        n1Value={fmtEur(totalCaN1)}
                        n1Label="N-1"
                        dateHier={dHier}
                        dateN1={dN1}
                        icon={Euro}
                        accentColor="#3b82f6"
                    />
                    <NetworkKpiCard
                        label="Trafic — Tickets"
                        value={fmtQte(totalTickets)}
                        delta={dTicketsReseau}
                        n1Value={fmtQte(totalTicketsN1)}
                        n1Label="N-1"
                        dateHier={dHier}
                        dateN1={dN1}
                        icon={Users}
                        accentColor="#8b5cf6"
                    />
                </div>
            </div>

            {/* ── PAR MAGASIN ─────────────────────────────────────────────── */}
            {sites.length > 0 && (
                <div className="flex flex-col gap-4">
                    <SectionHeader label="Détail par magasin" sub={`${sites.map(s => SITE_NAMES[s.site] ?? s.site).join(" · ")}`} />

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                        {sites.map(s => (
                            <StoreCard key={s.site} site={s} dateHier={dateHier} dateN1={dateN1 ?? dateHier} />
                        ))}
                    </div>
                </div>
            )}

            {/* ── HIT PARADE ──────────────────────────────────────────────── */}
            {top10BySite.length > 0 && (
                <div className="flex flex-col gap-8">
                    <SectionHeader label="Hit Parade produits" sub="Top 10 par CA, Quantité et Marge — par magasin" />

                    <div className="flex flex-col gap-10">
                        {top10BySite.map((s, idx) => (
                            <div key={s.site}>
                                {idx > 0 && (
                                    <div style={{ height: "1px", background: "var(--border)", marginBottom: "2.5rem" }} />
                                )}
                                <SiteHitParade siteData={s} dateHier={dateHier} />
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* ── EMPTY STATE ─────────────────────────────────────────────── */}
            {sites.length === 0 && (
                <div style={{ textAlign: "center", padding: "3rem", color: "var(--text-muted)", fontSize: "0.85rem" }}>
                    Aucune donnée disponible pour hier.
                </div>
            )}
        </div>
    );
}
