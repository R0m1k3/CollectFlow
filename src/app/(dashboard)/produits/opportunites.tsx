"use client";

import { useState } from "react";
import Link from "next/link";
import { Loader2, RefreshCw, TrendingUp } from "lucide-react";
import type { PgOpportuniteRow } from "@/lib/pg-ff-client";
import { Button } from "@/components/ui/button";
import { DataTable, type DataColumn } from "@/components/ui/data-table";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { GLOSSAIRE } from "@/lib/glossaire";
import { fmtDecimal1, fmtEntier } from "@/lib/format";

const COLONNES: DataColumn<PgOpportuniteRow>[] = [
    {
        id: "produit",
        header: "Produit",
        sortValue: (r) => r.libelle1 || r.codein,
        cell: (r) => (
            <Link
                href={`/produits?codein=${encodeURIComponent(r.codein)}`}
                className="font-medium text-[var(--accent)] hover:underline"
            >
                {r.libelle1 || r.codein}
            </Link>
        ),
    },
    {
        id: "fournisseur",
        header: "Fournisseur",
        sortValue: (r) => r.fournisseur,
        cell: (r) => <span className="text-[var(--text-secondary)]">{r.fournisseur}</span>,
    },
    {
        id: "reseau",
        header: "Réseau, par magasin",
        hint: "Quantité vendue sur 12 mois par un magasin du réseau qui a ce produit.",
        align: "right",
        sortValue: (r) => r.qte_reseau_par_magasin,
        cell: (r) => fmtDecimal1(r.qte_reseau_par_magasin),
    },
    {
        id: "nous",
        header: "Nous, par magasin",
        hint: "Quantité vendue sur 12 mois par chacun de nos magasins, en moyenne.",
        align: "right",
        sortValue: (r) => r.qte_locale_par_magasin,
        cell: (r) => fmtDecimal1(r.qte_locale_par_magasin),
    },
    {
        id: "ecart",
        header: "Écart",
        hint: "Réseau par magasin moins nous par magasin. Positif : le réseau vend plus que nous.",
        align: "right",
        sortValue: (r) => r.ecart_par_magasin,
        cell: (r) => {
            const opportunite = r.ecart_par_magasin > 0;
            return (
                <span
                    className="font-semibold"
                    style={{ color: opportunite ? "var(--accent-warning)" : "var(--accent-success)" }}
                    title={opportunite
                        ? "Le réseau vend plus que nous sur ce produit"
                        : "Nous vendons autant ou plus que le réseau"}
                >
                    {opportunite ? "+" : ""}{fmtDecimal1(r.ecart_par_magasin)}
                </span>
            );
        },
    },
    {
        id: "magasins",
        header: "Magasins vendeurs",
        hint: GLOSSAIRE.presenceReseau.definition,
        align: "right",
        sortValue: (r) => r.nb_magasins_reseau,
        cell: (r) => <span className="text-[var(--text-secondary)]">{fmtEntier(r.nb_magasins_reseau)}</span>,
    },
];

const rechercherDans = (r: PgOpportuniteRow) => [r.libelle1, r.fournisseur, r.codein, r.code_centrale];

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
        if (error && !loading) {
            return (
                <ErrorState
                    className="py-8"
                    title="L'analyse de la famille n'a pas pu être faite"
                    description="Réessayez dans un instant. Si le problème persiste, prévenez un administrateur."
                    detail={error}
                    action={
                        <Button variant="outline" onClick={load}>
                            <RefreshCw /> Réessayer
                        </Button>
                    }
                />
            );
        }
        return (
            <div className="space-y-3">
                <p className="text-sm text-[var(--text-secondary)]">
                    Comparez ce produit aux autres produits{familleLabel ? <> de la famille « {familleLabel} »</> : " de la même famille"} :
                    lesquels le réseau vend bien alors que nous les vendons peu ?
                </p>
                <Button variant="outline" onClick={load} disabled={loading}>
                    {loading ? <Loader2 className="animate-spin" /> : <TrendingUp />}
                    {loading ? "Analyse en cours…" : "Analyser la famille"}
                </Button>
            </div>
        );
    }

    // On retire le produit courant : il est déjà détaillé au-dessus.
    const others = rows.filter((r) => r.codein !== currentCodein);

    if (others.length === 0) {
        return (
            <EmptyState
                className="py-8"
                title="Aucun autre produit à comparer"
                description="Aucun autre produit de cette famille n'a encore de données du réseau. Mettez à jour les données du réseau d'autres fournisseurs (révision d'assortiment) pour enrichir la comparaison."
            />
        );
    }

    return (
        <div className="space-y-3">
            <DataTable
                rows={others}
                columns={COLONNES}
                rowKey={(r) => r.codein}
                searchIn={rechercherDans}
                searchPlaceholder="Filtrer les produits…"
                pageSize={25}
                unite={others.length > 1 ? "produits" : "produit"}
                maxHeight="60vh"
            />
            <p className="text-[13px] text-[var(--text-secondary)]">
                Écart = quantité vendue par magasin dans le réseau − notre quantité vendue par magasin, sur 12 mois.
                Un écart positif signale un produit sous-exploité chez nous. Seuls les produits <strong>de notre
                catalogue</strong> qui ont déjà des données du réseau apparaissent ici : un produit absent de notre
                catalogue ne peut pas y figurer.
            </p>
        </div>
    );
}
