import { PageSkeleton } from "@/components/ui/states";

/** Silhouette de la page pendant le chargement, sans bloquer l'écran. */
export default function Loading() {
    return <PageSkeleton rows={8} />;
}
