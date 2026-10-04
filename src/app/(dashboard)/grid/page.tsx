import type { Metadata } from "next";
import { auth } from "@/lib/auth";
import { getFournisseurs, getMagasins } from "@/features/grid/actions";
import { GridClient } from "@/features/grid/components/grid-client";
import { SupplierSelectionLanding } from "@/features/grid/components/supplier-selection-landing";

export const metadata: Metadata = { title: "Révision d'assortiment" };

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
        // Liste séparée par des virgules : le filtre accepte plusieurs nomenclatures.
        code3: params.code3 ? String(params.code3).split(",").filter(Boolean) : null,
    };

    // 1. Fetch available suppliers & stores (et les droits, lus une fois côté serveur)
    const [fournisseurs, magasins, session] = await Promise.all([
        getFournisseurs(),
        getMagasins(),
        auth(),
    ]);
    const isAdmin = (session?.user as { role?: string } | undefined)?.role === "admin";

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
