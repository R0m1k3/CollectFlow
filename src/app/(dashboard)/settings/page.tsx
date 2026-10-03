import type { Metadata } from "next";
import { ParametresClient } from "./client";

export const metadata: Metadata = { title: "Paramètres" };

/**
 * Paramètres (administrateurs) : connexions aux sources de données, comptes
 * utilisateurs, accès à l'API et journal serveur, rangés en onglets.
 *
 * Composant serveur minimal : il lit l'onglet demandé (`?onglet=`) pour que le
 * lien se partage et survive au rechargement, puis rend la page cliente.
 */
export default async function SettingsPage(props: { searchParams: Promise<{ onglet?: string }> }) {
    const { onglet } = await props.searchParams;
    return <ParametresClient onglet={onglet} />;
}
