import { pgGetCaByFournisseur, pgGetCaByNomenclature } from "@/lib/pg-ff-client";
import { AnalyticsClient } from "./client";

// Calcul du mois N-1 (même mois année précédente)
function getMoisN1(mois: string): string {
    const [year, month] = mois.split("-").map(Number);
    const d = new Date(year, month - 13); // -13 mois
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

// Formatage courant français
function formatCA(value: number): string {
    return new Intl.NumberFormat("fr-FR", {
        style: "currency",
        currency: "EUR",
        maximumFractionDigits: 0,
    }).format(value);
}

// Helper pivot : transformer les lignes de requête en tableau pivotté par site
function pivotData(
    rows: Array<{ code: string; label: string; site: string; mois: string; ca_ttc: number }>,
    mois: string,
    moisN1: string
): Array<{
    key: string;
    label: string;
    ca292: number;
    caN1_292: number;
    ca579: number;
    caN1_579: number;
    caTotal: number;
    caN1Total: number;
    evolutionTotal: number | null;
}> {
    const map = new Map<string, { code: string; label: string; data: Record<string, number> }>();

    for (const row of rows) {
        const key = `${row.code}|${row.label}`;
        if (!map.has(key)) {
            map.set(key, { code: row.code, label: row.label, data: {} });
        }
        const entry = map.get(key)!;
        entry.data[`${row.site}_${row.mois}`] = row.ca_ttc;
    }

    const result = Array.from(map.values()).map(({ code, label, data }) => {
        const ca292 = data[`292_${mois}`] ?? 0;
        const caN1_292 = data[`292_${moisN1}`] ?? 0;
        const ca579 = data[`579_${mois}`] ?? 0;
        const caN1_579 = data[`579_${moisN1}`] ?? 0;
        const caTotal = ca292 + ca579;
        const caN1Total = caN1_292 + caN1_579;
        const evolutionTotal =
            caN1Total > 0 ? ((caTotal - caN1Total) / caN1Total) * 100 : null;

        return {
            key: code,
            label,
            ca292,
            caN1_292,
            ca579,
            caN1_579,
            caTotal,
            caN1Total,
            evolutionTotal,
        };
    });

    // Trier par CA Total décroissant
    result.sort((a, b) => b.caTotal - a.caTotal);
    return result;
}

export default async function AnalyticsPage(props: {
    searchParams: Promise<Record<string, string | string[]>>;
}) {
    const searchParams = await props.searchParams;
    const mode = (searchParams.mode as string) || "fournisseur";
    const moisParam = (searchParams.mois as string) || "";

    // Mois par défaut = mois courant (YYYY-MM)
    const today = new Date();
    const currentMois = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`;
    const mois = moisParam || currentMois;
    const moisN1 = getMoisN1(mois);

    let rows: Array<{ code: string; label: string; site: string; mois: string; ca_ttc: number }> =
        [];

    if (mode === "fournisseur") {
        const result = await pgGetCaByFournisseur(mois, moisN1);
        rows = result.map((r) => ({
            code: r.code,
            label: r.nom,
            site: r.site,
            mois: r.mois,
            ca_ttc: r.ca_ttc,
        }));
    } else {
        const result = await pgGetCaByNomenclature(mois, moisN1);
        rows = result.map((r) => ({
            code: r.code,
            label: r.libelle,
            site: r.site,
            mois: r.mois,
            ca_ttc: r.ca_ttc,
        }));
    }

    const pivotted = pivotData(rows, mois, moisN1);

    // Calcul des totaux
    const totals = pivotted.reduce(
        (acc, row) => ({
            ca292: acc.ca292 + row.ca292,
            caN1_292: acc.caN1_292 + row.caN1_292,
            ca579: acc.ca579 + row.ca579,
            caN1_579: acc.caN1_579 + row.caN1_579,
            caTotal: acc.caTotal + row.caTotal,
            caN1Total: acc.caN1Total + row.caN1Total,
        }),
        { ca292: 0, caN1_292: 0, ca579: 0, caN1_579: 0, caTotal: 0, caN1Total: 0 }
    );

    const evolutionTotal292 =
        totals.caN1_292 > 0 ? ((totals.ca292 - totals.caN1_292) / totals.caN1_292) * 100 : null;
    const evolutionTotal579 =
        totals.caN1_579 > 0 ? ((totals.ca579 - totals.caN1_579) / totals.caN1_579) * 100 : null;
    const evolutionTotalReseau =
        totals.caN1Total > 0 ? ((totals.caTotal - totals.caN1Total) / totals.caN1Total) * 100 : null;

    return (
        <div className="min-h-screen bg-gray-50 p-6">
            <div className="mx-auto max-w-7xl">
                <h1 className="mb-6 text-3xl font-bold text-gray-900">Analytics</h1>

                <AnalyticsClient
                    mode={mode}
                    mois={mois}
                    moisN1={moisN1}
                    currentMois={currentMois}
                    pivotted={pivotted}
                    totals={totals}
                    evolutionTotal292={evolutionTotal292}
                    evolutionTotal579={evolutionTotal579}
                    evolutionTotalReseau={evolutionTotalReseau}
                    formatCA={formatCA}
                />
            </div>
        </div>
    );
}
