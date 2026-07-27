"use client";

import { useState } from "react";
import Link from "next/link";
import { Loader2, TrendingUp } from "lucide-react";
import type { PgOpportuniteRow } from "@/lib/pg-ff-client";

const fmtQte = (v: number) => new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 }).format(v);
const fmtDec = (v: number) => new Intl.NumberFormat("fr-FR", { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(v);

/**
 * Produits de la même famille que le produit affiché, classés par écart de
 * performance réseau vs locale (quantité **par magasin**, pour neutraliser
 * l'écart d'échelle entre ~270 magasins et nos 2 sites).
 *
 * Chargement à la demande : la requête agrège 12 mois de mouvements pour toute
 * la famille, elle ne doit pas ralentir l'ouverture de la fiche.
 */
export function OpportunitesFamille({
    nomNoId,
    currentCodein,
    familleLabel,
}: {
    nomNoId: number;
    currentCodein: string;
    familleLabel: string;
}) {
    const [rows, setRows] = useState<PgOpportuniteRow[] | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function load() {
        setLoading(true);
        setError(null);
        try {
            const res = await fetch(`/api/produits/opportunites?nomNoId=${nomNoId}`, { cache: "no-store" });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
            setRows((data.rows ?? []) as PgOpportuniteRow[]);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setLoading(false);
        }
    }

    if (rows === null) {
        return (
            <div className="space-y-2">
                <p className="text-[13px]" style={{ color: "var(--text-secondary)" }}>
                    Comparer ce produit aux autres références{familleLabel ? ` de « ${familleLabel} »` : " de la même famille"} :
                    lesquelles le réseau vend bien et que nous vendons peu ?
                </p>
                <button onClick={load} disabled={loading} className="btn-action btn-action-secondary flex items-center gap-1.5 disabled:opacity-60">
                    {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <TrendingUp className="w-3.5 h-3.5" />}
                    {loading ? "Analyse…" : "Analyser la famille"}
                </button>
                {error && <p className="text-[12px]" style={{ color: "var(--accent-error)" }}>{error}</p>}
            </div>
        );
    }

    // On retire le produit courant : il est déjà détaillé au-dessus.
    const others = rows.filter((r) => r.codein !== currentCodein);

    if (others.length === 0) {
        return (
            <p className="text-[13px]" style={{ color: "var(--text-muted)" }}>
                Aucune autre référence de cette famille n&apos;a de données réseau en cache.
                Synchronisez d&apos;autres fournisseurs pour enrichir la comparaison.
            </p>
        );
    }

    return (
        <div className="space-y-2">
            <div className="overflow-x-auto rounded-xl" style={{ border: "1px solid var(--border)" }}>
                <table className="w-full border-collapse text-[12px]">
                    <thead>
                        <tr style={{ background: "var(--bg-elevated)" }}>
                            <th className="px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>Produit</th>
                            <th className="px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>Fournisseur</th>
                            <th className="px-3 py-2 text-right text-[10px] font-semibold uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>Réseau / mag.</th>
                            <th className="px-3 py-2 text-right text-[10px] font-semibold uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>Nous / mag.</th>
                            <th className="px-3 py-2 text-right text-[10px] font-semibold uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>Écart</th>
                            <th className="px-3 py-2 text-right text-[10px] font-semibold uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>Magasins</th>
                        </tr>
                    </thead>
                    <tbody>
                        {others.map((r) => {
                            const opportunite = r.ecart_par_magasin > 0;
                            return (
                                <tr key={r.codein} className="transition-colors hover:bg-[var(--bg-elevated)]" style={{ borderTop: "1px solid var(--border)" }}>
                                    <td className="px-3 py-2">
                                        <Link
                                            href={`/produits?codein=${encodeURIComponent(r.codein)}`}
                                            className="font-medium hover:underline"
                                            style={{ color: "var(--accent)" }}
                                        >
                                            {r.libelle1 || r.codein}
                                        </Link>
                                    </td>
                                    <td className="px-3 py-2" style={{ color: "var(--text-secondary)" }}>{r.fournisseur}</td>
                                    <td className="px-3 py-2 text-right tabular-nums" style={{ color: "var(--text-secondary)" }}>
                                        {fmtDec(r.qte_reseau_par_magasin)}
                                    </td>
                                    <td className="px-3 py-2 text-right tabular-nums" style={{ color: "var(--text-secondary)" }}>
                                        {fmtDec(r.qte_locale_par_magasin)}
                                    </td>
                                    <td
                                        className="px-3 py-2 text-right tabular-nums font-semibold"
                                        style={{ color: opportunite ? "#f59e0b" : "#22c55e" }}
                                        title={opportunite
                                            ? "Le réseau vend plus que nous sur ce produit"
                                            : "Nous vendons autant ou plus que le réseau"}
                                    >
                                        {r.ecart_par_magasin > 0 ? "+" : ""}{fmtDec(r.ecart_par_magasin)}
                                    </td>
                                    <td className="px-3 py-2 text-right tabular-nums text-[11px]" style={{ color: "var(--text-muted)" }}>
                                        {fmtQte(r.nb_magasins_reseau)}
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
            <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>
                Écart = quantité réseau par magasin − notre quantité par magasin, sur 12 mois.
                Un écart positif signale une référence sous-exploitée chez nous.
                Périmètre : les articles <strong>de notre catalogue</strong> ayant déjà des données réseau —
                Qlik est interrogé par code article, un produit que Nancy ne référence pas ne peut pas apparaître ici.
            </p>
        </div>
    );
}
