import { pgGetHitParade } from "@/lib/pg-ff-client";
import { HitParadeClient } from "./client";

export interface HitParadePivotRow {
    codein: string;
    libelle: string;
    fournisseur: string;
    qte292: number;
    ca292: number;
    marge292: number;
    qte579: number;
    ca579: number;
    marge579: number;
    qteTotal: number;
    caTotal: number;
    margeTotal: number;
}

function pivotHitParade(
    rows: Array<{ codein: string; libelle: string; fournisseur: string; site: string; qte_vendue: number; ca_ttc: number; marge: number }>
): HitParadePivotRow[] {
    const map = new Map<string, HitParadePivotRow>();

    for (const row of rows) {
        if (!map.has(row.codein)) {
            map.set(row.codein, {
                codein: row.codein,
                libelle: row.libelle,
                fournisseur: row.fournisseur,
                qte292: 0, ca292: 0, marge292: 0,
                qte579: 0, ca579: 0, marge579: 0,
                qteTotal: 0, caTotal: 0, margeTotal: 0,
            });
        }
        const entry = map.get(row.codein)!;
        if (row.site === "292") {
            entry.qte292 = row.qte_vendue;
            entry.ca292 = row.ca_ttc;
            entry.marge292 = row.marge;
        } else if (row.site === "579") {
            entry.qte579 = row.qte_vendue;
            entry.ca579 = row.ca_ttc;
            entry.marge579 = row.marge;
        }
    }

    for (const entry of map.values()) {
        entry.qteTotal = entry.qte292 + entry.qte579;
        entry.caTotal = entry.ca292 + entry.ca579;
        entry.margeTotal = entry.marge292 + entry.marge579;
    }

    return Array.from(map.values());
}

export default async function HitParadePage(props: {
    searchParams: Promise<Record<string, string | string[]>>;
}) {
    const searchParams = await props.searchParams;
    const today = new Date();
    const currentMois = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`;
    const mois = (searchParams.mois as string) || currentMois;

    const rows = await pgGetHitParade(mois);
    const pivotted = pivotHitParade(rows);

    return (
        <div className="min-h-screen bg-gray-50 p-6">
            <div className="mx-auto max-w-screen-2xl">
                <h1 className="mb-6 text-3xl font-bold text-gray-900">Hit Parade</h1>
                <HitParadeClient
                    mois={mois}
                    currentMois={currentMois}
                    pivotted={pivotted}
                />
            </div>
        </div>
    );
}
