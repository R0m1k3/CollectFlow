"use client";

import { useRouter } from "next/navigation";
import { useState, useMemo, useEffect, useTransition, type ReactNode } from "react";
import {
    ChevronUp,
    ChevronDown,
    ChevronsUpDown,
    ChevronLeft,
    ChevronRight,
    ChevronsLeft,
    ChevronsRight,
    Download,
    Search,
} from "lucide-react";
import LoadingModal from "@/components/shared/loading-modal";
import type { PgStockNegatifRow, PgStockSansVenteRow, PgSansVente6MoisRow } from "./page";

type SortDir = "asc" | "desc";

/** Nombre de lignes rendues simultanément : au-delà, le navigateur fige. */
const PAGE_SIZE = 50;

/** Un seul collateur réutilisé : `localeCompare` en crée un par appel (très coûteux sur 17 000 lignes). */
const collator = new Intl.Collator("fr", { numeric: true, sensitivity: "base" });

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
 * Évite le clignotement du modal sur les transitions instantanées.
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
// Tableau générique (les 3 onglets partagent filtres, tri, pagination, export)
// ---------------------------------------------------------------------------

interface Column<T> {
    key: Extract<keyof T, string>;
    label: string;
    /** Tri numérique au lieu du tri alphabétique. */
    numeric?: boolean;
    render?: (row: T) => ReactNode;
}

interface ExcelSpec<T> {
    sheet: string;
    filePrefix: string;
    header: string[];
    widths: number[];
    row: (r: T) => (string | number)[];
}

interface StockTableProps<T> {
    rows: T[];
    magasin: string;
    columns: Column<T>[];
    fournisseurOf: (r: T) => string;
    /** Source du filtre « Année » — omis, le filtre n'est pas affiché. */
    anneeOf?: (r: T) => string;
    anneeLabel?: string;
    searchIn: (r: T) => (string | null | undefined)[];
    emptyLabel: string;
    excel: ExcelSpec<T>;
}

function SortIcon({ active, dir }: { active: boolean; dir: SortDir }) {
    if (!active) return <ChevronsUpDown className="inline w-3 h-3 ml-1 opacity-30" />;
    return dir === "asc"
        ? <ChevronUp className="inline w-3 h-3 ml-1" />
        : <ChevronDown className="inline w-3 h-3 ml-1" />;
}

function FilterSelect({ label, value, onChange, options }: {
    label: string;
    value: string;
    onChange: (v: string) => void;
    options: string[];
}) {
    return (
        <div className="flex items-center gap-2">
            <label className="text-sm font-medium text-gray-600 whitespace-nowrap">{label}</label>
            <select
                value={value}
                onChange={e => onChange(e.target.value)}
                className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 min-w-[150px]"
            >
                <option value="">Tous</option>
                {options.map(o => <option key={o} value={o}>{o}</option>)}
            </select>
        </div>
    );
}

function Pagination({ page, totalPages, total, from, to, onChange }: {
    page: number;
    totalPages: number;
    total: number;
    from: number;
    to: number;
    onChange: (p: number) => void;
}) {
    if (total === 0) return null;

    const btn = "rounded-lg border border-gray-200 bg-white p-1.5 text-gray-600 shadow-sm transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40";

    return (
        <div className="flex flex-wrap items-center justify-between gap-3 px-1">
            <span className="text-xs text-gray-500">
                Lignes <span className="font-medium text-gray-700">{from.toLocaleString("fr-FR")}</span>
                {" à "}
                <span className="font-medium text-gray-700">{to.toLocaleString("fr-FR")}</span>
                {" sur "}
                <span className="font-medium text-gray-700">{total.toLocaleString("fr-FR")}</span>
            </span>
            <div className="flex items-center gap-1.5">
                <button className={btn} onClick={() => onChange(1)} disabled={page <= 1} aria-label="Première page">
                    <ChevronsLeft className="w-4 h-4" />
                </button>
                <button className={btn} onClick={() => onChange(page - 1)} disabled={page <= 1} aria-label="Page précédente">
                    <ChevronLeft className="w-4 h-4" />
                </button>
                <span className="px-2 text-xs text-gray-600 tabular-nums">
                    Page {page.toLocaleString("fr-FR")} / {totalPages.toLocaleString("fr-FR")}
                </span>
                <button className={btn} onClick={() => onChange(page + 1)} disabled={page >= totalPages} aria-label="Page suivante">
                    <ChevronRight className="w-4 h-4" />
                </button>
                <button className={btn} onClick={() => onChange(totalPages)} disabled={page >= totalPages} aria-label="Dernière page">
                    <ChevronsRight className="w-4 h-4" />
                </button>
            </div>
        </div>
    );
}

function StockTable<T extends object>({
    rows,
    magasin,
    columns,
    fournisseurOf,
    anneeOf,
    anneeLabel = "Année entrée",
    searchIn,
    emptyLabel,
    excel,
}: StockTableProps<T>) {
    const [filterFournisseur, setFilterFournisseur] = useState("");
    const [filterAnnee, setFilterAnnee] = useState("");
    const [search, setSearch] = useState("");
    // `null` = ordre renvoyé par la base (le plus pertinent : stock le plus négatif,
    // entrée la plus récente…). Aucun tri client tant que l'utilisateur n'en demande pas.
    const [sortKey, setSortKey] = useState<Extract<keyof T, string> | null>(null);
    const [sortDir, setSortDir] = useState<SortDir>("asc");
    const [page, setPage] = useState(1);
    const [exporting, setExporting] = useState(false);

    const fournisseurs = useMemo(
        () => [...new Set(rows.map(fournisseurOf).filter(Boolean))].sort((a, b) => collator.compare(a, b)),
        [rows, fournisseurOf]
    );
    const annees = useMemo(
        () => anneeOf ? [...new Set(rows.map(anneeOf).filter(Boolean))].sort((a, b) => b.localeCompare(a)) : [],
        [rows, anneeOf]
    );

    const filtered = useMemo(() => {
        const q = search.trim().toLowerCase();
        if (!filterFournisseur && !filterAnnee && !q) return rows;
        return rows.filter(r =>
            (!filterFournisseur || fournisseurOf(r) === filterFournisseur) &&
            (!filterAnnee || (anneeOf ? anneeOf(r) === filterAnnee : true)) &&
            (!q || searchIn(r).some(v => v?.toLowerCase().includes(q)))
        );
    }, [rows, filterFournisseur, filterAnnee, search, fournisseurOf, anneeOf, searchIn]);

    const numericKeys = useMemo(
        () => new Set(columns.filter(c => c.numeric).map(c => c.key as string)),
        [columns]
    );

    const sorted = useMemo(() => {
        if (!sortKey) return filtered;
        const numeric = numericKeys.has(sortKey);
        const dir = sortDir === "asc" ? 1 : -1;
        return [...filtered].sort((a, b) => {
            const av = (a as Record<string, unknown>)[sortKey];
            const bv = (b as Record<string, unknown>)[sortKey];
            if (numeric) {
                const an = Number(av);
                const bn = Number(bv);
                if (Number.isNaN(an) && Number.isNaN(bn)) return 0;
                if (Number.isNaN(an)) return 1;
                if (Number.isNaN(bn)) return -1;
                return (an - bn) * dir;
            }
            return collator.compare(String(av ?? ""), String(bv ?? "")) * dir;
        });
    }, [filtered, sortKey, sortDir, numericKeys]);

    // Toute modification des filtres / du tri ramène à la première page.
    // Ajustement pendant le rendu : pas d'effet, donc pas de rendu en cascade.
    const [pagedSet, setPagedSet] = useState(sorted);
    if (pagedSet !== sorted) {
        setPagedSet(sorted);
        setPage(1);
    }

    const total = sorted.length;
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const currentPage = Math.min(page, totalPages);
    const pageRows = useMemo(
        () => sorted.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE),
        [sorted, currentPage]
    );

    function handleSort(key: Extract<keyof T, string>) {
        if (sortKey === key) setSortDir(d => (d === "asc" ? "desc" : "asc"));
        else { setSortKey(key); setSortDir("asc"); }
    }

    const hasFilters = Boolean(filterFournisseur || filterAnnee || search);

    async function handleExport() {
        if (exporting) return;
        setExporting(true);
        try {
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
            for (const r of sorted) ws.addRow(excel.row(r));
            ws.columns = excel.widths.map(width => ({ width }));
            const buffer = await wb.xlsx.writeBuffer();
            const blob = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `${excel.filePrefix}_${magasin || "Tous"}_${new Date().toISOString().slice(0, 10)}.xlsx`;
            a.click();
            URL.revokeObjectURL(url);
        } finally {
            setExporting(false);
        }
    }

    return (
        <div className="space-y-4">
            {exporting && (
                <LoadingModal
                    message="Génération du fichier Excel"
                    subMessage={`${total.toLocaleString("fr-FR")} ligne${total !== 1 ? "s" : ""} en cours d'écriture…`}
                />
            )}

            <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-3">
                    <div className="relative">
                        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 pointer-events-none" />
                        <input
                            type="text"
                            value={search}
                            onChange={e => setSearch(e.target.value)}
                            placeholder="Code article ou libellé…"
                            className="rounded-lg border border-gray-200 bg-white pl-8 pr-3 py-1.5 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 min-w-[220px]"
                        />
                    </div>
                    <FilterSelect label="Fournisseur" value={filterFournisseur} onChange={setFilterFournisseur} options={fournisseurs} />
                    {anneeOf && (
                        <FilterSelect label={anneeLabel} value={filterAnnee} onChange={setFilterAnnee} options={annees} />
                    )}
                    {hasFilters && (
                        <button
                            onClick={() => { setFilterFournisseur(""); setFilterAnnee(""); setSearch(""); }}
                            className="rounded-lg border border-orange-200 bg-orange-50 px-3 py-1.5 text-xs font-medium text-orange-700 hover:bg-orange-100 transition-colors"
                        >
                            ✕ Réinitialiser
                        </button>
                    )}
                </div>
                <div className="flex items-center gap-3">
                    <span className="text-sm text-gray-500">
                        {total.toLocaleString("fr-FR")} article{total !== 1 ? "s" : ""}
                        {hasFilters && total !== rows.length && (
                            <span className="text-gray-400"> / {rows.length.toLocaleString("fr-FR")}</span>
                        )}
                    </span>
                    <button
                        onClick={handleExport}
                        disabled={exporting || total === 0}
                        className="flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white shadow-sm transition-colors hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        <Download className="w-4 h-4" />Exporter Excel
                    </button>
                </div>
            </div>

            <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
                <table className="min-w-full text-sm">
                    <thead className="bg-gray-50 border-b border-gray-200">
                        <tr>
                            {columns.map(c => (
                                <th
                                    key={c.key}
                                    onClick={() => handleSort(c.key)}
                                    className="cursor-pointer select-none whitespace-nowrap px-3 py-2.5 text-left text-xs font-semibold text-gray-600 uppercase tracking-wide hover:text-gray-900"
                                >
                                    {c.label}
                                    <SortIcon active={sortKey === c.key} dir={sortDir} />
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                        {pageRows.length === 0 && (
                            <tr>
                                <td colSpan={columns.length} className="px-3 py-8 text-center text-gray-400">{emptyLabel}</td>
                            </tr>
                        )}
                        {pageRows.map((row, i) => (
                            <tr key={`${String((row as Record<string, unknown>).codein)}-${String((row as Record<string, unknown>).site)}-${i}`}
                                className="hover:bg-gray-50 transition-colors">
                                {columns.map(c => (
                                    <td key={c.key} className="px-3 py-2">
                                        {c.render
                                            ? c.render(row)
                                            : String((row as Record<string, unknown>)[c.key] ?? "")}
                                    </td>
                                ))}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            <Pagination
                page={currentPage}
                totalPages={totalPages}
                total={total}
                from={total === 0 ? 0 : (currentPage - 1) * PAGE_SIZE + 1}
                to={Math.min(currentPage * PAGE_SIZE, total)}
                onChange={p => setPage(Math.min(Math.max(1, p), totalPages))}
            />
        </div>
    );
}

// ---------------------------------------------------------------------------
// Cellules partagées
// ---------------------------------------------------------------------------

const cellCode = (v: string) => <span className="font-mono text-xs text-gray-700">{v}</span>;
const cellSite = (v: string) => (
    <span className="rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700">{v}</span>
);
const cellDate = (v: string | null) => <span className="text-gray-600 text-xs">{fmtDate(v)}</span>;

// ---------------------------------------------------------------------------
// Configuration des 3 onglets
//
// Définies au niveau module : leur identité doit rester stable d'un rendu à
// l'autre, sinon les `useMemo` de StockTable se recalculent en boucle.
// ---------------------------------------------------------------------------

type TabConfig<T> = Omit<StockTableProps<T>, "rows" | "magasin">;

const NEGATIF_CONFIG: TabConfig<PgStockNegatifRow> = {
    fournisseurOf: r => r.fournisseur,
    anneeOf: r => getYear(r.derniereentree),
    searchIn: r => [r.codein, r.libelle1],
    emptyLabel: "Aucun article en stock négatif",
    columns: [
        { key: "codein", label: "Code article", render: r => cellCode(r.codein) },
        { key: "libelle1", label: "Libellé", render: r => <span className="text-gray-900">{r.libelle1}</span> },
        { key: "fournisseur", label: "Fournisseur", render: r => <span className="text-gray-700">{r.fournisseur}</span> },
        { key: "site", label: "Magasin", render: r => cellSite(r.site) },
        { key: "stockdispo", label: "Stock", numeric: true, render: r => <span className="font-semibold text-red-600">{r.stockdispo}</span> },
        { key: "dernierevente", label: "Dernière vente", render: r => cellDate(r.dernierevente) },
        { key: "derniereentree", label: "Dernière entrée", render: r => cellDate(r.derniereentree) },
    ],
    excel: {
        sheet: "Stock Négatif",
        filePrefix: "Stock_Negatif",
        header: ["CODEIN", "GENCODE", "QTE", "CODMV", "Dernière vente", "Dernière entrée"],
        widths: [16, 16, 10, 10, 16, 22],
        row: r => [r.codein, "", Math.abs(r.stockdispo), "503", fmtDate(r.dernierevente), fmtDate(r.derniereentree)],
    },
};

const SANS_VENTE_CONFIG: TabConfig<PgStockSansVenteRow> = {
    fournisseurOf: r => r.fournisseur,
    anneeOf: r => getYear(r.derniere_entree),
    searchIn: r => [r.codein, r.libelle1],
    emptyLabel: "Aucun article trouvé",
    columns: [
        { key: "codein", label: "Code article", render: r => cellCode(r.codein) },
        { key: "libelle1", label: "Libellé", render: r => <span className="text-gray-900">{r.libelle1}</span> },
        { key: "fournisseur", label: "Fournisseur", render: r => <span className="text-gray-700">{r.fournisseur}</span> },
        { key: "site", label: "Magasin", render: r => cellSite(r.site) },
        { key: "stock_actuel", label: "Stock actuel", numeric: true, render: r => <span className="font-semibold text-amber-600">{r.stock_actuel}</span> },
        { key: "derniere_entree", label: "Dernière entrée", render: r => cellDate(r.derniere_entree) },
    ],
    excel: {
        sheet: "Entrées sans vente",
        filePrefix: "Entrees_Sans_Vente",
        header: ["CODEIN", "GENCODE", "QTE", "CODMV", "Dernière entrée"],
        widths: [16, 16, 10, 10, 22],
        row: r => [r.codein, "", r.stock_actuel, "412", fmtDate(r.derniere_entree)],
    },
};

const SANS_VENTE_6MOIS_CONFIG: TabConfig<PgSansVente6MoisRow> = {
    fournisseurOf: r => r.fournisseur,
    searchIn: r => [r.codein, r.libelle1],
    emptyLabel: "Aucun article trouvé",
    columns: [
        { key: "codein", label: "Code article", render: r => cellCode(r.codein) },
        { key: "libelle1", label: "Libellé", render: r => <span className="text-gray-900">{r.libelle1}</span> },
        { key: "fournisseur", label: "Fournisseur", render: r => <span className="text-gray-700">{r.fournisseur}</span> },
        { key: "site", label: "Magasin", render: r => cellSite(r.site) },
        { key: "stock_actuel", label: "Stock actuel", numeric: true, render: r => <span className="font-semibold text-amber-600">{r.stock_actuel}</span> },
        { key: "derniere_vente", label: "Dernière vente", render: r => cellDate(r.derniere_vente) },
        {
            key: "jours_sans_vente",
            label: "Jours sans vente",
            numeric: true,
            render: r => (
                <span
                    className="tabular-nums font-medium"
                    style={{ color: r.jours_sans_vente && r.jours_sans_vente > 365 ? "#ef4444" : "#6b7280" }}
                >
                    {r.jours_sans_vente != null ? r.jours_sans_vente.toLocaleString("fr-FR") : "—"}
                </span>
            ),
        },
        { key: "derniere_entree", label: "Dernière entrée", render: r => cellDate(r.derniere_entree) },
    ],
    excel: {
        sheet: "Sans vente 6 mois",
        filePrefix: "Sans_Vente_6Mois",
        header: ["CODEIN", "GENCODE", "QTE", "CODMV", "Dernière vente"],
        widths: [16, 16, 10, 10, 22],
        row: r => [r.codein, "", r.stock_actuel, "412", fmtDate(r.derniere_vente)],
    },
};

// ---------------------------------------------------------------------------
// Composant principal avec onglets
// ---------------------------------------------------------------------------

const TABS = [
    { key: "negatif", label: "Stock négatif" },
    { key: "sans-vente", label: "Entrées sans vente" },
    { key: "sans-vente-6mois", label: "Sans vente 6 mois" },
] as const;

type TabKey = typeof TABS[number]["key"];

function isTabKey(v: string): v is TabKey {
    return TABS.some(t => t.key === v);
}

interface Props {
    rowsNegatif: PgStockNegatifRow[];
    rowsSansVente: PgStockSansVenteRow[];
    rowsSansVente6Mois: PgSansVente6MoisRow[];
    magasin: string;
    tab: string;
    sites: { code: string; label: string }[];
}

export function GestionStockClient({ rowsNegatif, rowsSansVente, rowsSansVente6Mois, magasin, tab, sites }: Props) {
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

    function handleMagasinChange(e: React.ChangeEvent<HTMLSelectElement>) {
        const val = e.target.value;
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

    const counts: Record<TabKey, number> = useMemo(() => ({
        "negatif": rowsNegatif.length,
        "sans-vente": rowsSansVente.length,
        "sans-vente-6mois": rowsSansVente6Mois.length,
    }), [rowsNegatif, rowsSansVente, rowsSansVente6Mois]);

    const busy = switching || navigating;
    const showLoader = useDelayedFlag(busy);
    const loaderMessage = navigating ? "Chargement des données" : "Préparation de l'onglet";
    const loaderSubMessage = navigating
        ? "Interrogation du stock pour le magasin sélectionné…"
        : "Application des filtres et du tri…";

    return (
        <div className="space-y-4" aria-busy={busy}>
            {showLoader && <LoadingModal message={loaderMessage} subMessage={loaderSubMessage} />}

            {/* Toolbar */}
            <div className="flex flex-wrap items-center gap-3">
                <div className="flex items-center gap-2">
                    <label className="text-sm font-medium text-gray-700">Magasin</label>
                    <select
                        value={magasin}
                        onChange={handleMagasinChange}
                        disabled={navigating}
                        className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:cursor-wait disabled:opacity-60"
                    >
                        <option value="">Tous les magasins</option>
                        {sites.map(s => (
                            <option key={s.code} value={s.code}>{s.label}</option>
                        ))}
                    </select>
                </div>
            </div>

            {/* Tabs */}
            <div className="border-b border-gray-200">
                <nav className="-mb-px flex gap-1">
                    {TABS.map(t => {
                        const isActive = activeTab === t.key;
                        return (
                            <button
                                key={t.key}
                                onClick={() => handleTabChange(t.key)}
                                disabled={busy}
                                aria-current={isActive ? "page" : undefined}
                                className={[
                                    "px-4 py-2.5 text-sm font-medium border-b-2 transition-colors whitespace-nowrap",
                                    isActive
                                        ? "border-blue-600 text-blue-600"
                                        : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300",
                                    busy ? "cursor-wait" : "",
                                ].join(" ")}
                            >
                                {t.label}
                                <span className={[
                                    "ml-2 rounded-full px-2 py-0.5 text-xs font-semibold",
                                    isActive ? "bg-blue-100 text-blue-700" : "bg-gray-100 text-gray-500",
                                ].join(" ")}>
                                    {counts[t.key].toLocaleString("fr-FR")}
                                </span>
                            </button>
                        );
                    })}
                </nav>
            </div>

            {/* Tab content */}
            {activeTab === "negatif" && (
                <StockTable<PgStockNegatifRow> rows={rowsNegatif} magasin={magasin} {...NEGATIF_CONFIG} />
            )}
            {activeTab === "sans-vente" && (
                <StockTable<PgStockSansVenteRow> rows={rowsSansVente} magasin={magasin} {...SANS_VENTE_CONFIG} />
            )}
            {activeTab === "sans-vente-6mois" && (
                <StockTable<PgSansVente6MoisRow> rows={rowsSansVente6Mois} magasin={magasin} {...SANS_VENTE_6MOIS_CONFIG} />
            )}
        </div>
    );
}
