import { SynchronisationClient } from "./client";

export const metadata = {
    title: "Synchronisation nocturne — CollectFlow",
};

/**
 * Paramétrage de la synchronisation nocturne des fournisseurs.
 *
 * L'accès admin est déjà imposé par le middleware (préfixe /admin) ; les routes
 * /api/admin/sync revérifient le rôle côté serveur.
 */
export default function SynchronisationPage() {
    return <SynchronisationClient />;
}
