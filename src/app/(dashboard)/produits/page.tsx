import { getProduitFiche, getProduitFicheByCodeCentrale } from "@/features/produits/api/get-produit-fiche";
import { ProduitSearchBar } from "./search-bar";
import { ProduitResults } from "./results";
import { ProduitFicheView } from "./fiche";

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
        <div className="w-full max-w-screen-2xl mx-auto space-y-6">
            <header className="space-y-1">
                <h1 className="text-2xl font-semibold tracking-[-0.4px]" style={{ color: "var(--text-primary)" }}>
                    Recherche produit
                </h1>
                <p className="text-[13px]" style={{ color: "var(--text-muted)" }}>
                    Recherche dans Qlik Sense (réseau) puis rapprochement avec notre catalogue —
                    performance réseau et ventes locales sur 12 mois glissants.
                </p>
            </header>

            {/* key : remonte le champ quand l'URL change (retour arrière, lien partagé) */}
            <ProduitSearchBar key={q} initialQuery={q} />

            {ficheDemandee && !fiche && (
                <div
                    className="rounded-xl p-6 text-center text-[13px]"
                    style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)", color: "var(--text-muted)" }}
                >
                    Aucun produit trouvé pour{" "}
                    {codein
                        ? <>le code article <span className="font-mono">{codein}</span></>
                        : <>le code centrale <span className="font-mono">{codeCentrale}</span></>}.
                    {codeCentrale && !codein && (
                        <div className="mt-1">
                            Ce code n&apos;est ni dans notre catalogue, ni dans le cache réseau — relancez la recherche.
                        </div>
                    )}
                </div>
            )}

            {fiche && <ProduitFicheView fiche={fiche} backQuery={q} />}

            {!ficheDemandee && <ProduitResults query={q} />}
        </div>
    );
}
