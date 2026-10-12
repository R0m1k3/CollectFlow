import { ShoppingCart } from "lucide-react";
import type { PgCommandeAutoRow } from "@/types/ff";
import type { CadenceView } from "@/features/commandes-auto/actions";
import { fetchPage } from "@/lib/rpc";
import { usePageData, usePageSearchParams } from "@/lib/page-data";
import { PageHeader } from "@/components/ui/page-header";
import { CommandesAutoTabs, type Onglet } from "./tabs";

export type { PgCommandeAutoRow };

/** Données de la page : propositions de l'API FF, cadencier et référentiel fournisseurs. */
interface DonneesCommandesAuto {
    rows: PgCommandeAutoRow[];
    cadences: CadenceView[];
    fournisseurs: { code: string; nom: string }[];
}

// Données live (DB + API FF Nancy) : relues à chaque affichage. Les propositions
// sont gardées 2 minutes par le serveur, pour que chaque modification du
// cadencier — qui rafraîchit la page — n'attende pas de nouveau toute l'API.
export default function CommandesAutoPage() {
    const { onglet } = usePageSearchParams();
    const ongletInitial: Onglet = onglet === "cadencier" ? "cadencier" : "propositions";

    const { rows, cadences, fournisseurs } = usePageData("commandes-auto", () =>
        fetchPage<DonneesCommandesAuto>("commandes-auto"),
    );

    return (
        <div className="mx-auto w-full max-w-screen-2xl">
            <PageHeader
                icon={ShoppingCart}
                title="Commandes fournisseurs"
                description="Propositions de commande automatique par magasin, et rappels selon le rythme de commande choisi pour chaque fournisseur."
            />
            <CommandesAutoTabs initial={ongletInitial} rows={rows} cadences={cadences} fournisseurs={fournisseurs} />
        </div>
    );
}
