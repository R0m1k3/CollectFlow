import { pgGetStockNegatif, PgStockNegatifRow, pgGetStockSansVente, PgStockSansVenteRow, pgGetSansVente6Mois, PgSansVente6MoisRow } from "@/lib/pg-ff-client";
import { GestionStockClient } from "./client";
import { cachedFF } from "@/lib/ff-cache";

export type { PgStockNegatifRow, PgStockSansVenteRow, PgSansVente6MoisRow };

const SITES = [
    { code: "292", label: "292 — Frouard / Nancy" },
    { code: "579", label: "579 — Houdemont" },
];

export default async function GestionStockPage(props: {
    searchParams: Promise<Record<string, string | string[]>>;
}) {
    const searchParams = await props.searchParams;
    const magasin = (searchParams.magasin as string) || "";
    const tab = (searchParams.tab as string) || "negatif";

    // Données FF recopiées chaque nuit : mises en cache (cf. lib/ff-cache.ts).
    const site = magasin || undefined;
    const [rowsNegatif, rowsSansVente, rowsSansVente6Mois] = await Promise.all([
        cachedFF(`stock-negatif:${magasin}`, () => pgGetStockNegatif(site)),
        cachedFF(`stock-sans-vente:${magasin}`, () => pgGetStockSansVente(site)),
        cachedFF(`stock-sans-vente-6-mois:${magasin}`, () => pgGetSansVente6Mois(site)),
    ]);

    return (
        <div className="min-h-screen bg-gray-50 p-6">
            <div className="mx-auto max-w-screen-2xl">
                <h1 className="mb-6 text-3xl font-bold text-gray-900">Gestion de Stock</h1>
                <GestionStockClient
                    rowsNegatif={rowsNegatif}
                    rowsSansVente={rowsSansVente}
                    rowsSansVente6Mois={rowsSansVente6Mois}
                    magasin={magasin}
                    tab={tab}
                    sites={SITES}
                />
            </div>
        </div>
    );
}
