"use client";

import { useRouter } from "next/navigation";
import { useState, useMemo } from "react";
import { ChevronUp, ChevronDown, ChevronsUpDown, Download } from "lucide-react";
import type { PgStockNegatifRow, PgStockSansVenteRow } from "./page";

type SortDir = "asc" | "desc";

function fmtDate(raw: string | null) {
    if (!raw) return "—";
    const d = new Date(raw);
    if (isNaN(d.getTime())) return raw;
    return d.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function SortIcon<T extends string>({ col, sortKey, sortDir }: { col: T; sortKey: T; sortDir: SortDir }) {
    if (col !== sortKey) return <ChevronsUpDown className="inline w-3 h-3 ml-1 opacity-30" />;
    return sortDir === "asc"
        ? <ChevronUp className="inline w-3 h-3 ml-1" />
        : <ChevronDown className="inline w-3 h-3 ml-1" />;
}

function useSortedRows<T extends Record<string, unknown>>(rows: T[], numericKeys: string[]) {
    const [sortKey, setSortKey] = useState<keyof T>(Object.keys(rows[0] ?? { codein: "" })[0] as keyof T);
    const [sortDir, setSortDir] = useState<SortDir>("asc");

    function handleSort(key: keyof T) {
        if (sortKey === key) setSortDir(d => d === "asc" ? "desc" : "asc");
        else { setSortKey(key); setSortDir("asc"); }
    }

    const sorted = useMemo(() => [...rows].sort((a, b) => {
        const av = a[sortKey];
        const bv = b[sortKey];
        if (numericKeys.includes(sortKey as string)) {
            return sortDir === "asc" ? Number(av) - Number(bv) : Number(bv) - Number(av);
        }
        const as = String(av ?? "").toLowerCase();
        const bs = String(bv ?? "").toLowerCase();
        return sortDir === "asc" ? as.localeCompare(bs) : bs.localeCompare(as);
    }), [rows, sortKey, sortDir]);

    return { sorted, sortKey, sortDir, handleSort };
}

// ---------------------------------------------------------------------------
// Onglet 1 — Stock Négatif
// ---------------------------------------------------------------------------

function TabStockNegatif({ rows, magasin }: { rows: PgStockNegatifRow[]; magasin: string }) {
    type SK = keyof PgStockNegatifRow;
    const { sorted, sortKey, sortDir, handleSort } = useSortedRows<PgStockNegatifRow>(
        rows.length ? rows : [] as PgStockNegatifRow[],
        ["stockdispo"]
    );

    const th = (key: SK, label: string) => (
        <th className="cursor-pointer select-none whitespace-nowrap px-3 py-2.5 text-left text-xs font-semibold text-gray-600 uppercase tracking-wide hover:text-gray-900"
            onClick={() => handleSort(key)}>
            {label}<SortIcon col={key as string} sortKey={sortKey as string} sortDir={sortDir} />
        </th>
    );

    async function handleExport() {
        const ExcelJS = (await import("exceljs")).default;
        const wb = new ExcelJS.Workbook();
        const ws = wb.addWorksheet("Stock Négatif");
        ws.addRow(["Code article", "Libellé", "Fournisseur", "Magasin", "Stock négatif", "Dernière vente", "Dernière entrée en stock"]);
        ws.getRow(1).eachCell(cell => {
            cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1E293B" } };
            cell.font = { color: { argb: "FFFFFFFF" }, bold: true };
            cell.alignment = { vertical: "middle", horizontal: "center" };
        });
        ws.getRow(1).height = 22;
        for (const r of sorted) ws.addRow([r.codein, r.libelle1, r.fournisseur, r.site, r.stockdispo, fmtDate(r.dernierevente), fmtDate(r.derniereentree)]);
        ws.columns = [{ width: 16 }, { width: 40 }, { width: 30 }, { width: 10 }, { width: 14 }, { width: 16 }, { width: 22 }];
        const buffer = await wb.xlsx.writeBuffer();
        const blob = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `Stock_Negatif_${magasin || "Tous"}_${new Date().toISOString().slice(0, 10)}.xlsx`;
        a.click();
        URL.revokeObjectURL(url);
    }

    return (
        <div className="space-y-4">
            <div className="flex justify-end items-center gap-3">
                <span className="text-sm text-gray-500">{sorted.length} article{sorted.length !== 1 ? "s" : ""}</span>
                <button onClick={handleExport} className="flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-emerald-700 transition-colors">
                    <Download className="w-4 h-4" />Exporter Excel
                </button>
            </div>
            <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
                <table className="min-w-full text-sm">
                    <thead className="bg-gray-50 border-b border-gray-200">
                        <tr>
                            {th("codein", "Code article")}
                            {th("libelle1", "Libellé")}
                            {th("fournisseur", "Fournisseur")}
                            {th("site", "Magasin")}
                            {th("stockdispo", "Stock")}
                            {th("dernierevente", "Dernière vente")}
                            {th("derniereentree", "Dernière entrée")}
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                        {sorted.length === 0 && (
                            <tr><td colSpan={7} className="px-3 py-8 text-center text-gray-400">Aucun article en stock négatif</td></tr>
                        )}
                        {sorted.map((row, i) => (
                            <tr key={`${row.codein}-${row.site}-${i}`} className="hover:bg-gray-50 transition-colors">
                                <td className="px-3 py-2 font-mono text-xs text-gray-700">{row.codein}</td>
                                <td className="px-3 py-2 text-gray-900">{row.libelle1}</td>
                                <td className="px-3 py-2 text-gray-700">{row.fournisseur}</td>
                                <td className="px-3 py-2">
                                    <span className="rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700">{row.site}</span>
                                </td>
                                <td className="px-3 py-2 font-semibold text-red-600">{row.stockdispo}</td>
                                <td className="px-3 py-2 text-gray-600 text-xs">{fmtDate(row.dernierevente)}</td>
                                <td className="px-3 py-2 text-gray-600 text-xs">{fmtDate(row.derniereentree)}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}

// ---------------------------------------------------------------------------
// Onglet 2 — Entrées sans vente
// ---------------------------------------------------------------------------

function TabEntreesSansVente({ rows, magasin }: { rows: PgStockSansVenteRow[]; magasin: string }) {
    type SK = keyof PgStockSansVenteRow;
    const filteredRows = useMemo(() => rows.filter(r => r.stock_actuel !== 0), [rows]);
    const { sorted, sortKey, sortDir, handleSort } = useSortedRows<PgStockSansVenteRow>(
        filteredRows,
        ["stock_actuel"]
    );

    const th = (key: SK, label: string) => (
        <th className="cursor-pointer select-none whitespace-nowrap px-3 py-2.5 text-left text-xs font-semibold text-gray-600 uppercase tracking-wide hover:text-gray-900"
            onClick={() => handleSort(key)}>
            {label}<SortIcon col={key as string} sortKey={sortKey as string} sortDir={sortDir} />
        </th>
    );

    async function handleExport() {
        const ExcelJS = (await import("exceljs")).default;
        const wb = new ExcelJS.Workbook();
        const ws = wb.addWorksheet("Entrées sans vente");
        ws.addRow(["Code article", "Libellé", "Fournisseur", "Magasin", "Stock actuel", "Dernière entrée"]);
        ws.getRow(1).eachCell(cell => {
            cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1E293B" } };
            cell.font = { color: { argb: "FFFFFFFF" }, bold: true };
            cell.alignment = { vertical: "middle", horizontal: "center" };
        });
        ws.getRow(1).height = 22;
        for (const r of sorted) ws.addRow([r.codein, r.libelle1, r.fournisseur, r.site, r.stock_actuel, fmtDate(r.derniere_entree)]);
        ws.columns = [{ width: 16 }, { width: 40 }, { width: 30 }, { width: 10 }, { width: 14 }, { width: 16 }];
        const buffer = await wb.xlsx.writeBuffer();
        const blob = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `Entrees_Sans_Vente_${magasin || "Tous"}_${new Date().toISOString().slice(0, 10)}.xlsx`;
        a.click();
        URL.revokeObjectURL(url);
    }

    return (
        <div className="space-y-4">
            <div className="flex justify-end items-center gap-3">
                <span className="text-sm text-gray-500">{sorted.length} article{sorted.length !== 1 ? "s" : ""}</span>
                <button onClick={handleExport} className="flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-emerald-700 transition-colors">
                    <Download className="w-4 h-4" />Exporter Excel
                </button>
            </div>
            <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
                <table className="min-w-full text-sm">
                    <thead className="bg-gray-50 border-b border-gray-200">
                        <tr>
                            {th("codein", "Code article")}
                            {th("libelle1", "Libellé")}
                            {th("fournisseur", "Fournisseur")}
                            {th("site", "Magasin")}
                            {th("stock_actuel", "Stock actuel")}
                            {th("derniere_entree", "Dernière entrée")}
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                        {sorted.length === 0 && (
                            <tr><td colSpan={6} className="px-3 py-8 text-center text-gray-400">Aucun article trouvé</td></tr>
                        )}
                        {sorted.map((row, i) => (
                            <tr key={`${row.codein}-${row.site}-${i}`} className="hover:bg-gray-50 transition-colors">
                                <td className="px-3 py-2 font-mono text-xs text-gray-700">{row.codein}</td>
                                <td className="px-3 py-2 text-gray-900">{row.libelle1}</td>
                                <td className="px-3 py-2 text-gray-700">{row.fournisseur}</td>
                                <td className="px-3 py-2">
                                    <span className="rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700">{row.site}</span>
                                </td>
                                <td className="px-3 py-2 font-semibold text-amber-600">{row.stock_actuel}</td>
                                <td className="px-3 py-2 text-gray-600 text-xs">{fmtDate(row.derniere_entree)}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}

// ---------------------------------------------------------------------------
// Composant principal avec onglets
// ---------------------------------------------------------------------------

const TABS = [
    { key: "negatif", label: "Stock négatif" },
    { key: "sans-vente", label: "Entrées sans vente" },
] as const;

type TabKey = typeof TABS[number]["key"];

interface Props {
    rowsNegatif: PgStockNegatifRow[];
    rowsSansVente: PgStockSansVenteRow[];
    magasin: string;
    tab: string;
    sites: { code: string; label: string }[];
}

export function GestionStockClient({ rowsNegatif, rowsSansVente, magasin, tab, sites }: Props) {
    const router = useRouter();
    const activeTab: TabKey = (TABS.some(t => t.key === tab) ? tab : "negatif") as TabKey;

    function handleMagasinChange(e: React.ChangeEvent<HTMLSelectElement>) {
        const val = e.target.value;
        const params = new URLSearchParams();
        if (val) params.set("magasin", val);
        params.set("tab", activeTab);
        router.push(`/stock-negatif?${params.toString()}`);
    }

    function handleTabChange(key: TabKey) {
        const params = new URLSearchParams();
        if (magasin) params.set("magasin", magasin);
        params.set("tab", key);
        router.push(`/stock-negatif?${params.toString()}`);
    }

    return (
        <div className="space-y-4">
            {/* Toolbar */}
            <div className="flex flex-wrap items-center gap-3">
                <div className="flex items-center gap-2">
                    <label className="text-sm font-medium text-gray-700">Magasin</label>
                    <select
                        value={magasin}
                        onChange={handleMagasinChange}
                        className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                        <option value="">Tous les magasins</option>
                        {sites.map(s => (
                            <option key={s.code} value={s.code}>{s.label}</option>
                        ))}
                    </select>
                </div>
            </div>

            {/* Tabs */}
            <div className="border-b border-gray-200">
                <nav className="-mb-px flex gap-1">
                    {TABS.map(t => (
                        <button
                            key={t.key}
                            onClick={() => handleTabChange(t.key)}
                            className={[
                                "px-4 py-2.5 text-sm font-medium border-b-2 transition-colors whitespace-nowrap",
                                activeTab === t.key
                                    ? "border-blue-600 text-blue-600"
                                    : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300",
                            ].join(" ")}
                        >
                            {t.label}
                            <span className={[
                                "ml-2 rounded-full px-2 py-0.5 text-xs font-semibold",
                                activeTab === t.key ? "bg-blue-100 text-blue-700" : "bg-gray-100 text-gray-500",
                            ].join(" ")}>
                                {t.key === "negatif" ? rowsNegatif.length : rowsSansVente.filter(r => r.stock_actuel !== 0).length}
                            </span>
                        </button>
                    ))}
                </nav>
            </div>

            {/* Tab content */}
            {activeTab === "negatif" && <TabStockNegatif rows={rowsNegatif} magasin={magasin} />}
            {activeTab === "sans-vente" && <TabEntreesSansVente rows={rowsSansVente} magasin={magasin} />}
        </div>
    );
}
