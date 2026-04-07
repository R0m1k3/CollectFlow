import { pgGetStockNegatif, PgStockNegatifRow, pgGetStockSansVente, PgStockSansVenteRow } from "@/lib/pg-ff-client";
import { GestionStockClient } from "./client";

export type { PgStockNegatifRow, PgStockSansVenteRow };

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

    const [rowsNegatif, rowsSansVente] = await Promise.all([
        pgGetStockNegatif(magasin || undefined),
        pgGetStockSansVente(magasin || undefined),
    ]);

    return (
        <div className="min-h-screen bg-gray-50 p-6">
            <div className="mx-auto max-w-screen-2xl">
                <h1 className="mb-6 text-3xl font-bold text-gray-900">Gestion de Stock</h1>
                <GestionStockClient
                    rowsNegatif={rowsNegatif}
                    rowsSansVente={rowsSansVente}
                    magasin={magasin}
                    tab={tab}
                    sites={SITES}
                />
            </div>
        </div>
    );
}
