import type { ReactNode } from "react";
import { Navigate } from "react-router";
import { useSessionResolue } from "next-auth/react";

/**
 * Pages réservées aux administrateurs : le serveur filtre déjà l'accès direct
 * (rôle relu en base) ; ici, la même règle pour une navigation dans
 * l'application — retour à l'accueil sinon.
 */
export function AdminOnly({ children }: { children: ReactNode }) {
    const session = useSessionResolue();
    if (session?.user.role !== "admin") return <Navigate to="/dashboard" replace />;
    return <>{children}</>;
}
