import { AdminOnly } from "@/components/shared/admin-only";
import { SynchronisationClient } from "./client";

/**
 * Paramétrage de la synchronisation nocturne des fournisseurs.
 *
 * L'accès admin est déjà imposé par le serveur (préfixe /admin, rôle relu en
 * base) ; la page le revérifie pour une navigation dans l'application.
 */
export default function SynchronisationPage() {
    return (
        <AdminOnly>
            <SynchronisationClient />
        </AdminOnly>
    );
}
