"use client";

import { useRouter } from "next/navigation";
import { useState, useMemo } from "react";
import { ChevronUp, ChevronDown, ChevronsUpDown, Download } from "lucide-react";
import type { PgStockNegatifRow } from "./page";

type SortKey = "codein" | "libelle1" | "fournisseur" | "site" | "stockdispo" | "dernierevente";
type SortDir = "asc" | "desc";

function fmtDate(raw: string | null) {
    if (!raw) return "—";
    const d = new Date(raw);
    if (isNaN(d.getTime())) return raw;
    return d.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function SortIcon({ col, sortKey, sortDir }: { col: SortKey; sortKey: SortKey; sortDir: SortDir }) {
    if (col !== sortKey) return <ChevronsUpDown className="inline w-3 h-3 ml-1 opacity-30" />;
    return sortDir === "asc"
        ? <ChevronUp className="inline w-3 h-3 ml-1" />
        : <ChevronDown className="inline w-3 h-3 ml-1" />;
}

interface Props {
    rows: PgStockNegatifRow[];
    magasin: string;
    sites: { code: string; label: string }[];
}

export function StockNegatifClient({ rows, magasin, sites }: Props) {
    const router = useRouter();
    const [sortKey, setSortKey] = useState<SortKey>("stockdispo");
    const [sortDir, setSortDir] = useState<SortDir>("asc");

    function handleMagasinChange(e: React.ChangeEvent<HTMLSelectElement>) {
        const val = e.target.value;
        if (val) {
            router.push(`/stock-negatif?magasin=${val}`);
        } else {
            router.push("/stock-negatif");
        }
    }

    function handleSort(key: SortKey) {
        if (sortKey === key) {
            setSortDir(d => d === "asc" ? "desc" : "asc");
        } else {
            setSortKey(key);
            setSortDir("asc");
        }
    }

    const sorted = useMemo(() => {
        return [...rows].sort((a, b) => {
            let av: string | number = a[sortKey] ?? "";
            let bv: string | number = b[sortKey] ?? "";
            if (sortKey === "stockdispo") {
                av = Number(av);
                bv = Number(bv);
                return sortDir === "asc" ? av - bv : bv - av;
            }
            av = String(av).toLowerCase();
            bv = String(bv).toLowerCase();
            return sortDir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
        });
    }, [rows, sortKey, sortDir]);

    async function handleExport() {
        const ExcelJS = (await import("exceljs")).default;
        const wb = new ExcelJS.Workbook();
        const ws = wb.addWorksheet("Stock Négatif");

        const headers = ["Code article", "Libellé", "Fournisseur", "Stock négatif"];
        ws.addRow(headers);
        const headerRow = ws.getRow(1);
        headerRow.eachCell(cell => {
            cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1E293B" } };
            cell.font = { color: { argb: "FFFFFFFF" }, bold: true };
            cell.alignment = { vertical: "middle", horizontal: "center" };
        });
        ws.getRow(1).height = 22;

        for (const r of sorted) {
            ws.addRow([r.codein, r.libelle1, r.fournisseur, r.stockdispo]);
        }

        ws.columns = [
            { key: "codein", width: 16 },
            { key: "libelle1", width: 40 },
            { key: "fournisseur", width: 30 },
            { key: "stockdispo", width: 14 },
        ];

        const today = new Date().toISOString().slice(0, 10);
        const siteSuffix = magasin || "Tous";
        const filename = `Stock_Negatif_${siteSuffix}_${today}.xlsx`;

        const buffer = await wb.xlsx.writeBuffer();
        const blob = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
    }

    const th = (key: SortKey, label: string) => (
        <th
            className="cursor-pointer select-none whitespace-nowrap px-3 py-2.5 text-left text-xs font-semibold text-gray-600 uppercase tracking-wide hover:text-gray-900"
            onClick={() => handleSort(key)}
        >
            {label}
            <SortIcon col={key} sortKey={sortKey} sortDir={sortDir} />
        </th>
    );

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

                <div className="ml-auto flex items-center gap-3">
                    <span className="text-sm text-gray-500">
                        {sorted.length} article{sorted.length !== 1 ? "s" : ""}
                    </span>
                    <button
                        onClick={handleExport}
                        className="flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-emerald-700 transition-colors"
                    >
                        <Download className="w-4 h-4" />
                        Exporter Excel
                    </button>
                </div>
            </div>

            {/* Table */}
            <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
                <table className="min-w-full text-sm">
                    <thead className="bg-gray-50 border-b border-gray-200">
                        <tr>
                            {th("codein", "Code article")}
                            {th("libelle1", "Libellé")}
                            {th("fournisseur", "Fournisseur")}
                            {th("site", "Magasin")}
                            {th("stockdispo", "Stock négatif")}
                            {th("dernierevente", "Dernière vente")}
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                        {sorted.length === 0 && (
                            <tr>
                                <td colSpan={6} className="px-3 py-8 text-center text-gray-400">
                                    Aucun article en stock négatif
                                </td>
                            </tr>
                        )}
                        {sorted.map((row, i) => (
                            <tr key={`${row.codein}-${row.site}-${i}`} className="hover:bg-gray-50 transition-colors">
                                <td className="px-3 py-2 font-mono text-xs text-gray-700">{row.codein}</td>
                                <td className="px-3 py-2 text-gray-900">{row.libelle1}</td>
                                <td className="px-3 py-2 text-gray-700">{row.fournisseur}</td>
                                <td className="px-3 py-2">
                                    <span className="rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700">
                                        {row.site}
                                    </span>
                                </td>
                                <td className="px-3 py-2">
                                    <span className="font-semibold text-red-600">
                                        {row.stockdispo}
                                    </span>
                                </td>
                                <td className="px-3 py-2 text-gray-600 text-xs">{fmtDate(row.dernierevente)}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
