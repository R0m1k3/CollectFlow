import type { Metadata } from "next";
import Link from "next/link";
import { PackageMinus, RotateCcw } from "lucide-react";
import { pgGetStockNegatif, PgStockNegatifRow, pgGetStockSansVente, PgStockSansVenteRow, pgGetSansVente6Mois, PgSansVente6MoisRow } from "@/lib/pg-ff-client";
import { cachedFF } from "@/lib/ff-cache";
import { PageHeader } from "@/components/ui/page-header";
import { ErrorState } from "@/components/ui/states";
import { Button } from "@/components/ui/button";
import { GestionStockClient } from "./client";

export type { PgStockNegatifRow, PgStockSansVenteRow, PgSansVente6MoisRow };

export const metadata: Metadata = { title: "Stocks à surveiller" };

interface DonneesStock {
    rowsNegatif: PgStockNegatifRow[];
    rowsSansVente: PgStockSansVenteRow[];
    rowsSansVente6Mois: PgSansVente6MoisRow[];
}

export default async function GestionStockPage(props: {
    searchParams: Promise<Record<string, string | string[]>>;
}) {
    const searchParams = await props.searchParams;
    const magasin = (searchParams.magasin as string) || "";
    const tab = (searchParams.tab as string) || "negatif";

    // Données FF recopiées chaque nuit : mises en cache (cf. lib/ff-cache.ts).
    const site = magasin || undefined;
    let donnees: DonneesStock | null = null;
    let erreur: string | null = null;
    try {
        const [rowsNegatif, rowsSansVente, rowsSansVente6Mois] = await Promise.all([
            cachedFF(`stock-negatif:${magasin}`, () => pgGetStockNegatif(site)),
            cachedFF(`stock-sans-vente:${magasin}`, () => pgGetStockSansVente(site)),
            cachedFF(`stock-sans-vente-6-mois:${magasin}`, () => pgGetSansVente6Mois(site)),
        ]);
        donnees = { rowsNegatif, rowsSansVente, rowsSansVente6Mois };
    } catch (e) {
        console.error("[stock-negatif] chargement impossible :", e);
        erreur = e instanceof Error ? e.message : String(e);
    }

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
