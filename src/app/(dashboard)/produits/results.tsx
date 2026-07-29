"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { PackageSearch, Loader2, RefreshCw, AlertTriangle, Database, Globe } from "lucide-react";
import { TrendSparkline } from "@/features/grid/components/network-charts";
import { computeNetworkTrend, NB_MAGASINS_RESEAU } from "@/features/grid/lib/network-trend";
import type { ProduitRechercheResultat, ProduitRechercheRow } from "@/features/produits/types";

const fmtQte = (v: number) => new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 }).format(v);
const fmtDec = (v: number, d = 1) =>
    new Intl.NumberFormat("fr-FR", { minimumFractionDigits: d, maximumFractionDigits: d }).format(v);
const fmtEur = (v: number) =>
    new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(v);
const fmtEur2 = (v: number) =>
    new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 2 }).format(v);

/**
 * Résultats de recherche produit.
 *
 * La recherche interroge **Qlik d'abord** (`/api/produits/search`) : plusieurs
 * secondes, parfois plus. On la lance donc côté client avec un état de
 * chargement explicite, plutôt que de bloquer le rendu serveur de la page.
 */
export function ProduitResults({ query }: { query: string }) {
    // `relance` mémorise la dernière demande explicite de rafraîchissement, pour
    // ne forcer le contournement du cache serveur que sur CE terme-là.
    const [relance, setRelance] = useState<{ n: number; q: string }>({ n: 0, q: "" });
    const [resultat, setResultat] = useState<{
        cle: string;
        data: ProduitRechercheResultat | null;
        error: string | null;
    } | null>(null);

    const force = relance.n > 0 && relance.q === query;
    const cle = `${query}|${force ? relance.n : 0}`;
    const tropCourt = query.trim().length < 3;

    // L'état de chargement est **dérivé** (résultat pas encore aligné sur la
    // requête courante) plutôt que posé en début d'effet : appeler setState
    // synchronement dans un effet provoque un rendu en cascade.
    const loading = !tropCourt && resultat?.cle !== cle;

    useEffect(() => {
        if (tropCourt) return;
        let annule = false;
        const url = `/api/produits/search?q=${encodeURIComponent(query)}${force ? "&force=1" : ""}`;
        fetch(url, { cache: "no-store" })
            .then(async (res) => {
                const json = await res.json();
                if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
                return json as ProduitRechercheResultat;
            })
            .then((data) => { if (!annule) setResultat({ cle, data, error: null }); })
            .catch((e) => {
                if (!annule) setResultat({ cle, data: null, error: e instanceof Error ? e.message : String(e) });
            });
        return () => { annule = true; };
    }, [cle, query, force, tropCourt]);

    const relancer = () => setRelance((r) => ({ n: r.n + 1, q: query }));
    const data = resultat?.cle === cle ? resultat.data : null;
    const error = resultat?.cle === cle ? resultat.error : null;

    if (!query) {
        return (
            <div
                className="rounded-xl p-10 text-center"
                style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)" }}
            >
                <PackageSearch className="w-8 h-8 mx-auto mb-3" style={{ color: "var(--text-muted)" }} strokeWidth={1.5} />
                <p className="text-[14px] font-medium" style={{ color: "var(--text-secondary)" }}>
                    Recherchez un produit dans le réseau
                </p>
                <p className="text-[12px] mt-1 max-w-lg mx-auto" style={{ color: "var(--text-muted)" }}>
                    La recherche interroge <strong>Qlik Sense</strong> (les ~{NB_MAGASINS_RESEAU} magasins du réseau),
                    puis rapproche chaque produit trouvé de notre catalogue.
                    Saisissez un libellé (ex. « poêle 28 ») ou un code centrale (ex. « 10000167303 »).
                </p>
            </div>
        );
    }

    if (loading) {
        return (
            <div
                className="rounded-xl p-10 text-center"
                style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)" }}
            >
                <Loader2 className="w-6 h-6 mx-auto mb-3 animate-spin" style={{ color: "var(--accent)" }} />
                <p className="text-[13px] font-medium" style={{ color: "var(--text-secondary)" }}>
                    Interrogation de Qlik Sense…
                </p>
                <p className="text-[12px] mt-1" style={{ color: "var(--text-muted)" }}>
                    Recherche des articles du réseau puis extraction de leurs ventes sur 12 mois glissants.
                    Cela peut prendre jusqu&apos;à une minute.
                </p>
            </div>
        );
    }

    if (error) {
        return (
            <div className="rounded-xl p-6" style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)" }}>
                <div className="flex items-start gap-3">
                    <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" style={{ color: "var(--accent-error)" }} />
                    <div className="min-w-0">
                        <p className="text-[13px] font-medium" style={{ color: "var(--text-primary)" }}>
                            La recherche a échoué
                        </p>
                        <p className="text-[12px] mt-0.5 break-words" style={{ color: "var(--text-muted)" }}>{error}</p>
                        <button onClick={relancer} className="btn-action btn-action-secondary mt-3 flex items-center gap-1.5">
                            <RefreshCw className="w-3.5 h-3.5" />
                            Réessayer
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    if (!data) return null;

    const { rows, source, qlikError, tronque, locauxHorsReseau, dureeMs } = data;

    return (
        <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-[12px] flex items-center gap-1.5" style={{ color: "var(--text-muted)" }}>
                    {source === "qlik" ? (
                        <Globe className="w-3.5 h-3.5" style={{ color: "var(--accent)" }} />
                    ) : (
                        <Database className="w-3.5 h-3.5" />
                    )}
                    {rows.length} produit{rows.length > 1 ? "s" : ""}
                    {source === "qlik" ? " trouvé(s) dans Qlik" : " trouvé(s) dans le catalogue local"}
                    {tronque && " (liste tronquée — affinez la recherche)"}
                    {" · "}{(dureeMs / 1000).toFixed(1)} s
                </p>
                <button onClick={relancer} className="btn-action btn-action-secondary flex items-center gap-1.5">
                    <RefreshCw className="w-3.5 h-3.5" />
                    Relancer
                </button>
            </div>

            {source === "db" && (
                <div
                    className="rounded-xl p-3 text-[12px] flex items-start gap-2"
                    style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)", color: "var(--text-secondary)" }}
                >
                    <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" style={{ color: "var(--accent-error)" }} />
                    <span>
                        Qlik n&apos;a pas pu être interrogé, la recherche s&apos;est repliée sur le catalogue local
                        (les chiffres réseau affichés viennent du dernier cache).
                        {qlikError && <span className="block mt-0.5" style={{ color: "var(--text-muted)" }}>{qlikError}</span>}
                    </span>
                </div>
            )}

            {source === "qlik" && qlikError && (
                <div
                    className="rounded-xl p-3 text-[12px] flex items-start gap-2"
                    style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)", color: "var(--text-secondary)" }}
                >
                    <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" style={{ color: "var(--accent-error)" }} />
                    <span>
                        {rows.length === 0
                            ? qlikError
                            : `Articles trouvés, mais l'extraction des mesures réseau a échoué : ${qlikError}`}
                    </span>
                </div>
            )}

            {rows.length === 0 ? (
                <div
                    className="rounded-xl p-8 text-center text-[13px]"
                    style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)", color: "var(--text-muted)" }}
                >
                    Aucun article du réseau ne correspond à « {query} ».
                </div>
            ) : (
                <ResultTable rows={rows} query={query} />
            )}

            {locauxHorsReseau.length > 0 && (
                <details className="rounded-xl" style={{ border: "1px solid var(--border)" }}>
                    <summary className="cursor-pointer px-3 py-2.5 text-[12px]" style={{ color: "var(--text-secondary)" }}>
                        {locauxHorsReseau.length} produit{locauxHorsReseau.length > 1 ? "s" : ""} de notre catalogue
                        sans correspondance réseau (pas de code centrale, ou non vendu par le réseau)
                    </summary>
                    <div className="px-3 pb-3">
                        <ul className="space-y-1">
                            {locauxHorsReseau.slice(0, 30).map((l) => (
                                <li key={l.codein} className="text-[12px]">
                                    <Link
                                        href={`/produits?codein=${encodeURIComponent(l.codein)}&q=${encodeURIComponent(query)}`}
                                        className="hover:underline"
                                        style={{ color: "var(--accent)" }}
                                    >
                                        {l.libelle1 || l.codein}
                                    </Link>
                                    <span style={{ color: "var(--text-muted)" }}>
                                        {" · "}{l.fournisseur}{" · "}<span className="font-mono">{l.codein}</span>
                                    </span>
                                </li>
                            ))}
                        </ul>
                    </div>
                </details>
            )}
        </div>
    );
}

function ResultTable({ rows, query }: { rows: ProduitRechercheRow[]; query: string }) {
    return (
        <div className="overflow-x-auto rounded-xl" style={{ border: "1px solid var(--border)" }}>
            <table className="w-full text-[13px] border-collapse">
                <thead>
                    <tr style={{ background: "var(--bg-elevated)" }}>
                        <Th>Libellé</Th>
                        <Th>Fournisseur</Th>
                        <Th>Code centrale</Th>
                        <Th align="right">Magasins</Th>
                        <Th align="right">Qté réseau</Th>
                        <Th align="right">Qté / mag.</Th>
                        <Th align="right">Prix moyen</Th>
                        <Th align="right">CA / mag.</Th>
                        <Th align="right">Marge %</Th>
                        <Th align="center">Tendance</Th>
                        <Th align="right">Nous</Th>
                    </tr>
                </thead>
                <tbody>
                    {rows.map((r) => {
                        const trend = computeNetworkTrend(r.qteByMonth);
                        const href = r.codein
                            ? `/produits?codein=${encodeURIComponent(r.codein)}&q=${encodeURIComponent(query)}`
                            : `/produits?cc=${encodeURIComponent(r.codeCentrale)}&q=${encodeURIComponent(query)}`;
                        return (
                            <tr
                                key={r.codeCentrale}
                                className="transition-colors hover:bg-[var(--bg-elevated)]"
                                style={{ borderTop: "1px solid var(--border)" }}
                            >
                                <td className="px-3 py-2 max-w-[280px]">
                                    <Link href={href} className="font-medium hover:underline" style={{ color: "var(--accent)" }}>
                                        {r.libelle || "—"}
                                    </Link>
                                    {r.nomenclature && (
                                        <div className="text-[11px] truncate" style={{ color: "var(--text-muted)" }}>{r.nomenclature}</div>
                                    )}
                                </td>
                                <td className="px-3 py-2 text-[12px]" style={{ color: "var(--text-secondary)" }}>
                                    {r.fournisseur || "—"}
                                </td>
                                <td className="px-3 py-2 font-mono text-[12px]" style={{ color: "var(--text-muted)" }}>
                                    {r.codeCentrale}
                                </td>
                                <td className="px-3 py-2 text-right tabular-nums" style={{ color: "var(--text-secondary)" }}>
                                    {fmtQte(r.nbMagasinsReseau)}
                                    <span className="text-[11px] ml-1" style={{ color: "var(--text-muted)" }}>
                                        {fmtDec(r.tauxPresence * 100, 0)} %
                                    </span>
                                </td>
                                <td className="px-3 py-2 text-right tabular-nums font-semibold" style={{ color: "var(--text-primary)" }}>
                                    {fmtQte(r.qteReseau)}
                                </td>
                                <td className="px-3 py-2 text-right tabular-nums" style={{ color: "var(--text-secondary)" }}>
                                    {fmtDec(r.qteParMagasinReseau)}
                                </td>
                                <td className="px-3 py-2 text-right tabular-nums" style={{ color: "var(--text-secondary)" }}>
                                    {r.prixMoyenReseau != null ? fmtEur2(r.prixMoyenReseau) : "—"}
                                </td>
                                <td className="px-3 py-2 text-right tabular-nums" style={{ color: "var(--text-secondary)" }}>
                                    {r.caParMagasinReseau > 0 ? fmtEur(r.caParMagasinReseau) : "—"}
                                </td>
                                <td className="px-3 py-2 text-right tabular-nums" style={{ color: "var(--text-secondary)" }}>
                                    {r.margePctReseau != null ? `${fmtDec(r.margePctReseau)} %` : "—"}
                                </td>
                                <td className="px-2 py-2 text-center">
                                    {trend.hasData ? <TrendSparkline trend={trend} /> : <span style={{ color: "var(--text-muted)" }}>—</span>}
                                </td>
                                <td className="px-3 py-2 text-right text-[12px]">
                                    {r.codein ? (
                                        <span style={{ color: "var(--text-secondary)" }} title={`Code article ${r.codein}`}>
                                            stock {fmtQte(r.stockLocal ?? 0)}
                                        </span>
                                    ) : (
                                        <span
                                            className="rounded-md px-1.5 py-0.5 text-[11px]"
                                            style={{ background: "var(--bg-elevated)", color: "var(--text-muted)", border: "1px solid var(--border)" }}
                                            title="Le réseau travaille ce produit, notre catalogue ne le référence pas"
                                        >
                                            non référencé
                                        </span>
                                    )}
                                </td>
                            </tr>
                        );
                    })}
                </tbody>
            </table>
        </div>
    );
}

function Th({ children, align = "left" }: { children: React.ReactNode; align?: "left" | "right" | "center" }) {
    // Classes littérales : Tailwind ne génère pas les classes construites dynamiquement.
    const alignClass = align === "right" ? "text-right" : align === "center" ? "text-center" : "text-left";
    return (
        <th
            className={`px-3 py-2.5 ${alignClass} text-[11px] font-semibold uppercase tracking-wide whitespace-nowrap`}
            style={{ color: "var(--text-muted)" }}
        >
            {children}
        </th>
    );
}
