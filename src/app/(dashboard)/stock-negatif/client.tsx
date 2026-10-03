"use client";

import { useRouter } from "next/navigation";
import { useState, useMemo, useEffect, useTransition, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { DataTable, type DataColumn, type DataFilter } from "@/components/ui/data-table";
import { Tabs, type TabItem } from "@/components/ui/tabs";
import { Select } from "@/components/ui/form-controls";
import { StoreBadge } from "@/components/ui/badge";
import { Terme } from "@/components/ui/tooltip";
import { MAGASINS, LIBELLE_TOUS_MAGASINS, nomMagasin } from "@/lib/magasins";
import { fmtDecimal1, fmtEntier } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { PgStockNegatifRow, PgStockSansVenteRow, PgSansVente6MoisRow } from "./page";

/** Nombre de lignes rendues simultanément : au-delà, le navigateur fige. */
const PAGE_SIZE = 50;

function fmtDate(raw: string | null) {
    if (!raw) return "—";
    const d = new Date(raw);
    if (isNaN(d.getTime())) return raw;
    return d.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function getYear(raw: string | null): string {
    if (!raw) return "";
    const d = new Date(raw);
    if (isNaN(d.getTime())) return "";
    return String(d.getFullYear());
}

/**
 * Passe à `true` seulement si `active` reste vrai plus de `delay` ms.
 * Évite le clignotement de l'indicateur sur les transitions instantanées.
 */
function useDelayedFlag(active: boolean, delay = 120) {
    const [elapsed, setElapsed] = useState(false);
    const [wasActive, setWasActive] = useState(active);

    // Réinitialisation pendant le rendu (et non dans un effet) : dès que
    // l'attente cesse, le prochain délai repart de zéro.
    if (wasActive !== active) {
        setWasActive(active);
        if (!active) setElapsed(false);
    }

    useEffect(() => {
        if (!active) return;
        const id = setTimeout(() => setElapsed(true), delay);
        return () => clearTimeout(id);
    }, [active, delay]);

    return active && elapsed;
}

// ---------------------------------------------------------------------------
// Export Excel — format d'import de régularisation dans FF.
//
// En-têtes (CODEIN / GENCODE / QTE / CODMV), codes mouvement (503 / 412),
// colonnes, valeurs et nom de fichier : à ne pas modifier, le fichier est
// importé tel quel dans FF. (`telechargerExcel` n'est pas utilisé : il fige la
// ligne d'en-tête et renseigne les propriétés du classeur, le fichier ne
// serait donc plus strictement identique.)
// ---------------------------------------------------------------------------

interface ExcelSpec<T> {
    sheet: string;
    filePrefix: string;
    header: string[];
    widths: number[];
    row: (r: T) => (string | number)[];
}

async function exporterPourFF<T>(excel: ExcelSpec<T>, rows: readonly T[], magasin: string) {
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(excel.sheet);
    ws.addRow(excel.header);
    ws.getRow(1).eachCell(cell => {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1E293B" } };
        cell.font = { color: { argb: "FFFFFFFF" }, bold: true };
        cell.alignment = { vertical: "middle", horizontal: "center" };
    });
    ws.getRow(1).height = 22;
    // L'export reprend l'intégralité des lignes filtrées, pas seulement la page affichée.
    for (const r of rows) ws.addRow(excel.row(r));
    ws.columns = excel.widths.map(width => ({ width }));
    const buffer = await wb.xlsx.writeBuffer();
    const blob = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${excel.filePrefix}_${magasin || "Tous"}_${new Date().toISOString().slice(0, 10)}.xlsx`;
    a.click();
    URL.revokeObjectURL(url);
}

const EXCEL_NEGATIF: ExcelSpec<PgStockNegatifRow> = {
    sheet: "Stock Négatif",
    filePrefix: "Stock_Negatif",
    header: ["CODEIN", "GENCODE", "QTE", "CODMV", "Dernière vente", "Dernière entrée"],
    widths: [16, 16, 10, 10, 16, 22],
    row: r => [r.codein, "", Math.abs(r.stockdispo), "503", fmtDate(r.dernierevente), fmtDate(r.derniereentree)],
};

const EXCEL_SANS_VENTE: ExcelSpec<PgStockSansVenteRow> = {
    sheet: "Entrées sans vente",
    filePrefix: "Entrees_Sans_Vente",
    header: ["CODEIN", "GENCODE", "QTE", "CODMV", "Dernière entrée"],
    widths: [16, 16, 10, 10, 22],
    row: r => [r.codein, "", r.stock_actuel, "412", fmtDate(r.derniere_entree)],
};

const EXCEL_SANS_VENTE_6MOIS: ExcelSpec<PgSansVente6MoisRow> = {
    sheet: "Sans vente 6 mois",
    filePrefix: "Sans_Vente_6Mois",
    header: ["CODEIN", "GENCODE", "QTE", "CODMV", "Dernière vente"],
    widths: [16, 16, 10, 10, 22],
    row: r => [r.codein, "", r.stock_actuel, "412", fmtDate(r.derniere_vente)],
};

// ---------------------------------------------------------------------------
// Colonnes et filtres des 3 onglets
//
// Définis au niveau module : leur identité doit rester stable d'un rendu à
// l'autre, sinon les `useMemo` du tableau se recalculent en boucle.
// ---------------------------------------------------------------------------

interface LigneStock {
    codein: string;
    libelle1: string;
    fournisseur: string;
    site: string;
}

/** Colonnes communes aux 3 onglets : code, libellé, fournisseur, magasin. */
function colonnesIdentite<T extends LigneStock>(): DataColumn<T>[] {
    return [
        {
            id: "codein",
            header: "Code article",
            sortValue: r => r.codein,
            cell: r => <span className="font-mono text-[13px] text-[var(--text-secondary)]">{r.codein}</span>,
            className: "whitespace-nowrap",
        },
        {
            id: "libelle1",
            header: "Libellé",
            sortValue: r => r.libelle1,
            cell: r => r.libelle1,
            className: "min-w-[220px]",
        },
        {
            id: "fournisseur",
            header: "Fournisseur",
            sortValue: r => r.fournisseur,
            cell: r => <span className="text-[var(--text-secondary)]">{r.fournisseur}</span>,
        },
        {
            id: "site",
            header: "Magasin",
            sortValue: r => nomMagasin(r.site),
            cell: r => <StoreBadge code={r.site} />,
        },
    ];
}

/** Quantité en stock : rouge si négative, en clair sinon. */
function celluleStock(v: number) {
    return (
        <span
            className={cn("font-semibold", v < 0 ? "text-[var(--accent-error)]" : "text-[var(--text-primary)]")}
        >
            {fmtDecimal1(v)}
        </span>
    );
}

const celluleDate = (v: string | null) => (
    <span className="whitespace-nowrap text-[13px] text-[var(--text-secondary)]">{fmtDate(v)}</span>
);

const rechercheStock = (r: LigneStock) => [r.codein, r.libelle1];

function filtreFournisseur<T extends LigneStock>(): DataFilter<T> {
    return { id: "fournisseur", label: "Fournisseur", valueOf: r => r.fournisseur, allLabel: "Tous les fournisseurs" };
}

function filtreAnneeEntree<T>(anneeOf: (r: T) => string): DataFilter<T> {
    return { id: "annee", label: "Année d'entrée", valueOf: anneeOf, allLabel: "Toutes les années", order: "desc" };
}

const COLONNES_NEGATIF: DataColumn<PgStockNegatifRow>[] = [
    ...colonnesIdentite<PgStockNegatifRow>(),
    {
        id: "stockdispo",
        header: "Stock",
        hint: "Stock calculé dans FF : il est négatif quand des ventes ont été enregistrées sans l'entrée de marchandise correspondante.",
        align: "right",
        sortValue: r => r.stockdispo,
        cell: r => celluleStock(r.stockdispo),
    },
    { id: "dernierevente", header: "Dernière vente", sortValue: r => r.dernierevente, cell: r => celluleDate(r.dernierevente) },
    { id: "derniereentree", header: "Dernière entrée", sortValue: r => r.derniereentree, cell: r => celluleDate(r.derniereentree) },
];
const FILTRES_NEGATIF: DataFilter<PgStockNegatifRow>[] = [
    filtreFournisseur<PgStockNegatifRow>(),
    filtreAnneeEntree<PgStockNegatifRow>(r => getYear(r.derniereentree)),
];

const COLONNES_SANS_VENTE: DataColumn<PgStockSansVenteRow>[] = [
    ...colonnesIdentite<PgStockSansVenteRow>(),
    {
        id: "stock_actuel",
        header: "Stock actuel",
        align: "right",
        sortValue: r => r.stock_actuel,
        cell: r => celluleStock(r.stock_actuel),
    },
    { id: "derniere_entree", header: "Dernière entrée", sortValue: r => r.derniere_entree, cell: r => celluleDate(r.derniere_entree) },
];
const FILTRES_SANS_VENTE: DataFilter<PgStockSansVenteRow>[] = [
    filtreFournisseur<PgStockSansVenteRow>(),
    filtreAnneeEntree<PgStockSansVenteRow>(r => getYear(r.derniere_entree)),
];

const COLONNES_SANS_VENTE_6MOIS: DataColumn<PgSansVente6MoisRow>[] = [
    ...colonnesIdentite<PgSansVente6MoisRow>(),
    {
        id: "stock_actuel",
        header: "Stock actuel",
        align: "right",
        sortValue: r => r.stock_actuel,
        cell: r => celluleStock(r.stock_actuel),
    },
    { id: "derniere_vente", header: "Dernière vente", sortValue: r => r.derniere_vente, cell: r => celluleDate(r.derniere_vente) },
    {
        id: "jours_sans_vente",
        header: "Jours sans vente",
        hint: "Nombre de jours depuis la dernière vente. En rouge : plus d'un an.",
        align: "right",
        sortValue: r => r.jours_sans_vente,
        cell: r =>
            r.jours_sans_vente != null ? (
                <span
                    className={cn(
                        "font-medium",
                        r.jours_sans_vente > 365 ? "text-[var(--accent-error)]" : "text-[var(--text-secondary)]",
                    )}
                >
                    {fmtEntier(r.jours_sans_vente)}
                </span>
            ) : (
                <span className="text-[13px] text-[var(--text-muted)]">Jamais vendu</span>
            ),
    },
    { id: "derniere_entree", header: "Dernière entrée", sortValue: r => r.derniere_entree, cell: r => celluleDate(r.derniere_entree) },
];
const FILTRES_SANS_VENTE_6MOIS: DataFilter<PgSansVente6MoisRow>[] = [filtreFournisseur<PgSansVente6MoisRow>()];

const cleLigne = (r: LigneStock, i: number) => `${r.codein}-${r.site}-${i}`;

// ---------------------------------------------------------------------------
// Composant principal avec onglets
// ---------------------------------------------------------------------------

const TAB_KEYS = ["negatif", "sans-vente", "sans-vente-6mois"] as const;

type TabKey = typeof TAB_KEYS[number];

function isTabKey(v: string): v is TabKey {
    return (TAB_KEYS as readonly string[]).includes(v);
}

/** Ce que liste chaque onglet, et quoi en faire. */
const EXPLICATIONS: Record<TabKey, ReactNode> = {
    "negatif": (
        <>
            Produits dont le <Terme id="stockNegatif">stock est négatif</Terme> : des ventes ont été enregistrées sans
            l&apos;entrée de marchandise correspondante. Vérifiez s&apos;il manque une réception, puis exportez la
            liste : le fichier Excel est prêt à être importé dans FF pour régulariser le stock.
        </>
    ),
    "sans-vente": (
        <>
            Produits reçus avant ce mois-ci, encore en stock, mais qui n&apos;ont jamais été vendus dans ce magasin.
            Vérifiez qu&apos;ils sont bien en rayon et étiquetés ; si le stock est erroné, exportez la liste : le
            fichier Excel est prêt à être importé dans FF pour le régulariser.
        </>
    ),
    "sans-vente-6mois": (
        <>
            Produits en stock qui ne se sont pas vendus depuis plus de 6 mois (ou jamais) et qui n&apos;ont pas été
            réapprovisionnés depuis. Mettez-les en avant ou en promotion ; si le stock est erroné, le fichier Excel
            exporté est prêt à être importé dans FF pour le régulariser.
        </>
    ),
};

const OPTIONS_MAGASINS = MAGASINS.map(m => ({ value: m.code, label: nomMagasin(m.code) }));

interface Props {
    rowsNegatif: PgStockNegatifRow[];
    rowsSansVente: PgStockSansVenteRow[];
    rowsSansVente6Mois: PgSansVente6MoisRow[];
    magasin: string;
    tab: string;
}

export function GestionStockClient({ rowsNegatif, rowsSansVente, rowsSansVente6Mois, magasin, tab }: Props) {
    const router = useRouter();
    const initialTab: TabKey = isTabKey(tab) ? tab : "negatif";

    const [activeTab, setActiveTab] = useState<TabKey>(initialTab);
    // Le changement d'onglet est purement client : les 3 jeux de données sont déjà chargés.
    const [switching, startSwitch] = useTransition();
    // Le changement de magasin, lui, relance les requêtes serveur.
    const [navigating, startNavigation] = useTransition();

    // Resynchronise l'onglet si l'URL change côté serveur (retour arrière, lien direct).
    const [urlTab, setUrlTab] = useState(initialTab);
    if (urlTab !== initialTab) {
        setUrlTab(initialTab);
        setActiveTab(initialTab);
    }

    function buildUrl(nextTab: TabKey, nextMagasin: string) {
        const params = new URLSearchParams();
        if (nextMagasin) params.set("magasin", nextMagasin);
        params.set("tab", nextTab);
        return `/stock-negatif?${params.toString()}`;
    }

    function handleMagasinChange(val: string) {
        startNavigation(() => {
            router.push(buildUrl(activeTab, val));
        });
    }

    function handleTabChange(key: TabKey) {
        if (key === activeTab || switching) return;
        // Mise à jour de l'URL sans navigation serveur : aucune requête SQL n'est rejouée.
        window.history.replaceState(null, "", buildUrl(key, magasin));
        startSwitch(() => setActiveTab(key));
    }

    const tabs: TabItem<TabKey>[] = useMemo(() => [
        { value: "negatif", label: "Stock négatif", count: rowsNegatif.length, alert: true },
        { value: "sans-vente", label: "Entrées sans vente", count: rowsSansVente.length },
        { value: "sans-vente-6mois", label: "Sans vente depuis 6 mois", count: rowsSansVente6Mois.length },
    ], [rowsNegatif, rowsSansVente, rowsSansVente6Mois]);

    const busy = switching || navigating;
    const showLoader = useDelayedFlag(busy);

    return (
        <div className="space-y-4" aria-busy={busy}>
            {/* Choix du magasin */}
            <div className="flex flex-wrap items-end gap-3">
                <Select
                    id="stock-magasin"
                    label="Magasin"
                    value={magasin}
                    onChange={handleMagasinChange}
                    disabled={navigating}
                    placeholder={LIBELLE_TOUS_MAGASINS}
                    options={OPTIONS_MAGASINS}
                />
                {showLoader && (
                    <span role="status" className="inline-flex h-9 items-center gap-2 text-[13px] text-[var(--text-secondary)]">
                        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                        Chargement…
                    </span>
                )}
            </div>

            <Tabs items={tabs} value={activeTab} onChange={handleTabChange} disabled={busy} />

            <p className="max-w-4xl text-sm text-[var(--text-secondary)]">{EXPLICATIONS[activeTab]}</p>

            <div className={cn("transition-opacity", showLoader && "pointer-events-none opacity-50")}>
                {activeTab === "negatif" && (
                    <DataTable<PgStockNegatifRow>
                        rows={rowsNegatif}
                        columns={COLONNES_NEGATIF}
                        rowKey={cleLigne}
                        searchIn={rechercheStock}
                        searchPlaceholder="Code article ou libellé…"
                        filters={FILTRES_NEGATIF}
                        pageSize={PAGE_SIZE}
                        unite="articles"
                        emptyTitle="Aucun article en stock négatif"
                        emptyDescription="Aucun stock n'est inférieur à zéro pour ce choix de magasin : rien à régulariser."
                        onExport={rows => exporterPourFF(EXCEL_NEGATIF, rows, magasin)}
                    />
                )}
                {activeTab === "sans-vente" && (
                    <DataTable<PgStockSansVenteRow>
                        rows={rowsSansVente}
                        columns={COLONNES_SANS_VENTE}
                        rowKey={cleLigne}
                        searchIn={rechercheStock}
                        searchPlaceholder="Code article ou libellé…"
                        filters={FILTRES_SANS_VENTE}
                        pageSize={PAGE_SIZE}
                        unite="articles"
                        emptyTitle="Aucun article reçu sans vente"
                        emptyDescription="Tous les produits reçus et encore en stock ont été vendus au moins une fois."
                        onExport={rows => exporterPourFF(EXCEL_SANS_VENTE, rows, magasin)}
                    />
                )}
                {activeTab === "sans-vente-6mois" && (
                    <DataTable<PgSansVente6MoisRow>
                        rows={rowsSansVente6Mois}
                        columns={COLONNES_SANS_VENTE_6MOIS}
                        rowKey={cleLigne}
                        searchIn={rechercheStock}
                        searchPlaceholder="Code article ou libellé…"
                        filters={FILTRES_SANS_VENTE_6MOIS}
                        pageSize={PAGE_SIZE}
                        unite="articles"
                        emptyTitle="Aucun article sans vente depuis 6 mois"
                        emptyDescription="Tous les produits en stock se sont vendus ou ont été réapprovisionnés ces 6 derniers mois."
                        onExport={rows => exporterPourFF(EXCEL_SANS_VENTE_6MOIS, rows, magasin)}
                    />
                )}
            </div>
        </div>
    );
}
