import { pgGetHitParade, HitParadeRow } from "@/lib/pg-ff-client";
import { HitParadeClient } from "./client";

export interface HitParadePivotRow {
    codein: string;
    libelle: string;
    fournisseur: string;
    nomenclature: string;
    qte292: number;
    ca292: number;
    marge292: number;
    qte579: number;
    ca579: number;
    marge579: number;
    qteTotal: number;
    caTotal: number;
    margeTotal: number;
    stock292: number;
    stock579: number;
    stockTotal: number;
}

function pivotHitParade(rows: HitParadeRow[]): HitParadePivotRow[] {
    const map = new Map<string, HitParadePivotRow>();

    for (const row of rows) {
        if (!map.has(row.codein)) {
            map.set(row.codein, {
                codein: row.codein,
                libelle: row.libelle,
                fournisseur: row.fournisseur,
                nomenclature: row.nomenclature,
                qte292: 0, ca292: 0, marge292: 0,
                qte579: 0, ca579: 0, marge579: 0,
                qteTotal: 0, caTotal: 0, margeTotal: 0,
                // Stock comes from the SQL query directly (LEFT JOIN cube_stock)
                stock292: row.stock292 ?? 0,
                stock579: row.stock579 ?? 0,
                stockTotal: row.stockTotal ?? 0,
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

function defaultDates() {
    const today = new Date();
    const firstOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    const fmt = (d: Date) => d.toISOString().slice(0, 10);
    return { debut: fmt(firstOfMonth), fin: fmt(today) };
}

export default async function HitParadePage(props: {
    searchParams: Promise<Record<string, string | string[]>>;
}) {
    const searchParams = await props.searchParams;
    const defaults = defaultDates();
    const dateDebut = (searchParams.debut as string) || defaults.debut;
    const dateFin = (searchParams.fin as string) || defaults.fin;

    const rows = await pgGetHitParade(dateDebut, dateFin);
    const pivotted = pivotHitParade(rows);

    return (
        <div className="min-h-screen bg-gray-50 p-6">
            <div className="mx-auto max-w-screen-2xl">
                <h1 className="mb-6 text-3xl font-bold text-gray-900">Hit Parade</h1>
                <HitParadeClient
                    dateDebut={dateDebut}
                    dateFin={dateFin}
                    pivotted={pivotted}
                />
            </div>
        </div>
    );
}
