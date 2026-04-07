"use client";

import { useRouter } from "next/navigation";
import { useState, useMemo } from "react";
import type { HitParadePivotRow } from "./page";

type SortKey = "caTotal" | "ca292" | "ca579" | "qteTotal" | "qte292" | "qte579" | "stockTotal" | "stock292" | "stock579";
type SortDir = "desc" | "asc";

const DEFAULT_SORT: SortKey = "caTotal";
const DEFAULT_DIR: SortDir = "desc";

function formatCA(v: number) {
    return new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(v);
}
function formatQte(v: number) {
    return new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 }).format(v);
}
function formatPct(ca: number, marge: number) {
    if (ca === 0) return "—";
    return ((marge / ca) * 100).toFixed(1) + " %";
}

interface Props {
    dateDebut: string;
    dateFin: string;
    pivotted: HitParadePivotRow[];
}

export function HitParadeClient({ dateDebut, dateFin, pivotted }: Props) {
    const router = useRouter();
    const [sortKey, setSortKey] = useState<SortKey>(DEFAULT_SORT);
    const [sortDir, setSortDir] = useState<SortDir>(DEFAULT_DIR);
    const [filterFournisseur, setFilterFournisseur] = useState<string>("Tous");

    // Dates locales pour les inputs (évite rechargement à chaque frappe)
    const [localDebut, setLocalDebut] = useState(dateDebut);
    const [localFin, setLocalFin] = useState(dateFin);

    const fournisseurs = useMemo(() => {
        const set = new Set(pivotted.map(r => r.fournisseur));
        return ["Tous", ...Array.from(set).sort((a, b) => a.localeCompare(b, "fr"))];
    }, [pivotted]);

    function handleSort(key: SortKey) {
        if (sortKey === key) {
            setSortDir(d => d === "desc" ? "asc" : "desc");
        } else {
            setSortKey(key);
            setSortDir("desc");
        }
    }

    function resetSort() {
        setSortKey(DEFAULT_SORT);
        setSortDir(DEFAULT_DIR);
    }

    function applyDates() {
        if (localDebut && localFin) {
            router.push(`/hit-parade?debut=${localDebut}&fin=${localFin}`);
        }
    }

    const isSorted = sortKey !== DEFAULT_SORT || sortDir !== DEFAULT_DIR;

    const filtered = useMemo(() =>
        filterFournisseur === "Tous" ? pivotted : pivotted.filter(r => r.fournisseur === filterFournisseur),
        [pivotted, filterFournisseur]
    );

    const sorted = useMemo(() =>
        [...filtered].sort((a, b) => {
            const diff = a[sortKey] - b[sortKey];
            return sortDir === "desc" ? -diff : diff;
        }),
        [filtered, sortKey, sortDir]
    );

    const totals = useMemo(() => sorted.reduce(
        (acc, r) => ({
            qte292: acc.qte292 + r.qte292, ca292: acc.ca292 + r.ca292, marge292: acc.marge292 + r.marge292,
            qte579: acc.qte579 + r.qte579, ca579: acc.ca579 + r.ca579, marge579: acc.marge579 + r.marge579,
            qteTotal: acc.qteTotal + r.qteTotal, caTotal: acc.caTotal + r.caTotal, margeTotal: acc.margeTotal + r.margeTotal,
            stock292: acc.stock292 + r.stock292, stock579: acc.stock579 + r.stock579, stockTotal: acc.stockTotal + r.stockTotal,
        }),
        { qte292: 0, ca292: 0, marge292: 0, qte579: 0, ca579: 0, marge579: 0, qteTotal: 0, caTotal: 0, margeTotal: 0, stock292: 0, stock579: 0, stockTotal: 0 }
    ), [sorted]);

    function ColHeader({ label, sortable, k, group }: { label: string; sortable?: SortKey; k: string; group?: "292" | "579" | "total" }) {
        const isActive = sortable && sortKey === sortable;
        const groupBg = group === "292" ? "bg-blue-50" : group === "579" ? "bg-violet-50" : group === "total" ? "bg-emerald-50" : "";
        const activeBg = group === "292" ? "bg-blue-100 text-blue-700" : group === "579" ? "bg-violet-100 text-violet-700" : group === "total" ? "bg-emerald-100 text-emerald-700" : "bg-blue-50 text-blue-700";
        return (
            <th
                key={k}
                onClick={sortable ? () => handleSort(sortable) : undefined}
                className={[
                    "px-4 py-2 text-center text-xs font-semibold whitespace-nowrap select-none",
                    sortable ? "cursor-pointer" : "",
                    isActive ? activeBg : `${groupBg} text-gray-600`,
                ].join(" ")}
            >
                {label}
                {sortable && (
                    <span className="ml-1 inline-block w-3 text-center">
                        {isActive ? (sortDir === "desc" ? "↓" : "↑") : <span className="text-gray-300">↕</span>}
                    </span>
                )}
            </th>
        );
    }

    return (
        <div className="space-y-4">
            {/* Barre de contrôles */}
            <div className="flex flex-wrap items-end gap-4 rounded-xl bg-white px-5 py-4 shadow-sm border border-gray-100">
                {/* Période */}
                <div className="flex items-end gap-3">
                    <div className="flex flex-col gap-1">
                        <label className="text-xs font-semibold text-gray-500">Du</label>
                        <input
                            type="date"
                            value={localDebut}
                            onChange={e => setLocalDebut(e.target.value)}
                            className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
                        />
                    </div>
                    <div className="flex flex-col gap-1">
                        <label className="text-xs font-semibold text-gray-500">Au</label>
                        <input
                            type="date"
                            value={localFin}
                            onChange={e => setLocalFin(e.target.value)}
                            className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
                        />
                    </div>
                    <button
                        onClick={applyDates}
                        className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-500 transition-colors"
                    >
                        Appliquer
                    </button>
                </div>

                <div className="h-8 w-px bg-gray-200 self-center" />

                {/* Filtre fournisseur */}
                <div className="flex flex-col gap-1">
                    <label className="text-xs font-semibold text-gray-500">Fournisseur</label>
                    <select
                        value={filterFournisseur}
                        onChange={e => setFilterFournisseur(e.target.value)}
                        className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-400 min-w-[200px]"
                    >
                        {fournisseurs.map(f => (
                            <option key={f} value={f}>{f}</option>
                        ))}
                    </select>
                </div>

                <div className="h-8 w-px bg-gray-200 self-center" />

                <span className="rounded-full bg-gray-100 px-3 py-1 text-sm font-medium text-gray-600 self-center">
                    {sorted.length} produits
                </span>

                {isSorted && (
                    <button
                        onClick={resetSort}
                        className="flex items-center gap-1.5 rounded-lg border border-orange-200 bg-orange-50 px-3 py-1.5 text-sm font-medium text-orange-700 hover:bg-orange-100 transition-colors self-center"
                    >
                        <span>✕</span> Annuler le tri
                    </button>
                )}
            </div>

            {/* Tableau */}
            <div className="overflow-x-auto rounded-xl bg-white shadow-sm border border-gray-100">
                <table className="w-full border-collapse text-sm">
                    <thead>
                        <tr>
                            <th rowSpan={2} className="w-24 border-b-2 border-gray-200 bg-gray-50 px-4 py-3 text-left text-xs font-semibold text-gray-600 align-bottom">Code</th>
                            <th rowSpan={2} className="border-b-2 border-gray-200 bg-gray-50 px-4 py-3 text-left text-xs font-semibold text-gray-600 align-bottom">Désignation</th>
                            <th rowSpan={2} className="border-b-2 border-gray-200 bg-gray-50 px-4 py-3 text-left text-xs font-semibold text-gray-600 align-bottom">Fournisseur</th>
                            <th colSpan={4} className="border-b border-l-2 border-blue-200 bg-blue-50 px-4 py-2 text-center text-xs font-bold text-blue-700 tracking-wide">
                                Frouard / Nancy — 292
                            </th>
                            <th colSpan={4} className="border-b border-l-2 border-violet-200 bg-violet-50 px-4 py-2 text-center text-xs font-bold text-violet-700 tracking-wide">
                                Houdemont — 579
                            </th>
                            <th colSpan={4} className="border-b border-l-2 border-emerald-200 bg-emerald-50 px-4 py-2 text-center text-xs font-bold text-emerald-700 tracking-wide">
                                Total Réseau
                            </th>
                        </tr>
                        <tr className="border-b-2 border-gray-200">
                            <ColHeader label="Qté" sortable="qte292" k="qte292" group="292" />
                            <ColHeader label="CA TTC" sortable="ca292" k="ca292" group="292" />
                            <th className="bg-blue-50 px-4 py-2 text-center text-xs font-semibold text-blue-500">% Marge</th>
                            <ColHeader label="Stock" sortable="stock292" k="stock292" group="292" />
                            <ColHeader label="Qté" sortable="qte579" k="qte579" group="579" />
                            <ColHeader label="CA TTC" sortable="ca579" k="ca579" group="579" />
                            <th className="bg-violet-50 px-4 py-2 text-center text-xs font-semibold text-violet-500">% Marge</th>
                            <ColHeader label="Stock" sortable="stock579" k="stock579" group="579" />
                            <ColHeader label="Qté" sortable="qteTotal" k="qteTotal" group="total" />
                            <ColHeader label="CA TTC" sortable="caTotal" k="caTotal" group="total" />
                            <th className="bg-emerald-50 px-4 py-2 text-center text-xs font-semibold text-emerald-600">% Marge</th>
                            <ColHeader label="Stock" sortable="stockTotal" k="stockTotal" group="total" />
                        </tr>
                    </thead>
                    <tbody>
                        {sorted.map((row, idx) => (
                            <tr key={row.codein} className={`border-b border-gray-100 hover:brightness-95 transition-colors`}>
                                <td className="bg-white px-4 py-2.5 font-mono text-xs text-gray-400 text-center">{row.codein}</td>
                                <td className="bg-white px-4 py-2.5 text-gray-900 font-medium max-w-[260px] truncate" title={row.libelle.trim()}>{row.libelle.trim()}</td>
                                <td className="bg-white px-4 py-2.5 text-xs text-gray-500 whitespace-nowrap text-center">{row.fournisseur}</td>
                                <td className={`border-l-2 border-blue-200 px-4 py-2.5 text-center tabular-nums text-gray-700 ${sortKey === "qte292" ? "bg-blue-100 font-semibold" : "bg-blue-50/60"}`}>
                                    {row.qte292 > 0 ? formatQte(row.qte292) : <span className="text-gray-300">—</span>}
                                </td>
                                <td className={`px-4 py-2.5 text-center tabular-nums text-gray-800 ${sortKey === "ca292" ? "bg-blue-100 font-semibold" : "bg-blue-50/60"}`}>
                                    {row.ca292 > 0 ? formatCA(row.ca292) : <span className="text-gray-300">—</span>}
                                </td>
                                <td className="bg-blue-50/60 px-4 py-2.5 text-center text-xs tabular-nums text-blue-500">
                                    {row.ca292 > 0 ? formatPct(row.ca292, row.marge292) : ""}
                                </td>
                                <td className={`px-4 py-2.5 text-center tabular-nums text-xs ${sortKey === "stock292" ? "bg-blue-100 font-semibold text-blue-700" : "bg-blue-50/60 text-amber-600"}`}>
                                    {row.stock292 > 0 ? formatQte(row.stock292) : <span className="text-gray-300">—</span>}
                                </td>
                                <td className={`border-l-2 border-violet-200 px-4 py-2.5 text-center tabular-nums text-gray-700 ${sortKey === "qte579" ? "bg-violet-100 font-semibold" : "bg-violet-50/60"}`}>
                                    {row.qte579 > 0 ? formatQte(row.qte579) : <span className="text-gray-300">—</span>}
                                </td>
                                <td className={`px-4 py-2.5 text-center tabular-nums text-gray-800 ${sortKey === "ca579" ? "bg-violet-100 font-semibold" : "bg-violet-50/60"}`}>
                                    {row.ca579 > 0 ? formatCA(row.ca579) : <span className="text-gray-300">—</span>}
                                </td>
                                <td className="bg-violet-50/60 px-4 py-2.5 text-center text-xs tabular-nums text-violet-500">
                                    {row.ca579 > 0 ? formatPct(row.ca579, row.marge579) : ""}
                                </td>
                                <td className={`px-4 py-2.5 text-center tabular-nums text-xs ${sortKey === "stock579" ? "bg-violet-100 font-semibold text-violet-700" : "bg-violet-50/60 text-amber-600"}`}>
                                    {row.stock579 > 0 ? formatQte(row.stock579) : <span className="text-gray-300">—</span>}
                                </td>
                                <td className={`border-l-2 border-emerald-200 px-4 py-2.5 text-center tabular-nums font-semibold text-gray-900 ${sortKey === "qteTotal" ? "bg-emerald-100" : "bg-emerald-50/60"}`}>
                                    {row.qteTotal > 0 ? formatQte(row.qteTotal) : <span className="text-gray-300">—</span>}
                                </td>
                                <td className={`px-4 py-2.5 text-center tabular-nums font-semibold text-gray-900 ${sortKey === "caTotal" ? "bg-emerald-100" : "bg-emerald-50/60"}`}>
                                    {row.caTotal > 0 ? formatCA(row.caTotal) : <span className="text-gray-300">—</span>}
                                </td>
                                <td className="bg-emerald-50/60 px-4 py-2.5 text-center text-xs tabular-nums text-emerald-600">
                                    {row.caTotal > 0 ? formatPct(row.caTotal, row.margeTotal) : ""}
                                </td>
                                <td className={`px-4 py-2.5 text-center tabular-nums text-xs font-semibold ${sortKey === "stockTotal" ? "bg-emerald-100 text-emerald-700" : row.stockTotal <= 0 ? "bg-emerald-50/60 text-red-400" : "bg-emerald-50/60 text-amber-600"}`}>
                                    {row.stockTotal > 0 ? formatQte(row.stockTotal) : <span className="text-red-400 font-semibold">0</span>}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                    <tfoot>
                        <tr className="border-t-2 border-gray-300">
                            <td colSpan={3} className="bg-gray-100 px-4 py-3 text-sm font-bold text-gray-800">
                                TOTAL — {sorted.length} articles
                            </td>
                            <td className="border-l-2 border-blue-300 bg-blue-100 px-4 py-3 text-center font-bold tabular-nums text-gray-900">{formatQte(totals.qte292)}</td>
                            <td className="bg-blue-100 px-4 py-3 text-center font-bold tabular-nums text-gray-900">{formatCA(totals.ca292)}</td>
                            <td className="bg-blue-100 px-4 py-3 text-center text-xs tabular-nums text-blue-700 font-semibold">{formatPct(totals.ca292, totals.marge292)}</td>
                            <td className="bg-blue-100 px-4 py-3 text-center text-xs font-bold tabular-nums text-amber-700">{formatQte(totals.stock292)}</td>
                            <td className="border-l-2 border-violet-300 bg-violet-100 px-4 py-3 text-center font-bold tabular-nums text-gray-900">{formatQte(totals.qte579)}</td>
                            <td className="bg-violet-100 px-4 py-3 text-center font-bold tabular-nums text-gray-900">{formatCA(totals.ca579)}</td>
                            <td className="bg-violet-100 px-4 py-3 text-center text-xs tabular-nums text-violet-700 font-semibold">{formatPct(totals.ca579, totals.marge579)}</td>
                            <td className="bg-violet-100 px-4 py-3 text-center text-xs font-bold tabular-nums text-amber-700">{formatQte(totals.stock579)}</td>
                            <td className="border-l-2 border-emerald-300 bg-emerald-100 px-4 py-3 text-center font-bold tabular-nums text-gray-900">{formatQte(totals.qteTotal)}</td>
                            <td className="bg-emerald-100 px-4 py-3 text-center font-bold tabular-nums text-gray-900">{formatCA(totals.caTotal)}</td>
                            <td className="bg-emerald-100 px-4 py-3 text-center text-xs tabular-nums text-emerald-800 font-semibold">{formatPct(totals.caTotal, totals.margeTotal)}</td>
                            <td className="bg-emerald-100 px-4 py-3 text-center text-xs font-bold tabular-nums text-amber-700">{formatQte(totals.stockTotal)}</td>
                        </tr>
                    </tfoot>
                </table>
            </div>
        </div>
    );
}
