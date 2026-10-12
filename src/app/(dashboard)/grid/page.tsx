import { useSessionResolue } from "next-auth/react";
import { getFournisseurs, getMagasins } from "@/features/grid/actions";
import { usePageData, usePageSearchParams } from "@/lib/page-data";
import { GridClient } from "@/features/grid/components/grid-client";
import { SupplierSelectionLanding } from "@/features/grid/components/supplier-selection-landing";

export default function GridPage() {
    const params = usePageSearchParams();
    const codeFournisseur = params.fournisseur;
    const magasin = params.magasin ?? "TOTAL";
    const filters = {
        code1: params.code1 || null,
        code2: params.code2 || null,
        // Liste séparée par des virgules : le filtre accepte plusieurs nomenclatures.
        code3: params.code3 ? String(params.code3).split(",").filter(Boolean) : null,
    };

    // 1. Fetch available suppliers & stores (et les droits, lus une fois avant le rendu)
    const [fournisseurs, magasins] = usePageData("grid", () => Promise.all([getFournisseurs(), getMagasins()]));
    const session = useSessionResolue();
    const isAdmin = session?.user.role === "admin";

    // 2. If no supplier selected, show compact selection UI
    if (!codeFournisseur) {
        return <SupplierSelectionLanding fournisseurs={fournisseurs} />;
    }

    const selectedFournisseur = fournisseurs.find((f: { code: string; nom: string }) => f.code === codeFournisseur);

    return (
        <GridClient
            codeFournisseur={codeFournisseur}
            nomFournisseur={selectedFournisseur?.nom || "Fournisseur inconnu"}
            fournisseurs={fournisseurs}
            magasins={magasins}
            magasin={magasin}
            filters={filters}
            isAdmin={isAdmin}
        />
    );
}
