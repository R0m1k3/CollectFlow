import { redirect } from "next/navigation";

/** Ancienne adresse, conservée pour les favoris : voir /historique. */
export default function SnapshotsPage() {
    redirect("/historique");
}
