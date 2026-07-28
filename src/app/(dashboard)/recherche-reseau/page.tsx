import { RechercheReseauClient } from "./client";

export const metadata = {
    title: "Recherche réseau — CollectFlow",
};

/**
 * Recherche dans le catalogue réseau Qlik.
 *
 * Contrairement à la Grille (qui part de NOTRE catalogue), cette page interroge
 * Qlik en premier : elle affiche donc aussi les produits vendus par le réseau
 * que FF Nancy ne référence pas. Tout le travail est fait côté client via
 * /api/qlik/search (job asynchrone), l'extraction Qlik prenant ~20-40 s.
 */
export default function RechercheReseauPage() {
    return <RechercheReseauClient />;
}
