import { PackageSearch, SearchX } from "lucide-react";
import type { ProduitFiche } from "@/features/produits/types";
import { fetchPage } from "@/lib/rpc";
import { usePageData, usePageSearchParams } from "@/lib/page-data";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/states";
import { Terme } from "@/components/ui/tooltip";
import { ProduitSearchBar } from "./search-bar";
import { ProduitResults } from "./results";
import { ProduitFicheView } from "./fiche";

/**
 * Recherche produit — **Qlik d'abord**, catalogue FF Nancy ensuite.
 *
 * - `?q=…`      → liste de résultats (chargée côté client : l'extraction Qlik
 *                 prend plusieurs secondes, on ne bloque pas l'affichage)
 * - `?codein=…` → fiche d'un produit de notre catalogue (URL partageable)
 * - `?cc=…`     → fiche d'un produit du réseau par son code centrale, qu'il
 *                 soit référencé chez nous ou non
 */
export default function ProduitsPage() {
    const searchParams = usePageSearchParams();
    const q = (searchParams.q ?? "").trim();
    const codein = (searchParams.codein ?? "").trim();
    const codeCentrale = (searchParams.cc ?? "").trim();

    const ficheDemandee = Boolean(codein || codeCentrale);
    const fiche = usePageData(`produit-fiche?${codein}:${codeCentrale}`, (): Promise<ProduitFiche | null> =>
        codein
            ? fetchPage<ProduitFiche | null>("produit-fiche", { codein })
            : codeCentrale
                ? fetchPage<ProduitFiche | null>("produit-fiche", { cc: codeCentrale })
                : Promise.resolve(null),
    );

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
