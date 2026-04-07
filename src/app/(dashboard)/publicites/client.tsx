"use client";

import { useRouter } from "next/navigation";
import { useState, useMemo } from "react";
import { ChevronUp, ChevronDown, ChevronsUpDown } from "lucide-react";
import type { Publicite } from "./page";

const FIRST_YEAR = 2020;

function fmtDate(iso: string) {
    const d = new Date(iso);
    return d.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function fmtCA(v: number | string) {
    return new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(Number(v));
}

function fmtPct(v: number | string) {
    return Number(v).toFixed(2).replace(".", ",") + " %";
}

type SortKey = "intitule" | "site" | "ca_pub_periode_pub" | "pourc_capub_catotal" | "qte_vendue_pub" | "taux_sortie";
type SortDir = "asc" | "desc";

function SortIcon({ col, sortKey, sortDir }: { col: SortKey; sortKey: SortKey; sortDir: SortDir }) {
    if (col !== sortKey) return <ChevronsUpDown className="inline w-3 h-3 ml-1 opacity-30" />;
    return sortDir === "asc"
        ? <ChevronUp className="inline w-3 h-3 ml-1" />
        : <ChevronDown className="inline w-3 h-3 ml-1" />;
}

interface Props {
    year: number;
    publicites: Publicite[];
}

export function PublicitesClient({ year, publicites }: Props) {
    const router = useRouter();
    const currentYear = new Date().getFullYear();
    const years = Array.from({ length: currentYear - FIRST_YEAR + 1 }, (_, i) => currentYear - i);

    const [filterSite, setFilterSite] = useState<string>("all");
    const [sortKey, setSortKey] = useState<SortKey>("intitule");
    const [sortDir, setSortDir] = useState<SortDir>("asc");

    const validPublicites = useMemo(() => publicites.filter(p => p.site !== "000"), [publicites]);

    const sites = useMemo(() => {
        const s = new Set(validPublicites.map(p => p.site).filter(Boolean));
        return Array.from(s).sort();
    }, [validPublicites]);

    const SITE_COLORS: Record<string, string> = useMemo(() => {
        const palette = [
            "bg-blue-50 text-blue-700",
            "bg-violet-50 text-violet-700",
            "bg-emerald-50 text-emerald-700",
            "bg-rose-50 text-rose-700",
            "bg-amber-50 text-amber-700",
            "bg-cyan-50 text-cyan-700",
            "bg-pink-50 text-pink-700",
            "bg-indigo-50 text-indigo-700",
        ];
        return Object.fromEntries(sites.map((s, i) => [s, palette[i % palette.length]]));
    }, [sites]);

    function handleYearChange(e: React.ChangeEvent<HTMLSelectElement>) {
        router.push(`/publicites?year=${e.target.value}`);
    }

    function handleSort(key: SortKey) {
        if (sortKey === key) {
            setSortDir(d => d === "asc" ? "desc" : "asc");
        } else {
            setSortKey(key);
            setSortDir("asc");
        }
    }

    const filtered = useMemo(() => {
        let rows = filterSite === "all" ? validPublicites : validPublicites.filter(p => p.site === filterSite);
        rows = [...rows].sort((a, b) => {
            let va: string | number;
            let vb: string | number;
            if (sortKey === "intitule" || sortKey === "site") {
                va = String(a[sortKey] ?? "").toLowerCase();
                vb = String(b[sortKey] ?? "").toLowerCase();
            } else {
                va = Number(a[sortKey]);
                vb = Number(b[sortKey]);
            }
            if (va < vb) return sortDir === "asc" ? -1 : 1;
            if (va > vb) return sortDir === "asc" ? 1 : -1;
            return 0;
        });
        return rows;
    }, [validPublicites, filterSite, sortKey, sortDir]);

    function thProps(key: SortKey, className: string) {
        return {
            className: `${className} cursor-pointer select-none hover:bg-gray-100 transition-colors`,
            onClick: () => handleSort(key),
        };
    }

    return (
        <div className="space-y-4">
            {/* Barre de contrôles */}
            <div className="flex flex-wrap items-end gap-4 rounded-xl bg-white px-5 py-4 shadow-sm border border-gray-100">
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

                {sites.length > 1 && (
                    <div className="flex flex-col gap-1">
                        <label className="text-xs font-semibold text-gray-500">Magasin</label>
                        <select
                            value={filterSite}
                            onChange={e => setFilterSite(e.target.value)}
                            className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-orange-400 min-w-[160px]"
                        >
                            <option value="all">Tous les magasins</option>
                            {sites.map(s => (
                                <option key={s} value={s}>{s}</option>
                            ))}
                        </select>
                    </div>
                )}

                <div className="h-8 w-px bg-gray-200 self-center" />

                <span className="rounded-full bg-gray-100 px-3 py-1 text-sm font-medium text-gray-600 self-center">
                    {filtered.length} publicité{filtered.length !== 1 ? "s" : ""}
                </span>
            </div>

            {/* Tableau */}
            <div className="overflow-x-auto rounded-xl bg-white shadow-sm border border-gray-100">
                {filtered.length === 0 ? (
                    <div className="py-16 text-center text-gray-400 text-sm">
                        Aucune publicité trouvée pour {year}.
                    </div>
                ) : (
                    <table className="w-full border-collapse text-sm">
                        <thead>
                            <tr className="border-b-2 border-gray-200 bg-gray-50">
                                <th className="px-3 py-3 text-left text-xs font-semibold text-gray-500 w-20">N°</th>
                                <th {...thProps("intitule", "px-3 py-3 text-left text-xs font-semibold text-gray-500")}>
                                    Opération <SortIcon col="intitule" sortKey={sortKey} sortDir={sortDir} />
                                </th>
                                <th {...thProps("site", "px-3 py-3 text-left text-xs font-semibold text-gray-500 whitespace-nowrap")}>
                                    Magasin <SortIcon col="site" sortKey={sortKey} sortDir={sortDir} />
                                </th>
                                <th className="px-3 py-3 text-center text-xs font-semibold text-gray-500 whitespace-nowrap">Date début</th>
                                <th className="px-3 py-3 text-center text-xs font-semibold text-gray-500 whitespace-nowrap">Date fin</th>
                                <th {...thProps("ca_pub_periode_pub", "px-3 py-3 text-right text-xs font-semibold text-orange-600 whitespace-nowrap bg-orange-50")}>
                                    CA pub période <SortIcon col="ca_pub_periode_pub" sortKey={sortKey} sortDir={sortDir} />
                                </th>
                                <th {...thProps("pourc_capub_catotal", "px-3 py-3 text-right text-xs font-semibold text-orange-600 whitespace-nowrap bg-orange-50")}>
                                    % CA total <SortIcon col="pourc_capub_catotal" sortKey={sortKey} sortDir={sortDir} />
                                </th>
                                <th {...thProps("qte_vendue_pub", "px-3 py-3 text-right text-xs font-semibold text-gray-500 whitespace-nowrap")}>
                                    Qté vendue <SortIcon col="qte_vendue_pub" sortKey={sortKey} sortDir={sortDir} />
                                </th>
                                <th className="px-3 py-3 text-right text-xs font-semibold text-gray-500 whitespace-nowrap">Clients</th>
                                <th {...thProps("taux_sortie", "px-3 py-3 text-right text-xs font-semibold text-gray-500 whitespace-nowrap")}>
                                    Taux sortie <SortIcon col="taux_sortie" sortKey={sortKey} sortDir={sortDir} />
                                </th>
                                <th className="px-3 py-3 text-right text-xs font-semibold text-gray-500 whitespace-nowrap">Nb articles</th>
                            </tr>
                        </thead>
                        <tbody>
                            {filtered.map((pub, idx) => (
                                <tr
                                    key={`${pub.tcr_code}-${pub.site}-${idx}`}
                                    className="border-b border-gray-100 hover:bg-gray-50 transition-colors cursor-pointer"
                                >
                                    <td className="px-3 py-2.5 font-mono text-xs text-gray-400">{pub.tcr_code}</td>
                                    <td className="px-3 py-2.5 text-gray-900 font-medium">{pub.intitule}</td>
                                    <td className="px-3 py-2.5 text-xs text-gray-600 whitespace-nowrap">
                                        <span className={`inline-block rounded-md px-2 py-0.5 font-medium ${SITE_COLORS[pub.site] ?? "bg-gray-100 text-gray-600"}`}>
                                            {pub.site || "—"}
                                        </span>
                                    </td>
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
                                            Number(pub.pourc_capub_catotal) >= 20
                                                ? "bg-orange-100 text-orange-700"
                                                : Number(pub.pourc_capub_catotal) >= 10
                                                ? "bg-amber-100 text-amber-700"
                                                : "bg-gray-100 text-gray-600"
                                        }`}>
                                            {fmtPct(pub.pourc_capub_catotal)}
                                        </span>
                                    </td>
                                    <td className="px-3 py-2.5 text-right tabular-nums text-gray-700 text-xs">
                                        {Number(pub.qte_vendue_pub).toLocaleString("fr-FR")}
                                    </td>
                                    <td className="px-3 py-2.5 text-right tabular-nums text-gray-700 text-xs">
                                        {Number(pub.client_pub_periode).toLocaleString("fr-FR")}
                                    </td>
                                    <td className="px-3 py-2.5 text-right tabular-nums text-gray-700 text-xs">
                                        {Number(pub.taux_sortie).toFixed(1).replace(".", ",")} %
                                    </td>
                                    <td className="px-3 py-2.5 text-right tabular-nums text-gray-500 text-xs">
                                        {pub.nb_articles}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                        <tfoot>
                            <tr className="border-t-2 border-gray-300 bg-gray-50">
                                <td colSpan={5} className="px-4 py-3 text-sm font-bold text-gray-800">
                                    TOTAL — {filtered.length} publicités
                                </td>
                                <td className="bg-orange-100 px-3 py-3 text-right font-bold tabular-nums text-gray-900">
                                    {fmtCA(filtered.reduce((s, p) => s + Number(p.ca_pub_periode_pub), 0))}
                                </td>
                                <td className="bg-orange-100 px-3 py-3 text-right tabular-nums text-xs font-semibold text-orange-700">
                                    —
                                </td>
                                <td className="px-3 py-3 text-right font-bold tabular-nums text-gray-700 text-xs">
                                    {filtered.reduce((s, p) => s + Number(p.qte_vendue_pub), 0).toLocaleString("fr-FR")}
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
