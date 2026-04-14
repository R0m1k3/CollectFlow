"use client";

import { useRouter } from "next/navigation";
import { useState, useMemo } from "react";
import { ChevronUp, ChevronDown, ChevronsUpDown, Download, Search } from "lucide-react";
import type { PgStockNegatifRow, PgStockSansVenteRow, PgSansVente6MoisRow } from "./page";

type SortDir = "asc" | "desc";

function fmtDate(raw: string | null) {
    if (!raw) return "—";
    const d = new Date(raw);
    if (isNaN(d.getTime())) return raw;
    return d.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function getYear(raw: string | null): string {
    if (!raw) return "";
    const d = new Date(raw);
    if (isNaN(d.getTime())) return "";
    return String(d.getFullYear());
}

function SortIcon<T extends string>({ col, sortKey, sortDir }: { col: T; sortKey: T; sortDir: SortDir }) {
    if (col !== sortKey) return <ChevronsUpDown className="inline w-3 h-3 ml-1 opacity-30" />;
    return sortDir === "asc"
        ? <ChevronUp className="inline w-3 h-3 ml-1" />
        : <ChevronDown className="inline w-3 h-3 ml-1" />;
}

function FilterSelect({ label, value, onChange, options }: {
    label: string;
    value: string;
    onChange: (v: string) => void;
    options: string[];
}) {
    return (
        <div className="flex items-center gap-2">
            <label className="text-sm font-medium text-gray-600 whitespace-nowrap">{label}</label>
            <select
                value={value}
                onChange={e => onChange(e.target.value)}
                className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 min-w-[150px]"
            >
                <option value="">Tous</option>
                {options.map(o => <option key={o} value={o}>{o}</option>)}
            </select>
        </div>
    );
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

    const [filterFournisseur, setFilterFournisseur] = useState("");
    const [filterAnnee, setFilterAnnee] = useState("");
    const [search, setSearch] = useState("");

    const fournisseurs = useMemo(() =>
        [...new Set(rows.map(r => r.fournisseur).filter(Boolean))].sort((a, b) => a.localeCompare(b, "fr")),
        [rows]
    );
    const annees = useMemo(() =>
        [...new Set(rows.map(r => getYear(r.derniereentree)).filter(Boolean))].sort((a, b) => b.localeCompare(a)),
        [rows]
    );

    const filtered = useMemo(() => {
        const q = search.trim().toLowerCase();
        return rows.filter(r =>
            (!filterFournisseur || r.fournisseur === filterFournisseur) &&
            (!filterAnnee || getYear(r.derniereentree) === filterAnnee) &&
            (!q || r.codein?.toLowerCase().includes(q) || r.libelle1?.toLowerCase().includes(q))
        );
    }, [rows, filterFournisseur, filterAnnee, search]);

    const { sorted, sortKey, sortDir, handleSort } = useSortedRows<PgStockNegatifRow>(
        filtered,
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
        ws.addRow(["CODEIN", "GENCODE", "QTE", "CODMV", "Dernière vente", "Dernière entrée"]);
        ws.getRow(1).eachCell(cell => {
            cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1E293B" } };
            cell.font = { color: { argb: "FFFFFFFF" }, bold: true };
            cell.alignment = { vertical: "middle", horizontal: "center" };
        });
        ws.getRow(1).height = 22;
        for (const r of sorted) ws.addRow([r.codein, "", Math.abs(r.stockdispo), "503", fmtDate(r.dernierevente), fmtDate(r.derniereentree)]);
        ws.columns = [{ width: 16 }, { width: 16 }, { width: 10 }, { width: 10 }, { width: 16 }, { width: 22 }];
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
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-3">
                    <div className="relative">
                        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 pointer-events-none" />
                        <input
                            type="text"
                            value={search}
                            onChange={e => setSearch(e.target.value)}
                            placeholder="Code article ou libellé…"
                            className="rounded-lg border border-gray-200 bg-white pl-8 pr-3 py-1.5 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 min-w-[220px]"
                        />
                    </div>
                    <FilterSelect label="Fournisseur" value={filterFournisseur} onChange={setFilterFournisseur} options={fournisseurs} />
                    <FilterSelect label="Année entrée" value={filterAnnee} onChange={setFilterAnnee} options={annees} />
                    {(filterFournisseur || filterAnnee || search) && (
                        <button
                            onClick={() => { setFilterFournisseur(""); setFilterAnnee(""); setSearch(""); }}
                            className="rounded-lg border border-orange-200 bg-orange-50 px-3 py-1.5 text-xs font-medium text-orange-700 hover:bg-orange-100 transition-colors"
                        >
                            ✕ Réinitialiser
                        </button>
                    )}
                </div>
                <div className="flex items-center gap-3">
                    <span className="text-sm text-gray-500">{sorted.length} article{sorted.length !== 1 ? "s" : ""}</span>
                    <button onClick={handleExport} className="flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-emerald-700 transition-colors">
                        <Download className="w-4 h-4" />Exporter Excel
                    </button>
                </div>
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

    const [filterFournisseur, setFilterFournisseur] = useState("");
    const [filterAnnee, setFilterAnnee] = useState("");
    const [search, setSearch] = useState("");

    const baseRows = useMemo(() => rows.filter(r => r.stock_actuel !== 0), [rows]);

    const fournisseurs = useMemo(() =>
        [...new Set(baseRows.map(r => r.fournisseur).filter(Boolean))].sort((a, b) => a.localeCompare(b, "fr")),
        [baseRows]
    );
    const annees = useMemo(() =>
        [...new Set(baseRows.map(r => getYear(r.derniere_entree)).filter(Boolean))].sort((a, b) => b.localeCompare(a)),
        [baseRows]
    );

    const filtered = useMemo(() => {
        const q = search.trim().toLowerCase();
        return baseRows.filter(r =>
            (!filterFournisseur || r.fournisseur === filterFournisseur) &&
            (!filterAnnee || getYear(r.derniere_entree) === filterAnnee) &&
            (!q || r.codein?.toLowerCase().includes(q) || r.libelle1?.toLowerCase().includes(q))
        );
    }, [baseRows, filterFournisseur, filterAnnee, search]);

    const { sorted, sortKey, sortDir, handleSort } = useSortedRows<PgStockSansVenteRow>(
        filtered,
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
        ws.addRow(["CODEIN", "GENCODE", "QTE", "CODMV", "Dernière entrée"]);
        ws.getRow(1).eachCell(cell => {
            cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1E293B" } };
            cell.font = { color: { argb: "FFFFFFFF" }, bold: true };
            cell.alignment = { vertical: "middle", horizontal: "center" };
        });
        ws.getRow(1).height = 22;
        for (const r of sorted) ws.addRow([r.codein, "", r.stock_actuel, "412", fmtDate(r.derniere_entree)]);
        ws.columns = [{ width: 16 }, { width: 16 }, { width: 10 }, { width: 10 }, { width: 22 }];
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
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-3">
                    <div className="relative">
                        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 pointer-events-none" />
                        <input
                            type="text"
                            value={search}
                            onChange={e => setSearch(e.target.value)}
                            placeholder="Code article ou libellé…"
                            className="rounded-lg border border-gray-200 bg-white pl-8 pr-3 py-1.5 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 min-w-[220px]"
                        />
                    </div>
                    <FilterSelect label="Fournisseur" value={filterFournisseur} onChange={setFilterFournisseur} options={fournisseurs} />
                    <FilterSelect label="Année entrée" value={filterAnnee} onChange={setFilterAnnee} options={annees} />
                    {(filterFournisseur || filterAnnee || search) && (
                        <button
                            onClick={() => { setFilterFournisseur(""); setFilterAnnee(""); setSearch(""); }}
                            className="rounded-lg border border-orange-200 bg-orange-50 px-3 py-1.5 text-xs font-medium text-orange-700 hover:bg-orange-100 transition-colors"
                        >
                            ✕ Réinitialiser
                        </button>
                    )}
                </div>
                <div className="flex items-center gap-3">
                    <span className="text-sm text-gray-500">{sorted.length} article{sorted.length !== 1 ? "s" : ""}</span>
                    <button onClick={handleExport} className="flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-emerald-700 transition-colors">
                        <Download className="w-4 h-4" />Exporter Excel
                    </button>
                </div>
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
// Onglet 3 — Sans vente depuis 6 mois
// ---------------------------------------------------------------------------

function TabSansVente6Mois({ rows, magasin }: { rows: PgSansVente6MoisRow[]; magasin: string }) {
    type SK = keyof PgSansVente6MoisRow;

    const [filterFournisseur, setFilterFournisseur] = useState("");
    const [search, setSearch] = useState("");

    const fournisseurs = useMemo(() =>
        [...new Set(rows.map(r => r.fournisseur).filter(Boolean))].sort((a, b) => a.localeCompare(b, "fr")),
        [rows]
    );

    const filtered = useMemo(() => {
        const q = search.trim().toLowerCase();
        return rows.filter(r =>
            (!filterFournisseur || r.fournisseur === filterFournisseur) &&
            (!q || r.codein?.toLowerCase().includes(q) || r.libelle1?.toLowerCase().includes(q))
        );
    }, [rows, filterFournisseur, search]);

    const { sorted, sortKey, sortDir, handleSort } = useSortedRows<PgSansVente6MoisRow & Record<string, unknown>>(
        filtered as (PgSansVente6MoisRow & Record<string, unknown>)[],
        ["stock_actuel", "jours_sans_vente"]
    );

    const th = (key: SK, label: string) => (
        <th className="cursor-pointer select-none whitespace-nowrap px-3 py-2.5 text-left text-xs font-semibold text-gray-600 uppercase tracking-wide hover:text-gray-900"
            onClick={() => handleSort(key as string & keyof (PgSansVente6MoisRow & Record<string, unknown>))}>
            {label}<SortIcon col={key as string} sortKey={sortKey as string} sortDir={sortDir} />
        </th>
    );

    async function handleExport() {
        const ExcelJS = (await import("exceljs")).default;
        const wb = new ExcelJS.Workbook();
        const ws = wb.addWorksheet("Sans vente 6 mois");
        ws.addRow(["CODEIN", "Libellé", "Fournisseur", "Magasin", "Stock actuel", "Dernière vente", "Jours sans vente", "Dernière entrée"]);
        ws.getRow(1).eachCell(cell => {
            cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1E293B" } };
            cell.font = { color: { argb: "FFFFFFFF" }, bold: true };
            cell.alignment = { vertical: "middle", horizontal: "center" };
        });
        ws.getRow(1).height = 22;
        for (const r of sorted) ws.addRow([r.codein, r.libelle1, r.fournisseur, r.site, r.stock_actuel, fmtDate(r.derniere_vente), r.jours_sans_vente ?? "—", fmtDate(r.derniere_entree)]);
        ws.columns = [{ width: 16 }, { width: 30 }, { width: 24 }, { width: 10 }, { width: 12 }, { width: 18 }, { width: 16 }, { width: 18 }];
        const buffer = await wb.xlsx.writeBuffer();
        const blob = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `Sans_Vente_6Mois_${magasin || "Tous"}_${new Date().toISOString().slice(0, 10)}.xlsx`;
        a.click();
        URL.revokeObjectURL(url);
    }

    return (
        <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-3">
                    <div className="relative">
                        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 pointer-events-none" />
                        <input
                            type="text"
                            value={search}
                            onChange={e => setSearch(e.target.value)}
                            placeholder="Code article ou libellé…"
                            className="rounded-lg border border-gray-200 bg-white pl-8 pr-3 py-1.5 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 min-w-[220px]"
                        />
                    </div>
                    <FilterSelect label="Fournisseur" value={filterFournisseur} onChange={setFilterFournisseur} options={fournisseurs} />
                    {(filterFournisseur || search) && (
                        <button
                            onClick={() => { setFilterFournisseur(""); setSearch(""); }}
                            className="rounded-lg border border-orange-200 bg-orange-50 px-3 py-1.5 text-xs font-medium text-orange-700 hover:bg-orange-100 transition-colors"
                        >
                            ✕ Réinitialiser
                        </button>
                    )}
                </div>
                <div className="flex items-center gap-3">
                    <span className="text-sm text-gray-500">{sorted.length} article{sorted.length !== 1 ? "s" : ""}</span>
                    <button onClick={handleExport} className="flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-emerald-700 transition-colors">
                        <Download className="w-4 h-4" />Exporter Excel
                    </button>
                </div>
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
                            {th("derniere_vente", "Dernière vente")}
                            {th("jours_sans_vente", "Jours sans vente")}
                            {th("derniere_entree", "Dernière entrée")}
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                        {sorted.length === 0 && (
                            <tr><td colSpan={8} className="px-3 py-8 text-center text-gray-400">Aucun article trouvé</td></tr>
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
                                <td className="px-3 py-2 text-gray-600 text-xs">{fmtDate(row.derniere_vente)}</td>
                                <td className="px-3 py-2 text-right tabular-nums font-medium"
                                    style={{ color: row.jours_sans_vente && row.jours_sans_vente > 365 ? "#ef4444" : "#6b7280" }}>
                                    {row.jours_sans_vente != null ? row.jours_sans_vente.toLocaleString("fr-FR") : "—"}
                                </td>
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
    { key: "sans-vente-6mois", label: "Sans vente 6 mois" },
] as const;

type TabKey = typeof TABS[number]["key"];

interface Props {
    rowsNegatif: PgStockNegatifRow[];
    rowsSansVente: PgStockSansVenteRow[];
    rowsSansVente6Mois: PgSansVente6MoisRow[];
    magasin: string;
    tab: string;
    sites: { code: string; label: string }[];
}

export function GestionStockClient({ rowsNegatif, rowsSansVente, rowsSansVente6Mois, magasin, tab, sites }: Props) {
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
                                {t.key === "negatif"
                                ? rowsNegatif.length
                                : t.key === "sans-vente"
                                    ? rowsSansVente.filter(r => r.stock_actuel !== 0).length
                                    : rowsSansVente6Mois.length}
                            </span>
                        </button>
                    ))}
                </nav>
            </div>

            {/* Tab content */}
            {activeTab === "negatif" && <TabStockNegatif rows={rowsNegatif} magasin={magasin} />}
            {activeTab === "sans-vente" && <TabEntreesSansVente rows={rowsSansVente} magasin={magasin} />}
            {activeTab === "sans-vente-6mois" && <TabSansVente6Mois rows={rowsSansVente6Mois} magasin={magasin} />}
        </div>
    );
}
