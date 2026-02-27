import { getAvailableNomenclature, getFournisseurs, getGridData, getMagasins } from "@/features/grid/actions";
import { GridClient } from "@/features/grid/components/grid-client";
import { SupplierSelectionLanding } from "@/features/grid/components/supplier-selection-landing";

interface GridPageProps {
    searchParams: Promise<{
        fournisseur?: string;
        magasin?: string;
        code1?: string;
        code2?: string;
        code3?: string;
    }>;
}

export default async function GridPage({ searchParams }: GridPageProps) {
    const params = await searchParams;
    const codeFournisseur = params.fournisseur;
    const magasin = params.magasin ?? "TOTAL";
    const filters = {
        code1: params.code1 || null,
        code2: params.code2 || null,
        code3: params.code3 || null,
    };

    // 1. Fetch available suppliers, stores & nomenclature hierarchy
    const [fournisseurs, magasins, nomenclature] = await Promise.all([
        getFournisseurs(),
        getMagasins(),
        getAvailableNomenclature(codeFournisseur, magasin)
    ]);

    // 2. If no supplier selected, show compact selection UI
    if (!codeFournisseur) {
        return <SupplierSelectionLanding fournisseurs={fournisseurs} />;
    }

    // 3. Load real product data for the selected supplier
    const rows = await getGridData(codeFournisseur, magasin, filters);
    const selectedFournisseur = fournisseurs.find((f: { code: string; nom: string }) => f.code === codeFournisseur);

    return (
        <GridClient
            initialRows={rows}
            codeFournisseur={codeFournisseur}
            nomFournisseur={selectedFournisseur?.nom || "Fournisseur inconnu"}
            fournisseurs={fournisseurs}
            magasins={magasins}
            magasin={magasin}
            nomenclature={nomenclature}
        />
    );
}
