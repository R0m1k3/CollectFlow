import { AdminOnly } from "@/components/shared/admin-only";
import { usePageSearchParams } from "@/lib/page-data";
import { ParametresClient } from "./client";

/**
 * Paramètres (administrateurs) : connexions aux sources de données, comptes
 * utilisateurs, accès à l'API et journal serveur, rangés en onglets.
 *
 * Page minimale : elle lit l'onglet demandé (`?onglet=`) pour que le lien se
 * partage et survive au rechargement, puis rend la page cliente.
 */
export default function SettingsPage() {
    const { onglet } = usePageSearchParams();
    return (
        <AdminOnly>
            <ParametresClient onglet={onglet} />
        </AdminOnly>
    );
}
