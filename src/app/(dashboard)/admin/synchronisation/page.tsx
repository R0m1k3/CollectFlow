import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { verifierAdmin } from "@/lib/authz";
import { SynchronisationClient } from "./client";

export const metadata: Metadata = { title: "Synchronisation" };

/**
 * Paramétrage de la synchronisation nocturne des fournisseurs.
 *
 * L'accès admin est déjà imposé par le middleware (préfixe /admin), sur le rôle
 * du jeton ; la page le revérifie en base, comme les routes /api/admin/sync.
 */
export default async function SynchronisationPage() {
    if (!(await verifierAdmin()).ok) redirect("/dashboard");
    return <SynchronisationClient />;
}
