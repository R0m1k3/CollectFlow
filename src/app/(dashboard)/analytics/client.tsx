"use client";

import { useRouter } from "next/navigation";
import { useMemo, useTransition } from "react";
import { Loader2 } from "lucide-react";
import { DataTable, type DataColumn } from "@/components/ui/data-table";
import { Segmented, type TabItem } from "@/components/ui/tabs";
import { Select } from "@/components/ui/form-controls";
import { DeltaBadge } from "@/components/ui/badge";
import { Terme } from "@/components/ui/tooltip";
import { MAGASINS, nomMagasin } from "@/lib/magasins";
import { fmtEur2 } from "@/lib/format";
import { telechargerExcel } from "@/lib/export-excel";
import { cn } from "@/lib/utils";

export type ModeAnalytics = "fournisseur" | "nomenclature";

export interface OptionMois {
    value: string;
    label: string;
}

export interface AnalyticsRow {
    key: string;
    label: string;
    ca292: number;
    caN1_292: number;
    ca579: number;
    caN1_579: number;
    caTotal: number;
    caN1Total: number;
    evolutionTotal: number | null;
}

interface AnalyticsClientProps {
    mode: ModeAnalytics;
    /** Mois affiché, « AAAA-MM ». */
    mois: string;
    /** Mois en clair : « octobre 2026 ». */
    libelleMois: string;
    libelleMoisN1: string;
    moisDisponibles: OptionMois[];
    pivotted: AnalyticsRow[];
}

/** Champs numériques de la ligne pivotée. */
type Champ = { [K in keyof AnalyticsRow]: AnalyticsRow[K] extends number ? K : never }[keyof AnalyticsRow];

interface Groupe {
    id: string;
    titre: string;
    ca: Champ;
    caN1: Champ;
}

/** Champs de la ligne pivotée pour chaque magasin (la requête en fournit un jeu par magasin). */
const CHAMPS_MAGASIN: Record<string, Pick<Groupe, "ca" | "caN1">> = {
    "292": { ca: "ca292", caN1: "caN1_292" },
    "579": { ca: "ca579", caN1: "caN1_579" },
};

const GROUPES: Groupe[] = [
    ...MAGASINS.filter((m) => CHAMPS_MAGASIN[m.code]).map((m) => ({
        id: m.code,
        titre: nomMagasin(m.code),
        ...CHAMPS_MAGASIN[m.code],
    })),
    { id: "total", titre: "Total nos magasins", ca: "caTotal", caN1: "caN1Total" },
];

const MODES: TabItem<ModeAnalytics>[] = [
    { value: "fournisseur", label: "Fournisseur" },
    { value: "nomenclature", label: "Famille" },
];

const somme = (rows: readonly AnalyticsRow[], champ: Champ) => rows.reduce((acc, r) => acc + r[champ], 0);

/** Évolution en % par rapport à N-1 ; `null` sans chiffre d'affaires N-1. */
const evolution = (ca: number, caN1: number) => (caN1 > 0 ? ((ca - caN1) / caN1) * 100 : null);

const recherche = (r: AnalyticsRow) => [r.label, r.key];

function Montant({ v }: { v: number }) {
    return <span className={cn("whitespace-nowrap", v === 0 && "text-[var(--text-muted)]")}>{fmtEur2(v)}</span>;
}

export function AnalyticsClient({
    mode,
    mois,
    libelleMois,
    libelleMoisN1,
    moisDisponibles,
    pivotted,
}: AnalyticsClientProps) {
    const router = useRouter();
    const [navigation, demarrerNavigation] = useTransition();

    const handleModeChange = (newMode: string) => {
        demarrerNavigation(() => {
            router.push(`/analytics?mode=${newMode}&mois=${mois}`);
        });
    };

    const handleMonthChange = (newMois: string) => {
        demarrerNavigation(() => {
            router.push(`/analytics?mode=${mode}&mois=${newMois}`);
        });
    };

    const libelleColonne = mode === "fournisseur" ? "Fournisseur" : "Famille";

    const colonnes = useMemo<DataColumn<AnalyticsRow>[]>(() => [
        {
            id: "label",
            header: libelleColonne,
            sortValue: (r) => r.label,
            cell: (r) => <span className="font-medium">{r.label}</span>,
            footer: () => "Total",
            className: "min-w-[140px] sm:min-w-[220px]",
            sticky: true,
            grow: true,
        },
        ...GROUPES.flatMap((g): DataColumn<AnalyticsRow>[] => {
            const total = g.id === "total";
            // En-tête commun, séparation et teinte du total : gérés par DataTable.
            const commun = { group: g.titre, highlight: total, align: "right" as const };
            return [
                {
                    ...commun,
                    id: `${g.id}-ca`,
                    header: libelleMois,
                    hint: `Chiffre d'affaires TTC (${g.titre}) en ${libelleMois}, retours déduits`,
                    sortValue: (r) => r[g.ca],
                    cell: (r) => <Montant v={r[g.ca]} />,
                    footer: (rows) => <Montant v={somme(rows, g.ca)} />,
                    className: cn(total && "font-semibold"),
                },
                {
                    ...commun,
                    id: `${g.id}-n1`,
                    header: <span className="inline-flex items-center gap-1">{libelleMoisN1} · <Terme id="n1" /></span>,
                    hint: `Chiffre d'affaires TTC (${g.titre}) en ${libelleMoisN1}, même mois l'année précédente`,
                    sortValue: (r) => r[g.caN1],
                    cell: (r) => <Montant v={r[g.caN1]} />,
                    footer: (rows) => <Montant v={somme(rows, g.caN1)} />,
                    className: cn(total && "font-semibold"),
                },
                {
                    ...commun,
                    id: `${g.id}-evolution`,
                    header: "Évolution",
                    hint: `Évolution du chiffre d'affaires (${g.titre}) entre ${libelleMoisN1} et ${libelleMois}`,
                    sortValue: (r) => evolution(r[g.ca], r[g.caN1]),
                    cell: (r) => <DeltaBadge pct={evolution(r[g.ca], r[g.caN1])} />,
                    footer: (rows) => <DeltaBadge pct={evolution(somme(rows, g.ca), somme(rows, g.caN1))} />,
                },
            ];
        }),
    ], [libelleColonne, libelleMois, libelleMoisN1]);

    async function exporter(rows: readonly AnalyticsRow[]) {
        const arrondi = (v: number) => Math.round(v * 100) / 100;
        const evol = (ca: number, caN1: number) => {
            const e = evolution(ca, caN1);
            return e === null ? null : Math.round(e * 10) / 10;
        };
        await telechargerExcel({
            feuille: "Ventes par mois",
            fichier: `ventes-par-mois_${mode === "fournisseur" ? "fournisseurs" : "familles"}_${mois}`,
            entetes: [
                libelleColonne,
                ...GROUPES.flatMap((g) => [
                    `${g.titre} — CA ${libelleMois}`,
                    `${g.titre} — CA ${libelleMoisN1} (N-1)`,
                    `${g.titre} — Évolution (%)`,
                ]),
            ],
            largeurs: [40, ...GROUPES.flatMap(() => [22, 22, 16])],
            lignes: rows.map((r) => [
                r.label,
                ...GROUPES.flatMap((g) => [arrondi(r[g.ca]), arrondi(r[g.caN1]), evol(r[g.ca], r[g.caN1])]),
            ]),
            totaux: [
                "Total",
                ...GROUPES.flatMap((g) => {
                    const ca = somme(rows, g.ca);
                    const caN1 = somme(rows, g.caN1);
                    return [arrondi(ca), arrondi(caN1), evol(ca, caN1)];
                }),
            ],
        });
    }

    return (
        <div className="space-y-4" aria-busy={navigation}>
            {/* Contrôles (relancent le calcul côté serveur) */}
            <div className="flex flex-wrap items-end gap-4">
                <div role="group" aria-labelledby="analytics-vue">
                    <span id="analytics-vue" className="mb-1 block text-[13px] font-medium text-[var(--text-secondary)]">
                        Afficher par
                    </span>
                    <Segmented items={MODES} value={mode} onChange={handleModeChange} disabled={navigation} />
                </div>
                <Select
                    id="analytics-mois"
                    label="Mois"
                    value={mois}
                    onChange={handleMonthChange}
                    options={moisDisponibles}
                    disabled={navigation}
                />
                {navigation && (
                    <span role="status" className="inline-flex h-9 items-center gap-2 text-[13px] text-[var(--text-secondary)]">
                        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                        Chargement…
                    </span>
                )}
            </div>

            <p className="text-sm text-[var(--text-secondary)]">
                Chiffre d&apos;affaires TTC de <strong className="font-semibold text-[var(--text-primary)]">{libelleMois}</strong>,
                comparé à <strong className="font-semibold text-[var(--text-primary)]">{libelleMoisN1}</strong> (même mois
                l&apos;année précédente). Les retours clients sont déduits.
            </p>

            <div className={cn("transition-opacity", navigation && "pointer-events-none opacity-50")}>
                <DataTable<AnalyticsRow>
                    key={mode}
                    rows={pivotted}
                    columns={colonnes}
                    rowKey={(r) => `${r.key}|${r.label}`}
                    searchIn={recherche}
                    searchPlaceholder={mode === "fournisseur" ? "Rechercher un fournisseur…" : "Rechercher une famille…"}
                    pageSize={100}
                    unite={mode === "fournisseur" ? "fournisseurs" : "familles"}
                    showFooter
                    emptyTitle={`Aucune vente en ${libelleMois}`}
                    emptyDescription="Aucun chiffre d'affaires n'est enregistré pour ce mois ni pour le même mois de l'année précédente. Choisissez un autre mois."
                    onExport={exporter}
                />
            </div>
        </div>
    );
}
