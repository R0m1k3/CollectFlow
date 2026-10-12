import { Navigate } from "react-router";

/** Ancienne adresse, conservée pour les favoris : voir /historique. */
export default function SnapshotsPage() {
    return <Navigate to="/historique" replace />;
}
