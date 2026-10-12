import { Navigate } from "react-router";

/** Ancienne adresse, conservée pour les favoris : voir /historique. */
export default function ExportsPage() {
    return <Navigate to="/historique?vue=exports" replace />;
}
