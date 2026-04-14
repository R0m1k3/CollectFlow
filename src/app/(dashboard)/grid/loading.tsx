import LoadingModal from "@/components/shared/loading-modal";

export default function GridLoading() {
    return <LoadingModal message="Chargement des données" subMessage="Récupération des articles et calcul des scores..." />;
}
