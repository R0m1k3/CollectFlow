import Link from "next/link";
import { PackageMinus, RotateCcw } from "lucide-react";
import type { PgStockNegatifRow, PgStockSansVenteRow, PgSansVente6MoisRow } from "@/types/ff";
import { fetchPage } from "@/lib/rpc";
import { usePageResult, usePageSearchParams } from "@/lib/page-data";
import { PageHeader } from "@/components/ui/page-header";
import { ErrorState } from "@/components/ui/states";
import { Button } from "@/components/ui/button";
import { GestionStockClient } from "./client";

export type { PgStockNegatifRow, PgStockSansVenteRow, PgSansVente6MoisRow };

interface DonneesStock {
    rowsNegatif: PgStockNegatifRow[];
    rowsSansVente: PgStockSansVenteRow[];
    rowsSansVente6Mois: PgSansVente6MoisRow[];
}

export default function GestionStockPage() {
    const searchParams = usePageSearchParams();
    const magasin = searchParams.magasin || "";
    const tab = searchParams.tab || "negatif";

    // Données FF recopiées chaque nuit : mises en cache par le serveur.
    const resultat = usePageResult(`stock-negatif?${magasin}`, () =>
        fetchPage<DonneesStock>("stock-negatif", { magasin }),
    );
    const donnees: DonneesStock | null = resultat.ok ? resultat.data : null;
    const erreur: string | null = resultat.ok ? null : resultat.error;

    const params = new URLSearchParams();
    if (magasin) params.set("magasin", magasin);
    params.set("tab", tab);

    return (
        <div className="mx-auto w-full max-w-screen-2xl">
            <PageHeader
                icon={PackageMinus}
                title="Stocks à surveiller"
                description="Les produits dont le stock pose question : stock négatif, reçus mais jamais vendus, ou sans vente depuis 6 mois. Vérifiez-les en magasin, puis régularisez le stock dans FF grâce à l'export Excel."
            />
            {donnees ? (
                <GestionStockClient
                    rowsNegatif={donnees.rowsNegatif}
                    rowsSansVente={donnees.rowsSansVente}
                    rowsSansVente6Mois={donnees.rowsSansVente6Mois}
                    magasin={magasin}
                    tab={tab}
                />
            ) : (
                <ErrorState
                    title="Les stocks n'ont pas pu être chargés"
                    detail={erreur ?? undefined}
                    action={
                        <Button asChild variant="outline">
                            <Link href={`/stock-negatif?${params.toString()}`}><RotateCcw /> Réessayer</Link>
                        </Button>
                    }
                />
            )}
        </div>
    );
}
