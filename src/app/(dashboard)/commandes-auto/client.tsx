"use client";

import { useMemo, useState } from "react";
import { ChevronUp, ChevronDown, ChevronsUpDown, CheckCircle2, AlertCircle, Minus } from "lucide-react";
import type { PgCommandeAutoRow } from "./page";

type SortDir = "asc" | "desc";

const SITES: { code: string; label: string }[] = [
    { code: "292", label: "292 — Frouard / Nancy" },
    { code: "579", label: "579 — Houdemont" },
];

function fmt(n: number) {
    return n.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";
}

function SortIcon({ col, sortKey, sortDir }: { col: string; sortKey: string; sortDir: SortDir }) {
    if (col !== sortKey) return <ChevronsUpDown className="inline w-3 h-3 ml-1 opacity-30" />;
    return sortDir === "asc"
        ? <ChevronUp className="inline w-3 h-3 ml-1" />
        : <ChevronDown className="inline w-3 h-3 ml-1" />;
}

type SK = keyof PgCommandeAutoRow;
const NUMERIC: SK[] = ["franco", "nb_articles", "montant_cde"];

function FrancoCell({ atteint, ecart, franco }: { atteint: boolean | null; ecart: number; franco: number }) {
    if (franco === 0 || atteint === null) {
        return (
            <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-500">
                <Minus className="w-3 h-3" /> Pas de franco
            </span>
        );
    }
    if (atteint) {
        return (
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-semibold text-emerald-700">
                <CheckCircle2 className="w-3 h-3" /> Atteint
            </span>
        );
    }
    return (
        <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-semibold text-amber-700">
            <AlertCircle className="w-3 h-3" /> −{fmt(Math.abs(ecart))} manquant
        </span>
    );
}

function StoreTable({ site, label, rows }: { site: string; label: string; rows: PgCommandeAutoRow[] }) {
    const [sortKey, setSortKey] = useState<SK>("nomfou");
    const [sortDir, setSortDir] = useState<SortDir>("asc");
    const [search, setSearch] = useState("");

    function handleSort(key: SK) {
        if (sortKey === key) setSortDir(d => d === "asc" ? "desc" : "asc");
        else { setSortKey(key); setSortDir("asc"); }
    }

    const filtered = useMemo(() => {
        const q = search.toLowerCase();
        return rows.filter(r => !q || r.nomfou.toLowerCase().includes(q) || r.codefou.toLowerCase().includes(q));
    }, [rows, search]);

    const sorted = useMemo(() => [...filtered].sort((a, b) => {
        const av = a[sortKey];
        const bv = b[sortKey];
        if (NUMERIC.includes(sortKey)) {
            return sortDir === "asc" ? Number(av) - Number(bv) : Number(bv) - Number(av);
        }
        return sortDir === "asc"
            ? String(av ?? "").localeCompare(String(bv ?? ""), "fr")
            : String(bv ?? "").localeCompare(String(av ?? ""), "fr");
    }), [filtered, sortKey, sortDir]);

    const nbFrancoAtteint = rows.filter(r => r.franco_atteint === true).length;
    const totalMontant = rows.reduce((s, r) => s + Number(r.montant_cde), 0);

    const th = (key: SK, label: string, right = false) => (
        <th
            className={[
                "cursor-pointer select-none whitespace-nowrap px-3 py-2.5 text-xs font-semibold text-gray-600 uppercase tracking-wide hover:text-gray-900",
                right ? "text-right" : "text-left",
            ].join(" ")}
            onClick={() => handleSort(key)}
        >
            {label}<SortIcon col={key as string} sortKey={sortKey as string} sortDir={sortDir} />
        </th>
    );

    return (
        <div className="space-y-3">
            {/* En-tête magasin */}
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                    <h2 className="text-lg font-bold text-gray-900">{label}</h2>
                    <span className="rounded-full bg-blue-100 px-2.5 py-0.5 text-xs font-semibold text-blue-700">
                        {rows.length} fournisseur{rows.length !== 1 ? "s" : ""}
                    </span>
                    {nbFrancoAtteint > 0 && (
                        <span className="rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-semibold text-emerald-700">
                            {nbFrancoAtteint} franco atteint
                        </span>
                    )}
                    <span className="text-sm text-gray-500">
                        Total : <span className="font-semibold text-gray-800">{fmt(totalMontant)}</span>
                    </span>
                </div>
                <input
                    type="text"
                    placeholder="Rechercher un fournisseur…"
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 min-w-[220px]"
                />
            </div>

            {/* Tableau */}
            <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
                <table className="min-w-full text-sm">
                    <thead className="bg-gray-50 border-b border-gray-200">
                        <tr>
                            {th("codefou", "Code")}
                            {th("nomfou", "Fournisseur")}
                            {th("nb_articles", "Articles", true)}
                            {th("montant_cde", "Montant CDE auto", true)}
                            {th("franco", "Franco", true)}
                            <th className="px-3 py-2.5 text-left text-xs font-semibold text-gray-600 uppercase tracking-wide">
                                Statut franco
                            </th>

                        </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                        {sorted.length === 0 && (
                            <tr>
                                <td colSpan={6} className="px-3 py-8 text-center text-gray-400">
                                    Aucun fournisseur en commande automatique
                                </td>
                            </tr>
                        )}
                        {sorted.map(row => {
                            const francoAtteint = row.franco_atteint === true;
                            const hasFranco = row.franco > 0 && row.franco_atteint !== null;
                            return (
                                <tr
                                    key={`${row.site}-${row.codefou}`}
                                    className={[
                                        "transition-colors",
                                        francoAtteint
                                            ? "bg-emerald-50/50 hover:bg-emerald-50"
                                            : "hover:bg-gray-50",
                                    ].join(" ")}
                                >
                                    <td className="px-3 py-2.5 font-mono text-xs text-gray-500">{row.codefou}</td>
                                    <td className="px-3 py-2.5 font-medium text-gray-900">{row.nomfou}</td>
                                    <td className="px-3 py-2.5 text-right tabular-nums text-gray-700">{row.nb_articles}</td>
                                    <td className={[
                                        "px-3 py-2.5 text-right tabular-nums font-semibold",
                                        francoAtteint ? "text-emerald-700" : "text-blue-700",
                                    ].join(" ")}>
                                        {fmt(Number(row.montant_cde))}
                                    </td>
                                    <td className="px-3 py-2.5 text-right tabular-nums text-gray-600">
                                        {row.franco > 0 ? fmt(Number(row.franco)) : <span className="text-gray-400">—</span>}
                                    </td>
                                    <td className="px-3 py-2.5">
                                        <FrancoCell
                                            atteint={row.franco_atteint}
                                            ecart={Number(row.ecart_franco)}
                                            franco={Number(row.franco)}
                                        />
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

export function CommandesAutoClient({ rows }: { rows: PgCommandeAutoRow[] }) {
    const bySite = useMemo(() => {
        const map = new Map<string, PgCommandeAutoRow[]>();
        for (const r of rows) {
            if (!map.has(r.site)) map.set(r.site, []);
            map.get(r.site)!.push(r);
        }
        return map;
    }, [rows]);

    if (rows.length === 0) {
        return (
            <div className="rounded-xl border border-gray-200 bg-white p-12 text-center text-gray-400 shadow-sm">
                Aucune commande automatique trouvée.
            </div>
        );
    }

    return (
        <div className="space-y-8">
            {SITES.map(({ code, label }) => {
                const siteRows = bySite.get(code) ?? [];
                return (
                    <StoreTable key={code} site={code} label={label} rows={siteRows} />
                );
            })}
        </div>
    );
}
