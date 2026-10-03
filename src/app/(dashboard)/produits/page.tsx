import type { Metadata } from "next";
import { PackageSearch, SearchX } from "lucide-react";
import { getProduitFiche, getProduitFicheByCodeCentrale } from "@/features/produits/api/get-produit-fiche";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/states";
import { Terme } from "@/components/ui/tooltip";
import { ProduitSearchBar } from "./search-bar";
import { ProduitResults } from "./results";
import { ProduitFicheView } from "./fiche";

export const metadata: Metadata = { title: "Recherche produit" };

export const dynamic = "force-dynamic";

/**
 * Recherche produit — **Qlik d'abord**, catalogue FF Nancy ensuite.
 *
 * - `?q=…`      → liste de résultats (chargée côté client : l'extraction Qlik
 *                 prend plusieurs secondes, on ne bloque pas le rendu serveur)
 * - `?codein=…` → fiche d'un produit de notre catalogue (URL partageable)
 * - `?cc=…`     → fiche d'un produit du réseau par son code centrale, qu'il
 *                 soit référencé chez nous ou non
 */
export default async function ProduitsPage(props: {
    searchParams: Promise<{ q?: string; codein?: string; cc?: string }>;
}) {
    const searchParams = await props.searchParams;
    const q = (searchParams.q ?? "").trim();
    const codein = (searchParams.codein ?? "").trim();
    const codeCentrale = (searchParams.cc ?? "").trim();

    const fiche = codein
        ? await getProduitFiche(codein)
        : codeCentrale
            ? await getProduitFicheByCodeCentrale(codeCentrale)
            : null;
    const ficheDemandee = Boolean(codein || codeCentrale);

    return (
        <div className="mx-auto w-full max-w-screen-2xl">
            <PageHeader
                icon={PackageSearch}
                title="Recherche produit"
                description={
                    <>
                        Cherchez un produit par son nom ou son code, puis comparez ses ventes à celles des
                        magasins du <Terme id="reseau">réseau.</Terme>
                    </>
                }
            />

            <div className="space-y-6">
                {/* key : remonte le champ quand l'URL change (retour arrière, lien partagé) */}
                <ProduitSearchBar key={q} initialQuery={q} />

                {ficheDemandee && !fiche && (
                    <EmptyState
                        icon={SearchX}
                        title="Produit introuvable"
                        description={
                            codein ? (
                                <>Aucun produit de notre catalogue ne porte le code article <span className="font-mono">{codein}</span>.</>
                            ) : (
                                <>
                                    Le code centrale <span className="font-mono">{codeCentrale}</span> n&apos;est ni dans notre
                                    catalogue, ni dans les données du réseau déjà chargées. Relancez une recherche par le nom
                                    ou le code du produit.
                                </>
                            )
                        }
                    />
                )}

                {fiche && <ProduitFicheView fiche={fiche} backQuery={q} />}

                {!ficheDemandee && <ProduitResults query={q} />}
            </div>
        </div>
    );
}
