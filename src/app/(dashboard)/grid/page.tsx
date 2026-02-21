import { getFournisseurs, getGridData, getMagasins } from "@/features/grid/actions";
import { GridClient } from "@/features/grid/components/grid-client";
import { SupplierSelectionLanding } from "@/features/grid/components/supplier-selection-landing";
import { Suspense } from "react";

interface GridPageProps {
    searchParams: Promise<{ fournisseur?: string; magasin?: string }>;
}

export default async function GridPage({ searchParams }: GridPageProps) {
    const params = await searchParams;
    const codeFournisseur = params.fournisseur;
    const magasin = params.magasin ?? "TOTAL";

    // 1. Fetch available suppliers & stores
    const [fournisseurs, magasins] = await Promise.all([
        getFournisseurs(),
        getMagasins()
    ]);

    // 2. If no supplier selected, show compact selection UI
    if (!codeFournisseur) {
        return <SupplierSelectionLanding fournisseurs={fournisseurs} />;
    }

    // 3. Load real product data for the selected supplier
    const rows = await getGridData(codeFournisseur, magasin);
    const selectedFournisseur = fournisseurs.find((f) => f.code === codeFournisseur);

    return (
        <GridClient
            initialRows={rows}
            codeFournisseur={codeFournisseur}
            nomFournisseur={selectedFournisseur?.nom || "Fournisseur inconnu"}
            fournisseurs={fournisseurs}
            magasins={magasins}
            magasin={magasin}
        />
    );
}
