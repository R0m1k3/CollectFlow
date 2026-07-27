import { pgSearchProduits } from "@/lib/pg-ff-client";
import { getProduitFiche } from "@/features/produits/api/get-produit-fiche";
import { ProduitSearchBar } from "./search-bar";
import { ProduitResults } from "./results";
import { ProduitFicheView } from "./fiche";

export const dynamic = "force-dynamic";

/**
 * Recherche produit : par libellé ou par code centrale.
 *
 * - `?q=…`      → liste de résultats
 * - `?codein=…` → fiche complète (URL partageable)
 */
export default async function ProduitsPage(props: {
    searchParams: Promise<{ q?: string; codein?: string }>;
}) {
    const searchParams = await props.searchParams;
    const q = (searchParams.q ?? "").trim();
    const codein = (searchParams.codein ?? "").trim();

    const fiche = codein ? await getProduitFiche(codein) : null;
    // On ne relance pas la recherche quand une fiche est ouverte : la liste
    // reste accessible via le lien retour, qui conserve `q`.
    const results = !codein && q.length >= 3 ? await pgSearchProduits(q) : [];

    return (
        <div className="w-full max-w-screen-2xl mx-auto space-y-6">
            <header className="space-y-1">
                <h1 className="text-2xl font-semibold tracking-[-0.4px]" style={{ color: "var(--text-primary)" }}>
                    Recherche produit
                </h1>
                <p className="text-[13px]" style={{ color: "var(--text-muted)" }}>
                    Par libellé ou par code centrale — ventes sur 12 mois glissants et données réseau Qlik.
                </p>
            </header>

            {/* key : remonte le champ quand l'URL change (retour arrière, lien partagé) */}
            <ProduitSearchBar key={q} initialQuery={q} />

            {codein && !fiche && (
                <div
                    className="rounded-xl p-6 text-center text-[13px]"
                    style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)", color: "var(--text-muted)" }}
                >
                    Aucun produit trouvé pour le code article <span className="font-mono">{codein}</span>.
                </div>
            )}

            {fiche && <ProduitFicheView fiche={fiche} backQuery={q} />}

            {!codein && (
                <ProduitResults rows={results} query={q} />
            )}
        </div>
    );
}
