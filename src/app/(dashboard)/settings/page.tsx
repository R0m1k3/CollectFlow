import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { verifierAdmin } from "@/lib/authz";
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
    // Le middleware filtre déjà sur le rôle du jeton ; ici, rôle relu en base.
    if (!(await verifierAdmin()).ok) redirect("/dashboard");

    const { onglet } = await props.searchParams;
    return <ParametresClient onglet={onglet} />;
}
