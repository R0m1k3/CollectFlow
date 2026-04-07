import { pgGetStockNegatif, PgStockNegatifRow } from "@/lib/pg-ff-client";
import { StockNegatifClient } from "./client";

export type { PgStockNegatifRow };

const SITES = [
    { code: "292", label: "292 — Frouard / Nancy" },
    { code: "579", label: "579 — Houdemont" },
];

export default async function StockNegatifPage(props: {
    searchParams: Promise<Record<string, string | string[]>>;
}) {
    const searchParams = await props.searchParams;
    const magasin = (searchParams.magasin as string) || "";

    const rows = await pgGetStockNegatif(magasin || undefined);

    return (
        <div className="min-h-screen bg-gray-50 p-6">
            <div className="mx-auto max-w-screen-2xl">
                <h1 className="mb-6 text-3xl font-bold text-gray-900">Stock Négatif</h1>
                <StockNegatifClient
                    rows={rows}
                    magasin={magasin}
                    sites={SITES}
                />
            </div>
        </div>
    );
}
