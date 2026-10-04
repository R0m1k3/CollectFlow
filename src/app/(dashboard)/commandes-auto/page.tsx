import type { Metadata } from "next";
import { ShoppingCart } from "lucide-react";
import { pgGetCommandesAuto, type PgCommandeAutoRow } from "@/lib/pg-ff-client";
import { listCadences, getFournisseursPourCadence } from "@/features/commandes-auto/actions";
import { PageHeader } from "@/components/ui/page-header";
import { CommandesAutoTabs, type Onglet } from "./tabs";
import { cachedFF } from "@/lib/ff-cache";

export type { PgCommandeAutoRow };

export const metadata: Metadata = { title: "Commandes fournisseurs" };

// Données live (DB + API FF Nancy) : rendu à la requête, jamais prérendu au build.
export const dynamic = "force-dynamic";

export default async function CommandesAutoPage(props: { searchParams: Promise<{ onglet?: string | string[] }> }) {
    const { onglet } = await props.searchParams;
    const ongletInitial: Onglet = onglet === "cadencier" ? "cadencier" : "propositions";

    const [rows, cadences, fournisseurs] = await Promise.all([
        // Propositions de l'API FF (un appel, plus un par fournisseur sans franco) :
        // gardées 2 minutes, pour que chaque modification du cadencier — qui
        // re-rend la page — n'attende pas de nouveau toute l'API.
        cachedFF("commandes-auto", () => pgGetCommandesAuto(), {
            ttlMs: 2 * 60 * 1000,
            cacheIf: (rows) => rows.length > 0,
        }),
        listCadences(),
        getFournisseursPourCadence(),
    ]);

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
