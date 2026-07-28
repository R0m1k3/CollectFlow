"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    Search, Loader2, AlertTriangle, PackageSearch, FileDown, Info,
    ChevronUp, ChevronDown, ChevronsUpDown, Store, Sparkles,
} from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
    computeNetworkTrend, TrendSparkline, NetworkLineChart, TREND_COLOR, trendLabel,
} from "@/features/network/components/network-trend";
import type { NetworkSearchJobState, NetworkSearchRow } from "@/types/network-search";
import { cn } from "@/lib/utils";

// ─── Formatage ────────────────────────────────────────────────────────────────
const fmtEur = (n?: number | null) =>
    n == null ? "-" : n.toLocaleString("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
const fmtNum = (n?: number | null) =>
    n == null ? "-" : Math.round(n).toLocaleString("fr-FR");
/** Qlik renvoie soit un ratio (0.32) soit déjà des points (32) — même règle que la Grille. */
const toPct = (v: number) => (Math.abs(v) <= 1 ? v * 100 : v);

// ─── Tri ──────────────────────────────────────────────────────────────────────
type SortKey = "libelle" | "codeCentrale" | "fournisseur" | "caReseau" | "qteReseau"
    | "nbMagasinsReseau" | "caParMagasinReseau" | "margePctReseau" | "trend" | "stockTotal";
type SortDir = "asc" | "desc";

/** Filtres : tout / seulement nos références / seulement les produits inconnus. */
type Filter = "all" | "mine" | "network";

export function RechercheReseauClient() {
    const [query, setQuery] = useState("");
    const [job, setJob] = useState<NetworkSearchJobState | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [elapsed, setElapsed] = useState(0);
    const [filter, setFilter] = useState<Filter>("all");
    const [sortKey, setSortKey] = useState<SortKey>("caReseau");
    const [sortDir, setSortDir] = useState<SortDir>("desc");
    const [modalRow, setModalRow] = useState<NetworkSearchRow | null>(null);
    const [exporting, setExporting] = useState(false);
    const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const isRunning = job?.status === "running";

    // ── Lancement de la recherche ─────────────────────────────────────────────
    const startSearch = useCallback(async () => {
        const q = query.trim();
        if (!q || isRunning) return;
        setError(null);
        setElapsed(0);
        try {
            const res = await fetch("/api/qlik/search", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ query: q }),
            });
            const data = await res.json();
            if (!res.ok) {
                setError(data.error ?? `Erreur ${res.status}`);
                return;
            }
            setJob(data as NetworkSearchJobState);
            setFilter("all");
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        }
    }, [query, isRunning]);

    // ── Polling tant que le job tourne ────────────────────────────────────────
    useEffect(() => {
        if (!isRunning || !job?.jobId) return;
        let cancelled = false;
        const tick = async () => {
            try {
                const res = await fetch(`/api/qlik/search?jobId=${encodeURIComponent(job.jobId!)}`);
                const data = await res.json();
                if (cancelled) return;
                if (res.ok) setJob(data as NetworkSearchJobState);
            } catch {
                // Réseau instable : on retentera au prochain tick.
            }
            if (!cancelled) pollRef.current = setTimeout(tick, 2000);
        };
        pollRef.current = setTimeout(tick, 1500);
        return () => {
            cancelled = true;
            if (pollRef.current) clearTimeout(pollRef.current);
        };
    }, [isRunning, job?.jobId]);

    // Chronomètre d'attente (l'extraction Qlik prend typiquement 20-40 s).
    useEffect(() => {
        if (!isRunning) return;
        const id = setInterval(() => setElapsed((e) => e + 1), 1000);
        return () => clearInterval(id);
    }, [isRunning]);

    const results = useMemo(() => job?.results ?? [], [job?.results]);
    const counts = useMemo(() => ({
        all: results.length,
        mine: results.filter((r) => r.chezMoi).length,
        network: results.filter((r) => !r.chezMoi).length,
    }), [results]);

    const rows = useMemo(() => {
        const filtered = results.filter((r) =>
            filter === "all" ? true : filter === "mine" ? r.chezMoi : !r.chezMoi);
        const dir = sortDir === "asc" ? 1 : -1;
        const val = (r: NetworkSearchRow): number | string => {
            switch (sortKey) {
                case "libelle": return r.libelle.toLowerCase();
                case "codeCentrale": return r.codeCentrale;
                case "fournisseur": return (r.fournisseur ?? r.nomfou ?? "").toLowerCase();
                case "trend": return computeNetworkTrend(r.qteByMonth).pct ?? -Infinity;
                case "stockTotal": return r.stockTotal ?? -1;
                default: return r[sortKey] ?? 0;
            }
        };
        return [...filtered].sort((a, b) => {
            const va = val(a), vb = val(b);
            if (typeof va === "string" || typeof vb === "string") {
                return String(va).localeCompare(String(vb), "fr") * dir;
            }
            return (va - vb) * dir;
        });
    }, [results, filter, sortKey, sortDir]);

    const toggleSort = (key: SortKey) => {
        if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
        else { setSortKey(key); setSortDir(key === "libelle" || key === "codeCentrale" || key === "fournisseur" ? "asc" : "desc"); }
    };

    // ── Export Excel ──────────────────────────────────────────────────────────
    const exportExcel = useCallback(async () => {
        if (!rows.length || exporting) return;
        setExporting(true);
        try {
            const ExcelJS = (await import("exceljs")).default;
            const wb = new ExcelJS.Workbook();
            const ws = wb.addWorksheet("Recherche réseau");
            // Colonnes mensuelles = union des mois présents, triée chronologiquement.
            const months = [...new Set(rows.flatMap((r) => Object.keys(r.qteByMonth ?? {})))].sort().slice(-12);
            ws.columns = [
                { header: "Libellé", key: "libelle", width: 46 },
                { header: "Code centrale", key: "code", width: 15 },
                { header: "Fournisseur", key: "fou", width: 24 },
                { header: "Famille", key: "fam", width: 20 },
                { header: "Statut", key: "statut", width: 18 },
                { header: "CA réseau", key: "ca", width: 14 },
                { header: "Qté réseau", key: "qte", width: 12 },
                { header: "Nb magasins", key: "nbmag", width: 12 },
                { header: "CA / magasin", key: "camag", width: 14 },
                { header: "Marge %", key: "marge", width: 10 },
                { header: "Code interne", key: "codein", width: 14 },
                { header: "Stock 292", key: "s292", width: 10 },
                { header: "Stock 579", key: "s579", width: 10 },
                ...months.map((m) => ({ header: m, key: `m_${m}`, width: 9 })),
            ];
            ws.getRow(1).font = { bold: true };
            for (const r of rows) {
                const monthCells: Record<string, number> = {};
                for (const m of months) monthCells[`m_${m}`] = r.qteByMonth?.[m] ?? 0;
                ws.addRow({
                    libelle: r.libelle,
                    code: r.codeCentrale,
                    fou: r.fournisseur ?? r.nomfou ?? "",
                    fam: r.famille ?? "",
                    statut: r.chezMoi ? "Chez moi" : "Réseau uniquement",
                    ca: Math.round(r.caReseau),
                    qte: Math.round(r.qteReseau),
                    nbmag: r.nbMagasinsReseau,
                    camag: Math.round(r.caParMagasinReseau),
                    marge: Number(toPct(r.margePctReseau).toFixed(1)),
                    codein: r.codein ?? "",
                    s292: r.stock292 ?? "",
                    s579: r.stock579 ?? "",
                    ...monthCells,
                });
            }
            const buffer = await wb.xlsx.writeBuffer();
            const blob = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `recherche-reseau-${(job?.query ?? "").replace(/[^\w-]+/g, "_").slice(0, 40)}.xlsx`;
            a.click();
            URL.revokeObjectURL(url);
        } finally {
            setExporting(false);
        }
    }, [rows, exporting, job?.query]);

    return (
        <div className="min-h-screen p-6" style={{ background: "var(--bg-base)" }}>
            <div className="mx-auto max-w-screen-2xl">
                {/* ── En-tête ── */}
                <div className="mb-5">
                    <h1 className="text-2xl font-bold flex items-center gap-2" style={{ color: "var(--text-primary)" }}>
                        <PackageSearch className="w-6 h-6" style={{ color: "var(--accent)" }} />
                        Recherche réseau
                    </h1>
                    <p className="text-[13px] mt-1" style={{ color: "var(--text-muted)" }}>
                        Cherche dans le catalogue <strong>Qlik du réseau</strong> — y compris les produits que nous ne
                        référençons pas. Ventes mois par mois sur 12 mois glissants.
                    </p>
                </div>

                {/* ── Barre de recherche ── */}
                <div className="rounded-2xl p-4 mb-4" style={{ background: "var(--bg-surface)", border: "1px solid var(--border)" }}>
                    <div className="flex flex-col sm:flex-row gap-2.5">
                        <div className="relative flex-1">
                            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 pointer-events-none" style={{ color: "var(--text-muted)" }} />
                            <input
                                value={query}
                                onChange={(e) => setQuery(e.target.value)}
                                onKeyDown={(e) => { if (e.key === "Enter") startSearch(); }}
                                placeholder="Nom du produit (ex. tapis anti) ou code centrale (ex. 10000459340)"
                                disabled={isRunning}
                                className="w-full rounded-xl pl-9 pr-3 py-2.5 text-[14px] outline-none disabled:opacity-60"
                                style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)", color: "var(--text-primary)" }}
                            />
                        </div>
                        <button
                            onClick={startSearch}
                            disabled={isRunning || !query.trim()}
                            className="rounded-xl px-5 py-2.5 text-[14px] font-semibold text-white disabled:opacity-50 flex items-center justify-center gap-2 shrink-0"
                            style={{ background: "var(--accent)" }}
                        >
                            {isRunning ? <><Loader2 className="w-4 h-4 animate-spin" /> Recherche… {elapsed}s</> : <><Search className="w-4 h-4" /> Rechercher</>}
                        </button>
                    </div>
                    <p className="text-[11px] mt-2 flex items-start gap-1.5" style={{ color: "var(--text-muted)" }}>
                        <Info className="w-3.5 h-3.5 shrink-0 mt-px" />
                        L&apos;interrogation de Qlik prend en général 20 à 40 secondes. Plusieurs codes centraux peuvent être
                        collés d&apos;un coup (séparés par des espaces ou des virgules).
                    </p>
                </div>

                {/* ── Erreurs ── */}
                {error && (
                    <div className="rounded-xl p-3.5 mb-4 flex items-start gap-2.5 text-[13px]"
                        style={{ background: "var(--accent-error-bg)", border: "1px solid var(--accent-error)", color: "var(--accent-error)" }}>
                        <AlertTriangle className="w-4 h-4 shrink-0 mt-px" />
                        <span>{error}</span>
                    </div>
                )}
                {job?.status === "error" && job.error && (
                    <div className="rounded-xl p-3.5 mb-4 flex items-start gap-2.5 text-[13px]"
                        style={{ background: "var(--accent-error-bg)", border: "1px solid var(--accent-error)", color: "var(--accent-error)" }}>
                        <AlertTriangle className="w-4 h-4 shrink-0 mt-px" />
                        <span>{job.error}</span>
                    </div>
                )}
                {job?.status === "success" && job.tooMany && (
                    <div className="rounded-xl p-3.5 mb-4 flex items-start gap-2.5 text-[13px]"
                        style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)", color: "var(--text-secondary)" }}>
                        <AlertTriangle className="w-4 h-4 shrink-0 mt-px" />
                        <span>
                            Recherche trop large : <strong>{job.matchCount}</strong> produits correspondent
                            {job.maxProducts ? <> (maximum {job.maxProducts})</> : null}. Précisez les termes pour
                            protéger le moteur Qlik.
                        </span>
                    </div>
                )}
                {job?.status === "success" && !job.tooMany && results.length === 0 && (
                    <div className="rounded-xl p-6 text-center text-[13px]"
                        style={{ background: "var(--bg-surface)", border: "1px solid var(--border)", color: "var(--text-muted)" }}>
                        Aucun produit trouvé dans Qlik pour « {job.query} ».
                    </div>
                )}

                {/* ── Résultats ── */}
                {results.length > 0 && (
                    <>
                        {/* Filtres + résumé + export */}
                        <div className="flex flex-wrap items-center gap-2 mb-3">
                            {([
                                { key: "all" as Filter, label: "Tous", n: counts.all },
                                { key: "mine" as Filter, label: "Chez moi", n: counts.mine },
                                { key: "network" as Filter, label: "Réseau uniquement", n: counts.network },
                            ]).map(({ key, label, n }) => (
                                <button
                                    key={key}
                                    onClick={() => setFilter(key)}
                                    className={cn("rounded-full px-3.5 py-1.5 text-[12px] font-semibold transition-colors")}
                                    style={{
                                        background: filter === key ? "var(--accent)" : "var(--bg-elevated)",
                                        color: filter === key ? "#fff" : "var(--text-secondary)",
                                        border: "1px solid var(--border)",
                                    }}
                                >
                                    {label} <span className="opacity-70">({n})</span>
                                </button>
                            ))}
                            <div className="flex-1" />
                            {job?.periode && (
                                <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>
                                    Période Qlik : {job.periode}
                                </span>
                            )}
                            <button
                                onClick={exportExcel}
                                disabled={exporting}
                                className="rounded-xl px-3 py-1.5 text-[12px] font-semibold flex items-center gap-1.5 disabled:opacity-50"
                                style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)", color: "var(--text-secondary)" }}
                            >
                                {exporting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileDown className="w-3.5 h-3.5" />}
                                Excel
                            </button>
                        </div>

                        {/* Bandeau opportunités : produits forts au réseau que nous n'avons pas */}
                        {counts.network > 0 && filter !== "mine" && (
                            <div className="rounded-xl p-3 mb-3 flex items-start gap-2.5 text-[12px]"
                                style={{ background: "var(--accent-bg)", border: "1px solid var(--accent-border)", color: "var(--text-secondary)" }}>
                                <Sparkles className="w-4 h-4 shrink-0 mt-px" style={{ color: "var(--accent)" }} />
                                <span>
                                    <strong>{counts.network}</strong> produit{counts.network > 1 ? "s" : ""} vendu
                                    {counts.network > 1 ? "s" : ""} par le réseau que nous ne référençons pas — trier par
                                    « CA / Mag » ou « Nb mag » fait remonter les meilleures opportunités d&apos;assortiment.
                                </span>
                            </div>
                        )}

                        <ResultsTable
                            rows={rows}
                            sortKey={sortKey}
                            sortDir={sortDir}
                            onSort={toggleSort}
                            onRowClick={setModalRow}
                        />
                    </>
                )}
            </div>

            <Dialog open={modalRow !== null} onOpenChange={(open) => { if (!open) setModalRow(null); }}>
                {modalRow !== null && <ProductDetailModal row={modalRow} />}
            </Dialog>
        </div>
    );
}

// ─── Tableau des résultats ────────────────────────────────────────────────────

const COLUMNS: Array<{ key: SortKey; label: string; sub?: string; align: "left" | "center" | "right" }> = [
    { key: "libelle", label: "Produit", align: "left" },
    { key: "codeCentrale", label: "Code centrale", align: "left" },
    { key: "fournisseur", label: "Fournisseur", align: "left" },
    { key: "caReseau", label: "CA", sub: "Réseau", align: "right" },
    { key: "qteReseau", label: "Qté", sub: "Réseau", align: "right" },
    { key: "nbMagasinsReseau", label: "Nb mag", sub: "Réseau", align: "right" },
    { key: "caParMagasinReseau", label: "CA / Mag", sub: "Réseau", align: "right" },
    { key: "margePctReseau", label: "Marge %", sub: "Réseau", align: "right" },
    { key: "trend", label: "Tendance", sub: "12 mois", align: "center" },
    { key: "stockTotal", label: "Stock", sub: "292 + 579", align: "right" },
];

function ResultsTable({ rows, sortKey, sortDir, onSort, onRowClick }: {
    rows: NetworkSearchRow[];
    sortKey: SortKey;
    sortDir: SortDir;
    onSort: (k: SortKey) => void;
    onRowClick: (r: NetworkSearchRow) => void;
}) {
    return (
        <div className="rounded-2xl overflow-hidden" style={{ background: "var(--bg-surface)", border: "1px solid var(--border)" }}>
            <div className="overflow-x-auto">
                <table className="w-full text-[12px] border-collapse">
                    <thead>
                        <tr style={{ background: "var(--bg-elevated)" }}>
                            {COLUMNS.map((c) => {
                                const active = sortKey === c.key;
                                const Icon = !active ? ChevronsUpDown : sortDir === "asc" ? ChevronUp : ChevronDown;
                                return (
                                    <th
                                        key={c.key}
                                        onClick={() => onSort(c.key)}
                                        className="px-3 py-2.5 font-semibold cursor-pointer select-none whitespace-nowrap"
                                        style={{ color: "var(--text-secondary)", borderBottom: "1px solid var(--border)", textAlign: c.align }}
                                    >
                                        <span className={cn("inline-flex items-center gap-1", c.align === "right" && "flex-row-reverse")}>
                                            <Icon className="w-3 h-3 shrink-0" style={{ opacity: active ? 1 : 0.35 }} />
                                            <span>
                                                {c.label}
                                                {c.sub && <><br /><span className="text-[9px] opacity-60 font-normal">{c.sub}</span></>}
                                            </span>
                                        </span>
                                    </th>
                                );
                            })}
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map((r) => {
                            const trend = computeNetworkTrend(r.qteByMonth);
                            const margePct = toPct(r.margePctReseau);
                            return (
                                <tr
                                    key={r.codeCentrale}
                                    onClick={() => onRowClick(r)}
                                    className="cursor-pointer hover:bg-[var(--bg-elevated)] transition-colors"
                                    style={{ borderBottom: "1px solid var(--border)" }}
                                >
                                    <td className="px-3 py-2 max-w-[380px]">
                                        <div className="font-medium truncate" style={{ color: "var(--text-primary)" }} title={r.libelle}>
                                            {r.libelle}
                                        </div>
                                        <span
                                            className="inline-block mt-0.5 rounded px-1.5 py-px text-[9px] font-bold uppercase tracking-wide"
                                            style={r.chezMoi
                                                ? { background: "var(--accent-bg)", color: "var(--accent)" }
                                                : { background: "rgba(245,158,11,0.15)", color: "#d97706" }}
                                        >
                                            {r.chezMoi ? `Chez moi${r.codein ? ` · ${r.codein}` : ""}` : "Réseau uniquement"}
                                        </span>
                                    </td>
                                    <td className="px-3 py-2 tabular-nums" style={{ color: "var(--text-secondary)" }}>{r.codeCentrale}</td>
                                    <td className="px-3 py-2 max-w-[180px] truncate" style={{ color: "var(--text-secondary)" }} title={r.fournisseur ?? r.nomfou ?? ""}>
                                        {r.fournisseur ?? r.nomfou ?? "-"}
                                    </td>
                                    <td className="px-3 py-2 text-right tabular-nums font-semibold" style={{ color: "var(--text-primary)" }}>{fmtEur(r.caReseau)}</td>
                                    <td className="px-3 py-2 text-right tabular-nums" style={{ color: "var(--text-secondary)" }}>{fmtNum(r.qteReseau)}</td>
                                    <td className="px-3 py-2 text-right tabular-nums" style={{ color: "var(--text-secondary)" }}>{fmtNum(r.nbMagasinsReseau)}</td>
                                    <td className="px-3 py-2 text-right tabular-nums font-semibold" style={{ color: "var(--text-secondary)" }}>{fmtEur(r.caParMagasinReseau)}</td>
                                    <td className={cn("px-3 py-2 text-right tabular-nums font-bold",
                                        margePct >= 30 ? "text-emerald-500" : margePct >= 15 ? "text-amber-500" : "text-rose-500")}>
                                        {margePct.toLocaleString("fr-FR", { maximumFractionDigits: 1 })}%
                                    </td>
                                    <td className="px-3 py-2"><TrendSparkline trend={trend} /></td>
                                    <td className="px-3 py-2 text-right tabular-nums" style={{ color: "var(--text-secondary)" }}>
                                        {r.chezMoi ? fmtNum(r.stockTotal ?? 0) : "-"}
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

// ─── Fiche produit ────────────────────────────────────────────────────────────

/** Détail d'un produit : courbe des ventes réseau 12 mois + informations Qlik / locales. */
function ProductDetailModal({ row }: { row: NetworkSearchRow }) {
    const trend = computeNetworkTrend(row.qteByMonth);
    const { values, labels, direction, pct } = trend;
    const color = TREND_COLOR[direction];
    const margePct = toPct(row.margePctReseau);

    const infos: Array<{ label: string; value: string }> = [
        { label: "Code centrale", value: row.codeCentrale },
        { label: "Fournisseur", value: row.fournisseur ?? row.nomfou ?? "-" },
        ...(row.famille ? [{ label: "Famille", value: row.famille }] : []),
        { label: "CA réseau", value: fmtEur(row.caReseau) },
        { label: "Qté réseau", value: fmtNum(row.qteReseau) },
        { label: "Nb magasins", value: fmtNum(row.nbMagasinsReseau) },
        { label: "CA / magasin", value: fmtEur(row.caParMagasinReseau) },
        { label: "Marge % réseau", value: `${margePct.toLocaleString("fr-FR", { maximumFractionDigits: 1 })}%` },
    ];
    if (row.chezMoi) {
        infos.push({ label: "Code interne", value: row.codein ?? "-" });
        if (row.pa != null) infos.push({ label: "PA", value: fmtEur(row.pa) });
        if (row.pvCentral != null) infos.push({ label: "PV central", value: fmtEur(row.pvCentral) });
        infos.push({ label: "Stock 292", value: fmtNum(row.stock292 ?? 0) });
        infos.push({ label: "Stock 579", value: fmtNum(row.stock579 ?? 0) });
    }

    return (
        <DialogContent className="max-w-lg" style={{ background: "var(--bg-surface)", border: "1px solid var(--border)" }}>
            <DialogHeader>
                <DialogTitle className="text-base leading-snug pr-6" style={{ color: "var(--text-primary)" }}>
                    {row.libelle}
                </DialogTitle>
                <p className="text-[12px] mt-0.5 flex flex-wrap items-center gap-x-1.5" style={{ color: "var(--text-muted)" }}>
                    <span
                        className="rounded px-1.5 py-px text-[9px] font-bold uppercase tracking-wide"
                        style={row.chezMoi
                            ? { background: "var(--accent-bg)", color: "var(--accent)" }
                            : { background: "rgba(245,158,11,0.15)", color: "#d97706" }}
                    >
                        {row.chezMoi ? "Chez moi" : "Réseau uniquement"}
                    </span>
                    <span>Ventes réseau · {labels.length > 0 ? `${labels.length} derniers mois` : "12 derniers mois"}</span>
                    {pct != null && (
                        <span className="font-bold" style={{ color }}>
                            · {pct >= 0 ? "+" : ""}{Math.round(pct * 100)}% · {trendLabel(pct)}
                        </span>
                    )}
                </p>
            </DialogHeader>

            {!trend.hasData ? (
                <div className="mt-3 rounded-xl p-4 text-center text-[13px]"
                    style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)", color: "var(--text-muted)" }}>
                    Pas de détail mensuel renvoyé par Qlik pour ce produit.
                </div>
            ) : (
                <NetworkLineChart labels={labels} values={values} color={color} />
            )}

            <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5">
                {infos.map((i) => (
                    <div key={i.label} className="flex items-baseline justify-between gap-2 text-[12px]">
                        <span style={{ color: "var(--text-muted)" }}>{i.label}</span>
                        <span className="font-semibold tabular-nums text-right" style={{ color: "var(--text-primary)" }}>{i.value}</span>
                    </div>
                ))}
            </div>

            {!row.chezMoi && (
                <div className="mt-3 rounded-xl p-3 flex items-start gap-2 text-[12px]"
                    style={{ background: "var(--accent-bg)", border: "1px solid var(--accent-border)", color: "var(--text-secondary)" }}>
                    <Store className="w-4 h-4 shrink-0 mt-px" style={{ color: "var(--accent)" }} />
                    <span>
                        Ce produit est vendu dans <strong>{fmtNum(row.nbMagasinsReseau)}</strong> magasin
                        {row.nbMagasinsReseau > 1 ? "s" : ""} du réseau et génère <strong>{fmtEur(row.caParMagasinReseau)}</strong> de
                        CA par magasin, alors que nous ne le référençons pas.
                    </span>
                </div>
            )}
        </DialogContent>
    );
}
