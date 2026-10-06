import type { Metadata } from "next";
import Link from "next/link";
import { RotateCcw, Trophy } from "lucide-react";
import { pgGetHitParade, HitParadeRow } from "@/lib/pg-ff-client";
import { cachedFF } from "@/lib/ff-cache";
import { PageHeader } from "@/components/ui/page-header";
import { ErrorState } from "@/components/ui/states";
import { Button } from "@/components/ui/button";
import { HitParadeClient } from "./client";

export const metadata: Metadata = { title: "Meilleures ventes" };

export interface HitParadePivotRow {
    codein: string;
    libelle: string;
    /** Référence fournisseur de l'article. */
    reference: string;
    fournisseur: string;
    nomenclature_code: string;
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
                reference: row.reference ?? "",
                fournisseur: row.fournisseur,
                nomenclature_code: row.nomenclature_code,
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
        // Accumulation (+=) et non affectation : si la requête renvoyait plusieurs
        // lignes pour un même (codein, site), aucune valeur ne serait écrasée.
        const site = String(row.site).trim();
        if (site === "292") {
            entry.qte292 += row.qte_vendue;
            entry.ca292 += row.ca_ttc;
            entry.marge292 += row.marge;
        } else if (site === "579") {
            entry.qte579 += row.qte_vendue;
            entry.ca579 += row.ca_ttc;
            entry.marge579 += row.marge;
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

    let pivotted: HitParadePivotRow[] | null = null;
    let erreur: string | null = null;
    try {
        const rows = await cachedFF(`hit-parade:${dateDebut}:${dateFin}`, () => pgGetHitParade(dateDebut, dateFin));
        pivotted = pivotHitParade(rows);
    } catch (e) {
        console.error("[hit-parade] chargement impossible :", e);
        erreur = e instanceof Error ? e.message : String(e);
    }

    return (
        <div className="w-full min-w-0">
            <PageHeader
                icon={Trophy}
                title="Meilleures ventes"
                description="Le classement des produits les plus vendus sur une période, magasin par magasin : quantités, chiffre d'affaires, taux de marge et stock actuel."
            />
            {pivotted ? (
                <HitParadeClient
                    dateDebut={dateDebut}
                    dateFin={dateFin}
                    pivotted={pivotted}
                />
            ) : (
                <ErrorState
                    title="Les meilleures ventes n'ont pas pu être chargées"
                    detail={erreur ?? undefined}
                    action={
                        <Button asChild variant="outline">
                            <Link href={`/hit-parade?debut=${dateDebut}&fin=${dateFin}`}><RotateCcw /> Réessayer</Link>
                        </Button>
                    }
                />
            )}
        </div>
    );
}
