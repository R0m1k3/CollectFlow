import LoadingModal from "@/components/shared/loading-modal";

export default function DashboardLoading() {
    return <LoadingModal message="Chargement des données" subMessage="Récupération du tableau de bord..." />;
}
