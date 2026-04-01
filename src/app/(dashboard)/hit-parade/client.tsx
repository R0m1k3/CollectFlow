"use client";

import { useRouter } from "next/navigation";
import { useState, useMemo } from "react";
import type { HitParadePivotRow } from "./page";

type SortKey = "caTotal" | "ca292" | "ca579" | "qteTotal" | "qte292" | "qte579" | "margeTotal";
type SortDir = "desc" | "asc";

function formatCA(v: number) {
    return new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(v);
}

function formatQte(v: number) {
    return new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 }).format(v);
}

function formatPct(ca: number, marge: number) {
    if (ca === 0) return null;
    return ((marge / ca) * 100).toFixed(1) + "%";
}

function SortBtn({ active, dir, onClick }: { active: boolean; dir: SortDir; onClick: () => void }) {
    return (
        <button onClick={onClick} className="ml-1 text-xs text-gray-400 hover:text-gray-700">
            {active ? (dir === "desc" ? "▼" : "▲") : "⇅"}
        </button>
    );
}

interface Props {
    mois: string;
    currentMois: string;
    pivotted: HitParadePivotRow[];
}

export function HitParadeClient({ mois, currentMois, pivotted }: Props) {
    const router = useRouter();
    const [sortKey, setSortKey] = useState<SortKey>("caTotal");
    const [sortDir, setSortDir] = useState<SortDir>("desc");

    const months: { value: string; label: string }[] = [];
    const now = new Date();
    for (let i = 0; i < 24; i++) {
        const d = new Date(now.getFullYear(), now.getMonth() - i);
        const value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        const label = new Intl.DateTimeFormat("fr-FR", { year: "numeric", month: "long" }).format(d);
        months.push({ value, label: label.charAt(0).toUpperCase() + label.slice(1) });
    }

    const sorted = useMemo(() => {
        return [...pivotted].sort((a, b) => {
            const diff = a[sortKey] - b[sortKey];
            return sortDir === "desc" ? -diff : diff;
        });
    }, [pivotted, sortKey, sortDir]);

    function handleSort(key: SortKey) {
        if (sortKey === key) {
            setSortDir(d => d === "desc" ? "asc" : "desc");
        } else {
            setSortKey(key);
            setSortDir("desc");
        }
    }

    const totals = useMemo(() => pivotted.reduce(
        (acc, r) => ({
            qte292: acc.qte292 + r.qte292,
            ca292: acc.ca292 + r.ca292,
            marge292: acc.marge292 + r.marge292,
            qte579: acc.qte579 + r.qte579,
            ca579: acc.ca579 + r.ca579,
            marge579: acc.marge579 + r.marge579,
            qteTotal: acc.qteTotal + r.qteTotal,
            caTotal: acc.caTotal + r.caTotal,
            margeTotal: acc.margeTotal + r.margeTotal,
        }),
        { qte292: 0, ca292: 0, marge292: 0, qte579: 0, ca579: 0, marge579: 0, qteTotal: 0, caTotal: 0, margeTotal: 0 }
    ), [pivotted]);

    function th(label: string, key: SortKey) {
        return (
            <th className="px-3 py-2 text-right text-xs font-semibold text-gray-600 whitespace-nowrap">
                {label}
                <SortBtn active={sortKey === key} dir={sortDir} onClick={() => handleSort(key)} />
            </th>
        );
    }

    return (
        <div className="space-y-4">
            {/* Controls */}
            <div className="flex items-center gap-4 rounded-lg bg-white p-4 shadow">
                <label className="font-semibold text-gray-700">Mois :</label>
                <select
                    value={mois}
                    onChange={e => router.push(`/hit-parade?mois=${e.target.value}`)}
                    className="rounded border border-gray-300 px-3 py-2 text-sm"
                >
                    {months.map(m => (
                        <option key={m.value} value={m.value}>{m.label}</option>
                    ))}
                </select>
                <span className="text-sm text-gray-500">{sorted.length} produits</span>
            </div>

            {/* Table */}
            <div className="overflow-x-auto rounded-lg bg-white shadow">
                <table className="w-full text-sm">
                    <thead>
                        <tr className="border-b-2 border-gray-200 bg-gray-50">
                            <th className="px-3 py-2 text-left text-xs font-semibold text-gray-700" rowSpan={2}>Code</th>
                            <th className="px-3 py-2 text-left text-xs font-semibold text-gray-700" rowSpan={2}>Désignation</th>
                            <th className="px-3 py-2 text-left text-xs font-semibold text-gray-700" rowSpan={2}>Fournisseur</th>
                            <th colSpan={3} className="px-3 py-2 text-center text-xs font-semibold text-gray-700 border-l border-gray-200">Frouard/Nancy (292)</th>
                            <th colSpan={3} className="px-3 py-2 text-center text-xs font-semibold text-gray-700 border-l border-gray-200">Houdemont (579)</th>
                            <th colSpan={3} className="px-3 py-2 text-center text-xs font-semibold text-gray-700 border-l border-gray-200">Total Réseau</th>
                        </tr>
                        <tr className="border-b border-gray-200 bg-gray-50">
                            {th("Qté", "qte292")}
                            {th("CA TTC", "ca292")}
                            <th className="px-3 py-2 text-right text-xs font-semibold text-gray-600">Marge</th>
                            {th("Qté", "qte579")}
                            {th("CA TTC", "ca579")}
                            <th className="px-3 py-2 text-right text-xs font-semibold text-gray-600">Marge</th>
                            {th("Qté", "qteTotal")}
                            {th("CA TTC", "caTotal")}
                            <th className="px-3 py-2 text-right text-xs font-semibold text-gray-600">Marge</th>
                        </tr>
                    </thead>
                    <tbody>
                        {sorted.map((row, idx) => (
                            <tr key={row.codein} className={idx % 2 === 0 ? "border-b border-gray-100 bg-white" : "border-b border-gray-100 bg-gray-50"}>
                                <td className="px-3 py-2 font-mono text-xs text-gray-500">{row.codein}</td>
                                <td className="px-3 py-2 text-gray-900 max-w-xs truncate" title={row.libelle}>{row.libelle.trim()}</td>
                                <td className="px-3 py-2 text-gray-600 whitespace-nowrap">{row.fournisseur}</td>
                                <td className="px-3 py-2 text-right text-gray-800 border-l border-gray-100">{row.qte292 > 0 ? formatQte(row.qte292) : ""}</td>
                                <td className="px-3 py-2 text-right text-gray-800">{row.ca292 > 0 ? formatCA(row.ca292) : ""}</td>
                                <td className="px-3 py-2 text-right text-gray-500 text-xs">{row.ca292 > 0 ? formatPct(row.ca292, row.marge292) : ""}</td>
                                <td className="px-3 py-2 text-right text-gray-800 border-l border-gray-100">{row.qte579 > 0 ? formatQte(row.qte579) : ""}</td>
                                <td className="px-3 py-2 text-right text-gray-800">{row.ca579 > 0 ? formatCA(row.ca579) : ""}</td>
                                <td className="px-3 py-2 text-right text-gray-500 text-xs">{row.ca579 > 0 ? formatPct(row.ca579, row.marge579) : ""}</td>
                                <td className="px-3 py-2 text-right font-semibold text-gray-900 border-l border-gray-100">{row.qteTotal > 0 ? formatQte(row.qteTotal) : ""}</td>
                                <td className="px-3 py-2 text-right font-semibold text-gray-900">{row.caTotal > 0 ? formatCA(row.caTotal) : ""}</td>
                                <td className="px-3 py-2 text-right text-gray-500 text-xs">{row.caTotal > 0 ? formatPct(row.caTotal, row.margeTotal) : ""}</td>
                            </tr>
                        ))}
                    </tbody>
                    <tfoot>
                        <tr className="border-t-2 border-gray-300 bg-gray-100">
                            <td colSpan={3} className="px-3 py-2 text-sm font-bold text-gray-900">TOTAL</td>
                            <td className="px-3 py-2 text-right font-bold text-gray-900 border-l border-gray-200">{formatQte(totals.qte292)}</td>
                            <td className="px-3 py-2 text-right font-bold text-gray-900">{formatCA(totals.ca292)}</td>
                            <td className="px-3 py-2 text-right text-xs text-gray-600">{formatPct(totals.ca292, totals.marge292)}</td>
                            <td className="px-3 py-2 text-right font-bold text-gray-900 border-l border-gray-200">{formatQte(totals.qte579)}</td>
                            <td className="px-3 py-2 text-right font-bold text-gray-900">{formatCA(totals.ca579)}</td>
                            <td className="px-3 py-2 text-right text-xs text-gray-600">{formatPct(totals.ca579, totals.marge579)}</td>
                            <td className="px-3 py-2 text-right font-bold text-gray-900 border-l border-gray-200">{formatQte(totals.qteTotal)}</td>
                            <td className="px-3 py-2 text-right font-bold text-gray-900">{formatCA(totals.caTotal)}</td>
                            <td className="px-3 py-2 text-right text-xs text-gray-600">{formatPct(totals.caTotal, totals.margeTotal)}</td>
                        </tr>
                    </tfoot>
                </table>
            </div>
        </div>
    );
}
