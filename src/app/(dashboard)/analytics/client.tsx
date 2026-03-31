"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { BarChart2 } from "lucide-react";

interface AnalyticsClientProps {
    mode: string;
    mois: string;
    moisN1: string;
    currentMois: string;
    pivotted: Array<{
        key: string;
        label: string;
        ca292: number;
        caN1_292: number;
        ca579: number;
        caN1_579: number;
        caTotal: number;
        caN1Total: number;
        evolutionTotal: number | null;
    }>;
    totals: {
        ca292: number;
        caN1_292: number;
        ca579: number;
        caN1_579: number;
        caTotal: number;
        caN1Total: number;
    };
    evolutionTotal292: number | null;
    evolutionTotal579: number | null;
    evolutionTotalReseau: number | null;
    formatCA: (value: number) => string;
}

function EvolutionBadge({ value }: { value: number | null }) {
    if (value === null) return <span className="text-gray-400">N/A</span>;

    const isPositive = value >= 0;
    const bgColor = isPositive ? "bg-green-100" : "bg-red-100";
    const textColor = isPositive ? "text-green-700" : "text-red-700";

    return (
        <span className={`${bgColor} ${textColor} inline-block rounded px-2 py-1 text-sm font-semibold`}>
            {isPositive ? "+" : ""}
            {value.toFixed(1)}%
        </span>
    );
}

export function AnalyticsClient({
    mode,
    mois,
    moisN1,
    currentMois,
    pivotted,
    totals,
    evolutionTotal292,
    evolutionTotal579,
    evolutionTotalReseau,
    formatCA,
}: AnalyticsClientProps) {
    const router = useRouter();
    const searchParams = useSearchParams();

    const handleModeChange = (newMode: string) => {
        const params = new URLSearchParams(searchParams);
        params.set("mode", newMode);
        params.set("mois", mois);
        router.push(`/analytics?${params.toString()}`);
    };

    const handleMonthChange = (newMois: string) => {
        const params = new URLSearchParams(searchParams);
        params.set("mode", mode);
        params.set("mois", newMois);
        router.push(`/analytics?${params.toString()}`);
    };

    // Générer liste des 24 derniers mois
    const months: { value: string; label: string }[] = [];
    const now = new Date();
    for (let i = 0; i < 24; i++) {
        const d = new Date(now.getFullYear(), now.getMonth() - i);
        const value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        const label = new Intl.DateTimeFormat("fr-FR", { year: "numeric", month: "long" }).format(d);
        months.push({ value, label: label.charAt(0).toUpperCase() + label.slice(1) });
    }

    return (
        <div className="space-y-6">
            {/* Controls */}
            <div className="flex items-center gap-6 rounded-lg bg-white p-4 shadow">
                <div className="flex items-center gap-2">
                    <label className="font-semibold text-gray-700">Vue :</label>
                    <select
                        value={mode}
                        onChange={(e) => handleModeChange(e.target.value)}
                        className="rounded border border-gray-300 px-3 py-2 text-sm"
                    >
                        <option value="fournisseur">Fournisseur</option>
                        <option value="nomenclature">Nomenclature</option>
                    </select>
                </div>

                <div className="flex items-center gap-2">
                    <label className="font-semibold text-gray-700">Mois :</label>
                    <select
                        value={mois}
                        onChange={(e) => handleMonthChange(e.target.value)}
                        className="rounded border border-gray-300 px-3 py-2 text-sm"
                    >
                        {months.map((m) => (
                            <option key={m.value} value={m.value}>
                                {m.label}
                            </option>
                        ))}
                    </select>
                </div>

                <div className="text-sm text-gray-600">
                    Comparaison N-1 : {moisN1}
                </div>
            </div>

            {/* Table */}
            <div className="overflow-x-auto rounded-lg bg-white shadow">
                <table className="w-full">
                    <thead>
                        <tr className="border-b-2 border-gray-200 bg-gray-50">
                            <th className="px-4 py-3 text-left text-sm font-semibold text-gray-700">
                                {mode === "fournisseur" ? "Fournisseur" : "Nomenclature"}
                            </th>
                            <th colSpan={3} className="px-4 py-3 text-center text-sm font-semibold text-gray-700">
                                Frouard/Nancy (292)
                            </th>
                            <th colSpan={3} className="px-4 py-3 text-center text-sm font-semibold text-gray-700">
                                Houdemont (579)
                            </th>
                            <th colSpan={3} className="px-4 py-3 text-center text-sm font-semibold text-gray-700">
                                Total Réseau
                            </th>
                        </tr>
                        <tr className="border-b border-gray-200 bg-gray-50">
                            <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600"></th>
                            <th className="px-4 py-3 text-right text-xs font-semibold text-gray-600">
                                {mois}
                            </th>
                            <th className="px-4 py-3 text-right text-xs font-semibold text-gray-600">
                                {moisN1}
                            </th>
                            <th className="px-4 py-3 text-center text-xs font-semibold text-gray-600">
                                Évol.
                            </th>
                            <th className="px-4 py-3 text-right text-xs font-semibold text-gray-600">
                                {mois}
                            </th>
                            <th className="px-4 py-3 text-right text-xs font-semibold text-gray-600">
                                {moisN1}
                            </th>
                            <th className="px-4 py-3 text-center text-xs font-semibold text-gray-600">
                                Évol.
                            </th>
                            <th className="px-4 py-3 text-right text-xs font-semibold text-gray-600">
                                {mois}
                            </th>
                            <th className="px-4 py-3 text-right text-xs font-semibold text-gray-600">
                                {moisN1}
                            </th>
                            <th className="px-4 py-3 text-center text-xs font-semibold text-gray-600">
                                Évol.
                            </th>
                        </tr>
                    </thead>
                    <tbody>
                        {pivotted.map((row, idx) => (
                            <tr
                                key={row.key}
                                className={idx % 2 === 0 ? "border-b border-gray-100 bg-white" : "border-b border-gray-100 bg-gray-50"}
                            >
                                <td className="px-4 py-3 text-sm font-medium text-gray-900">{row.label}</td>
                                <td className="px-4 py-3 text-right text-sm text-gray-800">{formatCA(row.ca292)}</td>
                                <td className="px-4 py-3 text-right text-sm text-gray-800">{formatCA(row.caN1_292)}</td>
                                <td className="px-4 py-3 text-center text-sm">
                                    <EvolutionBadge
                                        value={
                                            row.caN1_292 > 0
                                                ? ((row.ca292 - row.caN1_292) / row.caN1_292) * 100
                                                : null
                                        }
                                    />
                                </td>
                                <td className="px-4 py-3 text-right text-sm text-gray-800">{formatCA(row.ca579)}</td>
                                <td className="px-4 py-3 text-right text-sm text-gray-800">{formatCA(row.caN1_579)}</td>
                                <td className="px-4 py-3 text-center text-sm">
                                    <EvolutionBadge
                                        value={
                                            row.caN1_579 > 0
                                                ? ((row.ca579 - row.caN1_579) / row.caN1_579) * 100
                                                : null
                                        }
                                    />
                                </td>
                                <td className="px-4 py-3 text-right text-sm font-semibold text-gray-900">
                                    {formatCA(row.caTotal)}
                                </td>
                                <td className="px-4 py-3 text-right text-sm font-semibold text-gray-900">
                                    {formatCA(row.caN1Total)}
                                </td>
                                <td className="px-4 py-3 text-center text-sm">
                                    <EvolutionBadge value={row.evolutionTotal} />
                                </td>
                            </tr>
                        ))}
                    </tbody>
                    <tfoot>
                        <tr className="border-t-2 border-gray-300 bg-gray-50">
                            <td className="px-4 py-3 text-sm font-bold text-gray-900">TOTAL</td>
                            <td className="px-4 py-3 text-right text-sm font-bold text-gray-900">
                                {formatCA(totals.ca292)}
                            </td>
                            <td className="px-4 py-3 text-right text-sm font-bold text-gray-900">
                                {formatCA(totals.caN1_292)}
                            </td>
                            <td className="px-4 py-3 text-center text-sm">
                                <EvolutionBadge value={evolutionTotal292} />
                            </td>
                            <td className="px-4 py-3 text-right text-sm font-bold text-gray-900">
                                {formatCA(totals.ca579)}
                            </td>
                            <td className="px-4 py-3 text-right text-sm font-bold text-gray-900">
                                {formatCA(totals.caN1_579)}
                            </td>
                            <td className="px-4 py-3 text-center text-sm">
                                <EvolutionBadge value={evolutionTotal579} />
                            </td>
                            <td className="px-4 py-3 text-right text-sm font-bold text-gray-900">
                                {formatCA(totals.caTotal)}
                            </td>
                            <td className="px-4 py-3 text-right text-sm font-bold text-gray-900">
                                {formatCA(totals.caN1Total)}
                            </td>
                            <td className="px-4 py-3 text-center text-sm">
                                <EvolutionBadge value={evolutionTotalReseau} />
                            </td>
                        </tr>
                    </tfoot>
                </table>
            </div>
        </div>
    );
}
