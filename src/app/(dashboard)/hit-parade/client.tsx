"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { DataTable, type DataColumn, type DataFilter } from "@/components/ui/data-table";
import { Input, Label } from "@/components/ui/form-controls";
import { Button } from "@/components/ui/button";
import { MAGASINS, nomMagasin } from "@/lib/magasins";
import { fmtDecimal1, fmtEntier, fmtEur2 } from "@/lib/format";
import { couleurMarge } from "@/lib/marge";
import { telechargerExcel } from "@/lib/export-excel";
import { cn } from "@/lib/utils";
import type { HitParadePivotRow } from "./page";

type Ligne = HitParadePivotRow;

/** Champs numériques de la ligne pivotée. */
type Champ = { [K in keyof Ligne]: Ligne[K] extends number ? K : never }[keyof Ligne];

interface Groupe {
    id: string;
    /** Nom affiché au-dessus des colonnes du groupe. */
    titre: string;
    /** Nom complet, pour les infobulles et l'export. */
    nom: string;
    qte: Champ;
    ca: Champ;
    marge: Champ;
    stock: Champ;
}

/** Champs de la ligne pivotée pour chaque magasin (la requête en fournit un jeu par magasin). */
const CHAMPS_MAGASIN: Record<string, Pick<Groupe, "qte" | "ca" | "marge" | "stock">> = {
    "292": { qte: "qte292", ca: "ca292", marge: "marge292", stock: "stock292" },
    "579": { qte: "qte579", ca: "ca579", marge: "marge579", stock: "stock579" },
};

const GROUPES: Groupe[] = [
    ...MAGASINS.filter(m => CHAMPS_MAGASIN[m.code]).map(m => ({
        id: m.code,
        titre: nomMagasin(m.code),
        nom: nomMagasin(m.code),
        ...CHAMPS_MAGASIN[m.code],
    })),
    { id: "total", titre: "Total nos magasins", nom: "nos magasins", qte: "qteTotal", ca: "caTotal", marge: "margeTotal", stock: "stockTotal" },
];

const somme = (rows: readonly Ligne[], champ: Champ) => rows.reduce((acc, r) => acc + r[champ], 0);

/** Taux de marge en %, `null` sans chiffre d'affaires. */
const tauxMarge = (ca: number, marge: number) => (ca > 0 ? (marge / ca) * 100 : null);

const famille = (r: Ligne) => (r.nomenclature_code ? `${r.nomenclature_code} — ${r.nomenclature}` : "Sans famille");

const vide = <span className="text-[var(--text-muted)]">—</span>;

function CelluleMarge({ taux }: { taux: number | null }) {
    if (taux === null) return vide;
    return <span className="font-medium" style={{ color: couleurMarge(taux) }}>{fmtDecimal1(taux)} %</span>;
}

function CelluleStock({ v }: { v: number }) {
    return (
        <span className={cn(v < 0 ? "font-semibold text-[var(--accent-error)]" : v === 0 ? "text-[var(--text-muted)]" : undefined)}>
            {fmtEntier(v)}
        </span>
    );
}

/** En-tête sur deux lignes : magasin au-dessus, mesure en dessous. */
function EnTete({ groupe, children }: { groupe: string; children: ReactNode }) {
    return (
        <span className="flex flex-col items-end leading-tight">
            <span className="text-xs font-normal text-[var(--text-muted)]">{groupe}</span>
            <span>{children}</span>
        </span>
    );
}

function colonnesGroupe(g: Groupe): DataColumn<Ligne>[] {
    const total = g.id === "total";
    const bord = "border-l border-[var(--border)]";
    return [
        {
            id: `${g.id}-qte`,
            header: <EnTete groupe={g.titre}>Qté</EnTete>,
            hint: `Quantité vendue (${g.nom}) sur la période, retours déduits`,
            align: "right",
            sortValue: r => r[g.qte],
            cell: r => (r[g.qte] !== 0 ? fmtEntier(r[g.qte]) : vide),
            footer: rows => fmtEntier(somme(rows, g.qte)),
            className: cn(bord, total && "font-semibold"),
            headerClassName: bord,
        },
        {
            id: `${g.id}-ca`,
            header: <EnTete groupe={g.titre}>CA TTC</EnTete>,
            hint: `Chiffre d'affaires TTC (${g.nom}) sur la période, retours déduits`,
            align: "right",
            sortValue: r => r[g.ca],
            cell: r => (r[g.ca] !== 0 ? fmtEur2(r[g.ca]) : vide),
            footer: rows => fmtEur2(somme(rows, g.ca)),
            className: cn("whitespace-nowrap", total && "font-semibold"),
        },
        {
            id: `${g.id}-marge`,
            header: <EnTete groupe={g.titre}>% marge</EnTete>,
            hint: `Taux de marge (${g.nom}) : marge divisée par le chiffre d'affaires TTC`,
            align: "right",
            sortValue: r => tauxMarge(r[g.ca], r[g.marge]),
            cell: r => <CelluleMarge taux={tauxMarge(r[g.ca], r[g.marge])} />,
            footer: rows => <CelluleMarge taux={tauxMarge(somme(rows, g.ca), somme(rows, g.marge))} />,
            className: "whitespace-nowrap",
        },
        {
            id: `${g.id}-stock`,
            header: <EnTete groupe={g.titre}>Stock</EnTete>,
            hint: `Stock actuel (${g.nom}). En rouge : stock négatif`,
            align: "right",
            sortValue: r => r[g.stock],
            cell: r => <CelluleStock v={r[g.stock]} />,
            footer: rows => fmtEntier(somme(rows, g.stock)),
        },
    ];
}

const COLONNES: DataColumn<Ligne>[] = [
    {
        id: "codein",
        header: "Code",
        sortValue: r => r.codein,
        cell: r => <span className="font-mono text-[13px] text-[var(--text-secondary)]">{r.codein}</span>,
        footer: () => "Total",
        className: "whitespace-nowrap",
    },
    {
        id: "libelle",
        header: "Désignation",
        sortValue: r => r.libelle.trim(),
        cell: r => <span className="font-medium">{r.libelle.trim()}</span>,
        footer: rows => <span className="whitespace-nowrap">{fmtEntier(rows.length)} articles</span>,
        className: "min-w-[220px]",
    },
    {
        id: "fournisseur",
        header: "Fournisseur",
        sortValue: r => r.fournisseur,
        cell: r => <span className="text-[13px] text-[var(--text-secondary)]">{r.fournisseur}</span>,
        className: "whitespace-nowrap",
    },
    {
        id: "famille",
        header: "Famille",
        hint: "Famille de produits (nomenclature FF)",
        sortValue: famille,
        cell: r =>
            r.nomenclature_code ? (
                <span className="text-[13px] text-[var(--text-secondary)]" title={famille(r)}>
                    <span className="font-mono text-[var(--text-muted)]">{r.nomenclature_code}</span> {r.nomenclature}
                </span>
            ) : vide,
        className: "min-w-[160px]",
    },
    ...GROUPES.flatMap(colonnesGroupe),
];

const FILTRES: DataFilter<Ligne>[] = [
    { id: "fournisseur", label: "Fournisseur", valueOf: r => r.fournisseur, allLabel: "Tous les fournisseurs" },
    { id: "famille", label: "Famille", valueOf: famille, allLabel: "Toutes les familles" },
];

const recherche = (r: Ligne) => [r.codein, r.libelle];

interface Props {
    dateDebut: string;
    dateFin: string;
    pivotted: HitParadePivotRow[];
}

export function HitParadeClient({ dateDebut, dateFin, pivotted }: Props) {
    const router = useRouter();
    const [navigation, demarrerNavigation] = useTransition();

    // Dates locales pour les inputs (évite rechargement à chaque frappe)
    const [localDebut, setLocalDebut] = useState(dateDebut);
    const [localFin, setLocalFin] = useState(dateFin);

    const periodeInvalide = Boolean(localDebut && localFin && localDebut > localFin);

    function applyDates() {
        if (localDebut && localFin && !periodeInvalide) {
            demarrerNavigation(() => {
                router.push(`/hit-parade?debut=${localDebut}&fin=${localFin}`);
            });
        }
    }

    async function exportToExcel(rows: readonly Ligne[]) {
        const pct = (ca: number, marge: number) => ca === 0 ? 0 : Math.round((marge / ca) * 1000) / 10;
        const nomExport = (g: Groupe) => (g.id === "total" ? "Total" : g.nom);

        await telechargerExcel({
            feuille: "Meilleures ventes",
            fichier: `meilleures-ventes_${dateDebut}_${dateFin}`,
            entetes: [
                "Code", "Désignation", "Fournisseur", "Nomenclature",
                ...GROUPES.flatMap(g => [
                    `Qté ${nomExport(g)}`, `CA TTC ${nomExport(g)}`, `% Marge ${nomExport(g)}`, `Stock ${nomExport(g)}`,
                ]),
            ],
            largeurs: [12, 40, 25, 30, ...GROUPES.flatMap(() => [10, 14, 12, 10])],
            lignes: rows.map(r => [
                r.codein,
                r.libelle.trim(),
                r.fournisseur,
                r.nomenclature_code ? `${r.nomenclature_code} — ${r.nomenclature}` : "",
                ...GROUPES.flatMap(g => [r[g.qte], r[g.ca], pct(r[g.ca], r[g.marge]), r[g.stock]]),
            ]),
            totaux: [
                `TOTAL — ${rows.length} articles`, "", "", "",
                ...GROUPES.flatMap(g => {
                    const ca = somme(rows, g.ca);
                    return [somme(rows, g.qte), ca, pct(ca, somme(rows, g.marge)), somme(rows, g.stock)];
                }),
            ],
        });
    }

    return (
        <div className="space-y-4" aria-busy={navigation}>
            {/* Période (relance le calcul côté serveur) */}
            <div className="flex flex-wrap items-end gap-3">
                <div>
                    <Label htmlFor="hit-parade-debut">Du</Label>
                    <Input
                        id="hit-parade-debut"
                        type="date"
                        value={localDebut}
                        onChange={e => setLocalDebut(e.target.value)}
                    />
                </div>
                <div>
                    <Label htmlFor="hit-parade-fin">Au</Label>
                    <Input
                        id="hit-parade-fin"
                        type="date"
                        value={localFin}
                        onChange={e => setLocalFin(e.target.value)}
                    />
                </div>
                <Button onClick={applyDates} disabled={navigation || !localDebut || !localFin || periodeInvalide}>
                    {navigation && <Loader2 className="animate-spin" aria-hidden />}
                    {navigation ? "Chargement…" : "Appliquer"}
                </Button>
                {periodeInvalide && (
                    <p role="alert" className="flex h-9 items-center text-[13px] text-[var(--accent-error)]">
                        La date de début doit précéder la date de fin.
                    </p>
                )}
            </div>

            <div className={cn("transition-opacity", navigation && "pointer-events-none opacity-50")}>
                <DataTable<Ligne>
                    rows={pivotted}
                    columns={COLONNES}
                    rowKey={r => r.codein}
                    searchIn={recherche}
                    searchPlaceholder="Code ou désignation…"
                    filters={FILTRES}
                    pageSize={100}
                    unite="produits"
                    initialSort={{ id: "total-ca", dir: "desc" }}
                    showFooter
                    emptyTitle="Aucune vente sur cette période"
                    emptyDescription="Choisissez une autre période, puis cliquez sur « Appliquer »."
                    onExport={exportToExcel}
                />
            </div>
        </div>
    );
}
