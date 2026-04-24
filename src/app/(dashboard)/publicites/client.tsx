"use client";

import { useRouter } from "next/navigation";
import { useState, useMemo } from "react";
import { ChevronUp, ChevronDown, ChevronsUpDown, ChevronLeft, ChevronRight } from "lucide-react";
import type { Publicite, PubliciteHistorique } from "./page";

function fmtDate(iso: string) {
    return new Date(iso).toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric" });
}
function fmtCA(v: number | string) {
    return new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(Number(v));
}
function fmtPct(v: number | string) {
    return Number(v).toFixed(2).replace(".", ",") + " %";
}

type SortKey = "intitule" | "site" | "ca_pub_periode_pub" | "pourc_capub_catotal" | "qte_vendue_pub" | "taux_sortie" | "statut";
type SortDir = "asc" | "desc";

function SortIcon({ col, sortKey, sortDir }: { col: SortKey; sortKey: SortKey; sortDir: SortDir }) {
    if (col !== sortKey) return <ChevronsUpDown className="inline w-3 h-3 ml-1 opacity-30" />;
    return sortDir === "asc" ? <ChevronUp className="inline w-3 h-3 ml-1" /> : <ChevronDown className="inline w-3 h-3 ml-1" />;
}

const STATUT_LABELS: Record<string, { label: string; cls: string }> = {
    en_cours:  { label: "En cours",  cls: "bg-emerald-100 text-emerald-700" },
    passee:    { label: "Passée",    cls: "bg-gray-100 text-gray-600" },
    a_venir:   { label: "À venir",   cls: "bg-blue-100 text-blue-700" },
};

function StatutBadge({ statut }: { statut?: string }) {
    const s = statut ?? "";
    const cfg = STATUT_LABELS[s] ?? { label: s || "—", cls: "bg-gray-100 text-gray-500" };
    return (
        <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold whitespace-nowrap ${cfg.cls}`}>
            {cfg.label}
        </span>
    );
}

interface Props {
    vue: string;
    statut: string;
    page: number;
    publicites: Publicite[];
    total: number;
    pages: number;
    historique: PubliciteHistorique[];
}

export function PublicitesClient({ vue, statut, page, publicites, total, pages, historique }: Props) {
    const router = useRouter();

    const [filterSite, setFilterSite] = useState<string>("all");
    const [sortKey, setSortKey]       = useState<SortKey>("intitule");
    const [sortDir, setSortDir]       = useState<SortDir>("asc");

    function nav(params: Record<string, string | number>) {
        const sp = new URLSearchParams({
            vue, statut, page: String(page), ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
        });
        router.push(`/publicites?${sp}`);
    }

    const validPublicites = useMemo(() => publicites.filter(p => p.site !== "000"), [publicites]);

    const sites = useMemo(() => {
        const s = new Set(validPublicites.map(p => p.site).filter(Boolean));
        return Array.from(s).sort();
    }, [validPublicites]);

    const SITE_COLORS: Record<string, string> = useMemo(() => {
        const palette = [
            "bg-blue-50 text-blue-700", "bg-violet-50 text-violet-700",
            "bg-emerald-50 text-emerald-700", "bg-rose-50 text-rose-700",
            "bg-amber-50 text-amber-700", "bg-cyan-50 text-cyan-700",
        ];
        return Object.fromEntries(sites.map((s, i) => [s, palette[i % palette.length]]));
    }, [sites]);

    function handleSort(key: SortKey) {
        if (sortKey === key) setSortDir(d => d === "asc" ? "desc" : "asc");
        else { setSortKey(key); setSortDir("asc"); }
    }

    const filtered = useMemo(() => {
        let rows = filterSite === "all" ? validPublicites : validPublicites.filter(p => p.site === filterSite);
        return [...rows].sort((a, b) => {
            const va = (sortKey === "intitule" || sortKey === "site" || sortKey === "statut")
                ? String(a[sortKey] ?? "").toLowerCase()
                : Number(a[sortKey as keyof Publicite]);
            const vb = (sortKey === "intitule" || sortKey === "site" || sortKey === "statut")
                ? String(b[sortKey] ?? "").toLowerCase()
                : Number(b[sortKey as keyof Publicite]);
            if (va < vb) return sortDir === "asc" ? -1 : 1;
            if (va > vb) return sortDir === "asc" ? 1 : -1;
            return 0;
        });
    }, [validPublicites, filterSite, sortKey, sortDir]);

    function thProps(key: SortKey, cls = "") {
        return { className: `${cls} cursor-pointer select-none hover:bg-gray-100 transition-colors`, onClick: () => handleSort(key) };
    }

    const isHistorique = vue === "historique";

    return (
        <div className="space-y-4">
            {/* ── Onglets ── */}
            <div className="flex gap-2 border-b border-gray-200">
                {[
                    { key: "publicites", label: `Publicités${total ? ` (${total})` : ""}` },
                    { key: "historique", label: `Historique${historique.length ? ` (${historique.length})` : ""}` },
                ].map(t => (
                    <button
                        key={t.key}
                        onClick={() => nav({ vue: t.key, page: 1 })}
                        className={`px-4 py-2 text-sm font-semibold border-b-2 -mb-px transition-colors ${
                            vue === t.key
                                ? "border-orange-500 text-orange-600"
                                : "border-transparent text-gray-500 hover:text-gray-700"
                        }`}
                    >
                        {t.label}
                    </button>
                ))}
            </div>

            {/* ── Barre de contrôles ── */}
            <div className="flex flex-wrap items-end gap-4 rounded-xl bg-white px-5 py-4 shadow-sm border border-gray-100">
                {!isHistorique && (
                    <>
                        <div className="flex flex-col gap-1">
                            <label className="text-xs font-semibold text-gray-500">Statut</label>
                            <select
                                value={statut}
                                onChange={e => nav({ vue, statut: e.target.value, page: 1 })}
                                className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-orange-400 min-w-[160px]"
                            >
                                <option value="toutes">Toutes</option>
                                <option value="en_cours">En cours</option>
                                <option value="passees">Passées</option>
                                <option value="a_venir">À venir</option>
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
                                    {sites.map(s => <option key={s} value={s}>{s}</option>)}
                                </select>
                            </div>
                        )}

                        <div className="h-8 w-px bg-gray-200 self-center" />

                        <span className="rounded-full bg-gray-100 px-3 py-1 text-sm font-medium text-gray-600 self-center">
                            {total} publicité{total !== 1 ? "s" : ""} au total
                        </span>
                    </>
                )}

                {isHistorique && (
                    <span className="rounded-full bg-gray-100 px-3 py-1 text-sm font-medium text-gray-600 self-center">
                        {historique.length} opération{historique.length !== 1 ? "s" : ""}
                    </span>
                )}
            </div>

            {/* ── Vue Publicités ── */}
            {!isHistorique && (
                <>
                    <div className="overflow-x-auto rounded-xl bg-white shadow-sm border border-gray-100">
                        {filtered.length === 0 ? (
                            <div className="py-16 text-center text-gray-400 text-sm">Aucune publicité trouvée.</div>
                        ) : (
                            <table className="w-full border-collapse text-sm">
                                <thead>
                                    <tr className="border-b-2 border-gray-200 bg-gray-50">
                                        <th className="px-3 py-3 text-left text-xs font-semibold text-gray-500 w-20">N°</th>
                                        <th {...thProps("intitule", "px-3 py-3 text-left text-xs font-semibold text-gray-500")}>
                                            Opération <SortIcon col="intitule" sortKey={sortKey} sortDir={sortDir} />
                                        </th>
                                        <th {...thProps("statut", "px-3 py-3 text-left text-xs font-semibold text-gray-500 whitespace-nowrap")}>
                                            Statut <SortIcon col="statut" sortKey={sortKey} sortDir={sortDir} />
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
                                        <tr key={`${pub.tcr_code}-${pub.site}-${idx}`} className="border-b border-gray-100 hover:bg-gray-50 transition-colors">
                                            <td className="px-3 py-2.5 font-mono text-xs text-gray-400">{pub.tcr_code}</td>
                                            <td className="px-3 py-2.5 text-gray-900 font-medium">{pub.intitule}</td>
                                            <td className="px-3 py-2.5"><StatutBadge statut={pub.statut} /></td>
                                            <td className="px-3 py-2.5 text-xs text-gray-600 whitespace-nowrap">
                                                <span className={`inline-block rounded-md px-2 py-0.5 font-medium ${SITE_COLORS[pub.site] ?? "bg-gray-100 text-gray-600"}`}>
                                                    {pub.site || "—"}
                                                </span>
                                            </td>
                                            <td className="px-3 py-2.5 text-center text-xs text-gray-600 whitespace-nowrap tabular-nums">{fmtDate(pub.date_debut)}</td>
                                            <td className="px-3 py-2.5 text-center text-xs text-gray-600 whitespace-nowrap tabular-nums">{fmtDate(pub.date_fin)}</td>
                                            <td className="bg-orange-50/60 px-3 py-2.5 text-right font-semibold tabular-nums text-gray-900">{fmtCA(pub.ca_pub_periode_pub)}</td>
                                            <td className="bg-orange-50/60 px-3 py-2.5 text-right tabular-nums">
                                                <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${
                                                    Number(pub.pourc_capub_catotal) >= 20 ? "bg-orange-100 text-orange-700"
                                                    : Number(pub.pourc_capub_catotal) >= 10 ? "bg-amber-100 text-amber-700"
                                                    : "bg-gray-100 text-gray-600"
                                                }`}>
                                                    {fmtPct(pub.pourc_capub_catotal)}
                                                </span>
                                            </td>
                                            <td className="px-3 py-2.5 text-right tabular-nums text-gray-700 text-xs">{Number(pub.qte_vendue_pub).toLocaleString("fr-FR")}</td>
                                            <td className="px-3 py-2.5 text-right tabular-nums text-gray-700 text-xs">{Number(pub.client_pub_periode).toLocaleString("fr-FR")}</td>
                                            <td className="px-3 py-2.5 text-right tabular-nums text-gray-700 text-xs">{Number(pub.taux_sortie).toFixed(1).replace(".", ",")} %</td>
                                            <td className="px-3 py-2.5 text-right tabular-nums text-gray-500 text-xs">{pub.nb_articles}</td>
                                        </tr>
                                    ))}
                                </tbody>
                                <tfoot>
                                    <tr className="border-t-2 border-gray-300 bg-gray-50">
                                        <td colSpan={6} className="px-4 py-3 text-sm font-bold text-gray-800">
                                            TOTAL — {filtered.length} publicité{filtered.length !== 1 ? "s" : ""} (page {page}/{pages})
                                        </td>
                                        <td className="bg-orange-100 px-3 py-3 text-right font-bold tabular-nums text-gray-900">
                                            {fmtCA(filtered.reduce((s, p) => s + Number(p.ca_pub_periode_pub), 0))}
                                        </td>
                                        <td className="bg-orange-100 px-3 py-3 text-right text-xs font-semibold text-orange-700">—</td>
                                        <td className="px-3 py-3 text-right font-bold tabular-nums text-gray-700 text-xs">
                                            {filtered.reduce((s, p) => s + Number(p.qte_vendue_pub), 0).toLocaleString("fr-FR")}
                                        </td>
                                        <td colSpan={3} />
                                    </tr>
                                </tfoot>
                            </table>
                        )}
                    </div>

                    {/* ── Pagination ── */}
                    {pages > 1 && (
                        <div className="flex items-center justify-between rounded-xl bg-white px-5 py-3 shadow-sm border border-gray-100">
                            <span className="text-sm text-gray-500">
                                Page <strong>{page}</strong> sur <strong>{pages}</strong> — {total} publicités
                            </span>
                            <div className="flex items-center gap-2">
                                <button
                                    disabled={page <= 1}
                                    onClick={() => nav({ vue, statut, page: page - 1 })}
                                    className="flex items-center gap-1 rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
                                >
                                    <ChevronLeft className="w-4 h-4" /> Préc.
                                </button>
                                {/* Pages around current */}
                                {Array.from({ length: Math.min(pages, 7) }, (_, i) => {
                                    const p = pages <= 7 ? i + 1 : Math.max(1, page - 3) + i;
                                    if (p > pages) return null;
                                    return (
                                        <button
                                            key={p}
                                            onClick={() => nav({ vue, statut, page: p })}
                                            className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
                                                p === page
                                                    ? "bg-orange-500 text-white"
                                                    : "border border-gray-300 text-gray-600 hover:bg-gray-50"
                                            }`}
                                        >
                                            {p}
                                        </button>
                                    );
                                })}
                                <button
                                    disabled={page >= pages}
                                    onClick={() => nav({ vue, statut, page: page + 1 })}
                                    className="flex items-center gap-1 rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
                                >
                                    Suiv. <ChevronRight className="w-4 h-4" />
                                </button>
                            </div>
                        </div>
                    )}
                </>
            )}

            {/* ── Vue Historique ── */}
            {isHistorique && (
                <div className="overflow-x-auto rounded-xl bg-white shadow-sm border border-gray-100">
                    {historique.length === 0 ? (
                        <div className="py-16 text-center text-gray-400 text-sm">Aucun historique disponible.</div>
                    ) : (
                        <table className="w-full border-collapse text-sm">
                            <thead>
                                <tr className="border-b-2 border-gray-200 bg-gray-50">
                                    <th className="px-3 py-3 text-left text-xs font-semibold text-gray-500 w-20">N°</th>
                                    <th className="px-3 py-3 text-left text-xs font-semibold text-gray-500">Opération</th>
                                    <th className="px-3 py-3 text-left text-xs font-semibold text-gray-500">Statut</th>
                                    <th className="px-3 py-3 text-center text-xs font-semibold text-gray-500 whitespace-nowrap">Date début</th>
                                    <th className="px-3 py-3 text-center text-xs font-semibold text-gray-500 whitespace-nowrap">Date fin</th>
                                    <th className="px-3 py-3 text-center text-xs font-semibold text-gray-500 whitespace-nowrap">Sites</th>
                                    <th className="px-3 py-3 text-right text-xs font-semibold text-orange-600 whitespace-nowrap bg-orange-50">CA total</th>
                                    <th className="px-3 py-3 text-right text-xs font-semibold text-gray-500 whitespace-nowrap">Qté totale</th>
                                </tr>
                            </thead>
                            <tbody>
                                {historique.map((h, idx) => (
                                    <tr key={`${h.tcr_code}-${idx}`} className="border-b border-gray-100 hover:bg-gray-50 transition-colors">
                                        <td className="px-3 py-2.5 font-mono text-xs text-gray-400">{h.tcr_code}</td>
                                        <td className="px-3 py-2.5 text-gray-900 font-medium">{h.intitule}</td>
                                        <td className="px-3 py-2.5"><StatutBadge statut={h.statut} /></td>
                                        <td className="px-3 py-2.5 text-center text-xs text-gray-600 whitespace-nowrap tabular-nums">{fmtDate(h.date_debut)}</td>
                                        <td className="px-3 py-2.5 text-center text-xs text-gray-600 whitespace-nowrap tabular-nums">{fmtDate(h.date_fin)}</td>
                                        <td className="px-3 py-2.5 text-center text-xs text-gray-500">{h.nb_sites}</td>
                                        <td className="bg-orange-50/60 px-3 py-2.5 text-right font-semibold tabular-nums text-gray-900">{fmtCA(h.ca_total)}</td>
                                        <td className="px-3 py-2.5 text-right tabular-nums text-gray-700 text-xs">{Number(h.qte_totale).toLocaleString("fr-FR")}</td>
                                    </tr>
                                ))}
                            </tbody>
                            <tfoot>
                                <tr className="border-t-2 border-gray-300 bg-gray-50">
                                    <td colSpan={6} className="px-4 py-3 text-sm font-bold text-gray-800">
                                        TOTAL — {historique.length} opérations
                                    </td>
                                    <td className="bg-orange-100 px-3 py-3 text-right font-bold tabular-nums text-gray-900">
                                        {fmtCA(historique.reduce((s, h) => s + Number(h.ca_total), 0))}
                                    </td>
                                    <td className="px-3 py-3 text-right font-bold tabular-nums text-gray-700 text-xs">
                                        {historique.reduce((s, h) => s + Number(h.qte_totale), 0).toLocaleString("fr-FR")}
                                    </td>
                                </tr>
                            </tfoot>
                        </table>
                    )}
                </div>
            )}
        </div>
    );
}
