import LoadingModal from "@/components/shared/loading-modal";

export default function StockNegatifLoading() {
    return <LoadingModal message="Chargement des données" subMessage="Récupération des stocks négatifs..." />;
}
