"use client";

import { useRouter } from "next/navigation";
import type { Publicite } from "./page";

const FIRST_YEAR = 2020;

function fmtDate(iso: string) {
    const d = new Date(iso);
    return d.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function fmtCA(v: number) {
    return new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(v);
}

function fmtPct(v: number) {
    return v.toFixed(2).replace(".", ",") + " %";
}

interface Props {
    year: number;
    publicites: Publicite[];
}

export function PublicitesClient({ year, publicites }: Props) {
    const router = useRouter();
    const currentYear = new Date().getFullYear();
    const years = Array.from({ length: currentYear - FIRST_YEAR + 1 }, (_, i) => currentYear - i);

    function handleYearChange(e: React.ChangeEvent<HTMLSelectElement>) {
        router.push(`/publicites?year=${e.target.value}`);
    }

    return (
        <div className="space-y-4">
            {/* Barre de contrôles */}
            <div className="flex items-end gap-4 rounded-xl bg-white px-5 py-4 shadow-sm border border-gray-100">
                <div className="flex flex-col gap-1">
                    <label className="text-xs font-semibold text-gray-500">Année</label>
                    <select
                        value={year}
                        onChange={handleYearChange}
                        className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-orange-400 min-w-[120px]"
                    >
                        {years.map(y => (
                            <option key={y} value={y}>{y}</option>
                        ))}
                    </select>
                </div>

                <div className="h-8 w-px bg-gray-200 self-center" />

                <span className="rounded-full bg-gray-100 px-3 py-1 text-sm font-medium text-gray-600 self-center">
                    {publicites.length} publicité{publicites.length !== 1 ? "s" : ""}
                </span>
            </div>

            {/* Tableau */}
            <div className="overflow-x-auto rounded-xl bg-white shadow-sm border border-gray-100">
                {publicites.length === 0 ? (
                    <div className="py-16 text-center text-gray-400 text-sm">
                        Aucune publicité trouvée pour {year}.
                    </div>
                ) : (
                    <table className="w-full border-collapse text-sm">
                        <thead>
                            <tr className="border-b-2 border-gray-200 bg-gray-50">
                                <th className="px-3 py-3 text-left text-xs font-semibold text-gray-500 w-20">N°</th>
                                <th className="px-3 py-3 text-left text-xs font-semibold text-gray-500">Libellé</th>
                                <th className="px-3 py-3 text-center text-xs font-semibold text-gray-500 whitespace-nowrap">Date début</th>
                                <th className="px-3 py-3 text-center text-xs font-semibold text-gray-500 whitespace-nowrap">Date fin</th>
                                <th className="px-3 py-3 text-right text-xs font-semibold text-orange-600 whitespace-nowrap bg-orange-50">CA pub période</th>
                                <th className="px-3 py-3 text-right text-xs font-semibold text-orange-600 whitespace-nowrap bg-orange-50">% CA total</th>
                                <th className="px-3 py-3 text-right text-xs font-semibold text-gray-500 whitespace-nowrap">Qté vendue</th>
                                <th className="px-3 py-3 text-right text-xs font-semibold text-gray-500 whitespace-nowrap">Clients</th>
                                <th className="px-3 py-3 text-right text-xs font-semibold text-gray-500 whitespace-nowrap">Taux sortie</th>
                                <th className="px-3 py-3 text-right text-xs font-semibold text-gray-500 whitespace-nowrap">Nb articles</th>
                            </tr>
                        </thead>
                        <tbody>
                            {publicites.map((pub, idx) => (
                                <tr
                                    key={`${pub.tcr_code}-${idx}`}
                                    className="border-b border-gray-100 hover:bg-gray-50 transition-colors cursor-pointer"
                                >
                                    <td className="px-3 py-2.5 font-mono text-xs text-gray-400">{pub.tcr_code}</td>
                                    <td className="px-3 py-2.5 text-gray-900 font-medium">{pub.intitule}</td>
                                    <td className="px-3 py-2.5 text-center text-xs text-gray-600 whitespace-nowrap tabular-nums">
                                        {fmtDate(pub.date_debut)}
                                    </td>
                                    <td className="px-3 py-2.5 text-center text-xs text-gray-600 whitespace-nowrap tabular-nums">
                                        {fmtDate(pub.date_fin)}
                                    </td>
                                    <td className="bg-orange-50/60 px-3 py-2.5 text-right font-semibold tabular-nums text-gray-900">
                                        {fmtCA(pub.ca_pub_periode_pub)}
                                    </td>
                                    <td className="bg-orange-50/60 px-3 py-2.5 text-right tabular-nums">
                                        <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${
                                            pub.pourc_capub_catotal >= 20
                                                ? "bg-orange-100 text-orange-700"
                                                : pub.pourc_capub_catotal >= 10
                                                ? "bg-amber-100 text-amber-700"
                                                : "bg-gray-100 text-gray-600"
                                        }`}>
                                            {fmtPct(pub.pourc_capub_catotal)}
                                        </span>
                                    </td>
                                    <td className="px-3 py-2.5 text-right tabular-nums text-gray-700 text-xs">
                                        {pub.qte_vendue_pub.toLocaleString("fr-FR")}
                                    </td>
                                    <td className="px-3 py-2.5 text-right tabular-nums text-gray-700 text-xs">
                                        {pub.client_pub_periode.toLocaleString("fr-FR")}
                                    </td>
                                    <td className="px-3 py-2.5 text-right tabular-nums text-gray-700 text-xs">
                                        {pub.taux_sortie.toFixed(1).replace(".", ",")} %
                                    </td>
                                    <td className="px-3 py-2.5 text-right tabular-nums text-gray-500 text-xs">
                                        {pub.nb_articles}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                        <tfoot>
                            <tr className="border-t-2 border-gray-300 bg-gray-50">
                                <td colSpan={4} className="px-4 py-3 text-sm font-bold text-gray-800">
                                    TOTAL — {publicites.length} publicités
                                </td>
                                <td className="bg-orange-100 px-3 py-3 text-right font-bold tabular-nums text-gray-900">
                                    {fmtCA(publicites.reduce((s, p) => s + p.ca_pub_periode_pub, 0))}
                                </td>
                                <td className="bg-orange-100 px-3 py-3 text-right tabular-nums text-xs font-semibold text-orange-700">
                                    —
                                </td>
                                <td className="px-3 py-3 text-right font-bold tabular-nums text-gray-700 text-xs">
                                    {publicites.reduce((s, p) => s + p.qte_vendue_pub, 0).toLocaleString("fr-FR")}
                                </td>
                                <td colSpan={3} />
                            </tr>
                        </tfoot>
                    </table>
                )}
            </div>
        </div>
    );
}
