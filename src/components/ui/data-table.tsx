"use client";

/**
 * Tableau de données commun : recherche, filtres, tri par colonne, pagination,
 * export, état vide et ligne de totaux — identiques sur toutes les pages.
 *
 * Né du tableau de la page Stocks, qui avait déjà tout cela ; les autres pages
 * en réimplémentaient chacune une partie (13 tableaux faits à la main).
 */

import { useDeferredValue, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ChevronDown, ChevronUp, ChevronsUpDown, Download, Loader2, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { SearchInput, Select } from "@/components/ui/form-controls";
import { Pagination } from "@/components/ui/pagination";
import { EmptyState } from "@/components/ui/states";
import { Tooltip } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/feedback";

type Sens = "asc" | "desc";

export interface DataColumn<T> {
    id: string;
    header: ReactNode;
    /** Explication de la colonne, en infobulle sur l'en-tête. */
    hint?: ReactNode;
    align?: "left" | "right" | "center";
    /** Valeur de tri ; sans elle, la colonne n'est pas triable. */
    sortValue?: (row: T) => string | number | null | undefined;
    cell: (row: T) => ReactNode;
    /** Cellule de la ligne de totaux (cf. `showFooter`). */
    footer?: (rows: readonly T[]) => ReactNode;
    className?: string;
    headerClassName?: string;
    /**
     * Colonne de libellé (désignation, fournisseur…) : largeur naturelle, avec
     * retour à la ligne au-delà de 28rem. Le tableau ne s'étire jamais au-delà
     * de son contenu : sur un écran très large, le libellé reste collé à ses
     * chiffres au lieu d'en être séparé par un grand vide.
     */
    label?: boolean;
    /**
     * Colonne figée à gauche pendant le défilement horizontal. Seules les
     * premières colonnes consécutives peuvent l'être.
     */
    sticky?: boolean;
    /**
     * Groupe de colonnes (un magasin, « Total »…) : un en-tête commun est
     * affiché au-dessus des colonnes consécutives du même groupe, et un trait
     * vertical sépare les groupes.
     */
    group?: string;
    /** Fond légèrement teinté, pour faire ressortir un groupe (le total…). */
    highlight?: boolean;
}

export interface DataFilter<T> {
    id: string;
    label: string;
    valueOf: (row: T) => string | null | undefined;
    /** Libellé affiché pour une valeur (ex. code magasin → nom). */
    optionLabel?: (value: string) => string;
    /** Libellé de l'option « tout » (par défaut « Tous »). */
    allLabel?: string;
    /** Ordre des options : alphabétique (défaut) ou décroissant (années…). */
    order?: Sens;
}

interface DataTableProps<T> {
    rows: readonly T[];
    columns: readonly DataColumn<T>[];
    rowKey: (row: T, index: number) => string;
    /** Champs parcourus par la recherche ; sans eux, pas de champ de recherche. */
    searchIn?: (row: T) => (string | number | null | undefined)[];
    searchPlaceholder?: string;
    filters?: readonly DataFilter<T>[];
    /** Lignes par page ; 0 = tout afficher. */
    pageSize?: number;
    /** Nom des lignes comptées : « articles », « fournisseurs »… */
    unite?: string;
    emptyTitle?: ReactNode;
    emptyDescription?: ReactNode;
    /** Export des lignes filtrées et triées (toutes, pas seulement la page affichée). */
    onExport?: (rows: readonly T[]) => Promise<void> | void;
    exportLabel?: string;
    /** Contrôles supplémentaires, placés avant la recherche. */
    toolbar?: ReactNode;
    /** Affiche la ligne de totaux (colonnes avec `footer`). */
    showFooter?: boolean;
    initialSort?: { id: string; dir: Sens };
    onRowClick?: (row: T) => void;
    /** Hauteur maximale de la zone défilante (en-tête collant). */
    maxHeight?: string;
    className?: string;
}

const collator = new Intl.Collator("fr", { numeric: true, sensitivity: "base" });

function comparer(a: string | number | null | undefined, b: string | number | null | undefined): number {
    const videA = a === null || a === undefined || a === "";
    const videB = b === null || b === undefined || b === "";
    if (videA && videB) return 0;
    if (videA) return 1; // valeurs absentes toujours en fin de liste
    if (videB) return -1;
    if (typeof a === "number" && typeof b === "number") return a - b;
    return collator.compare(String(a), String(b));
}

export function DataTable<T>({
    rows,
    columns,
    rowKey,
    searchIn,
    searchPlaceholder = "Rechercher…",
    filters = [],
    pageSize = 50,
    unite = "lignes",
    emptyTitle = "Aucun résultat",
    emptyDescription,
    onExport,
    exportLabel = "Exporter en Excel",
    toolbar,
    showFooter = false,
    initialSort,
    onRowClick,
    maxHeight = "70vh",
    className,
}: DataTableProps<T>) {
    const [recherche, setRecherche] = useState("");
    const rechercheDifferee = useDeferredValue(recherche);
    const [valeursFiltres, setValeursFiltres] = useState<Record<string, string>>({});
    const [tri, setTri] = useState<{ id: string; dir: Sens } | null>(initialSort ?? null);
    const [page, setPage] = useState(1);
    const [exportEnCours, setExportEnCours] = useState(false);

    const optionsFiltres = useMemo(() => {
        const out: Record<string, { value: string; label: string }[]> = {};
        for (const f of filters) {
            const valeurs = new Set<string>();
            for (const r of rows) {
                const v = f.valueOf(r);
                if (v) valeurs.add(v);
            }
            const triees = [...valeurs].sort((a, b) => (f.order === "desc" ? -1 : 1) * collator.compare(a, b));
            out[f.id] = triees.map((v) => ({ value: v, label: f.optionLabel ? f.optionLabel(v) : v }));
        }
        return out;
    }, [filters, rows]);

    const filtrees = useMemo(() => {
        const q = rechercheDifferee.trim().toLowerCase();
        const actifs = filters.filter((f) => valeursFiltres[f.id]);
        if (!q && actifs.length === 0) return rows;
        return rows.filter((r) => {
            for (const f of actifs) if (f.valueOf(r) !== valeursFiltres[f.id]) return false;
            if (q && searchIn) {
                return searchIn(r).some((v) => v !== null && v !== undefined && String(v).toLowerCase().includes(q));
            }
            return true;
        });
    }, [rows, filters, valeursFiltres, rechercheDifferee, searchIn]);

    const triees = useMemo(() => {
        if (!tri) return filtrees;
        const col = columns.find((c) => c.id === tri.id);
        if (!col?.sortValue) return filtrees;
        const valeur = col.sortValue;
        const sens = tri.dir === "asc" ? 1 : -1;
        return [...filtrees].sort((a, b) => {
            const va = valeur(a);
            const vb = valeur(b);
            const vide = va === null || va === undefined || va === "" || vb === null || vb === undefined || vb === "";
            // Les valeurs absentes restent en fin de liste dans les deux sens.
            return vide ? comparer(va, vb) : comparer(va, vb) * sens;
        });
    }, [filtrees, tri, columns]);

    // Tout changement de filtre, de recherche ou de tri ramène à la page 1
    // (ajusté pendant le rendu, sans effet ni rendu supplémentaire).
    const [jeuPagine, setJeuPagine] = useState(triees);
    if (jeuPagine !== triees) {
        setJeuPagine(triees);
        setPage(1);
    }

    const total = triees.length;
    const pagine = pageSize > 0;
    const totalPages = pagine ? Math.max(1, Math.ceil(total / pageSize)) : 1;
    const pageCourante = Math.min(page, totalPages);
    const lignesAffichees = useMemo(
        () => (pagine ? triees.slice((pageCourante - 1) * pageSize, pageCourante * pageSize) : triees),
        [triees, pagine, pageCourante, pageSize],
    );

    const filtreActif = recherche !== "" || Object.values(valeursFiltres).some(Boolean);

    function basculerTri(id: string) {
        // Premier clic : les plus grands chiffres d'abord, mais l'ordre A→Z pour du texte.
        const col = columns.find((c) => c.id === id);
        const exemple = rows.length > 0 ? col?.sortValue?.(rows[0]) : undefined;
        const sensInitial: Sens = typeof exemple === "number" ? "desc" : "asc";
        setTri((t) => (t?.id === id ? { id, dir: t.dir === "asc" ? "desc" : "asc" } : { id, dir: sensInitial }));
    }

    async function exporter() {
        if (!onExport || exportEnCours) return;
        setExportEnCours(true);
        try {
            await onExport(triees);
        } catch (e) {
            toast.erreur(`L'export a échoué : ${e instanceof Error ? e.message : String(e)}`);
        } finally {
            setExportEnCours(false);
        }
    }

    const alignement = (a?: "left" | "right" | "center") =>
        a === "right" ? "text-right justify-end" : a === "center" ? "text-center justify-center" : "text-left";

    // Colonnes figées : seulement les premières, consécutives.
    let nbFigees = 0;
    while (nbFigees < columns.length && columns[nbFigees].sticky) nbFigees++;

    // Début de groupe : trait vertical à gauche de la colonne.
    const debutGroupe = (i: number) => Boolean(columns[i].group) && columns[i - 1]?.group !== columns[i].group;
    const avecGroupes = columns.some((c) => c.group);

    // Décalage gauche de chaque colonne figée = largeur cumulée des précédentes,
    // mesurée sur l'en-tête et exposée en variables CSS sur le tableau.
    const tableRef = useRef<HTMLTableElement>(null);
    const [decalages, setDecalages] = useState<number[]>([]);
    useLayoutEffect(() => {
        const table = tableRef.current;
        if (!table || nbFigees === 0) return;
        const mesurer = () => {
            const out: number[] = [];
            let gauche = 0;
            for (let i = 0; i < nbFigees; i++) {
                out.push(gauche);
                const th = table.querySelector<HTMLElement>(`thead th[data-col="${i}"]`);
                gauche += th?.getBoundingClientRect().width ?? 0;
            }
            setDecalages((prev) => (prev.length === out.length && prev.every((v, i) => v === out[i]) ? prev : out));
        };
        mesurer();
        const obs = new ResizeObserver(mesurer);
        obs.observe(table);
        return () => obs.disconnect();
    }, [nbFigees, total, columns]);

    const styleFigee = (i: number): CSSProperties | undefined =>
        i < nbFigees ? { left: decalages[i] ?? 0 } : undefined;

    /** Classes communes à toutes les cellules d'une colonne (en-tête, corps, totaux). */
    const classesColonne = (c: DataColumn<T>, i: number) => cn(
        i < nbFigees && "dt-sticky",
        i === nbFigees - 1 && "dt-sticky-last",
        c.highlight && "dt-highlight",
        debutGroupe(i) && "border-l border-[var(--border-strong)]",
    );

    /** Contenu d'une cellule de libellé, borné en largeur (cf. `label`). */
    const borne = (c: DataColumn<T>, i: number, contenu: ReactNode) =>
        c.label ? (
            // Libellé figé : plus étroit sur mobile pour laisser voir les chiffres.
            <div className={i < nbFigees ? "max-w-[45vw] md:max-w-[28rem]" : "max-w-[28rem]"}>{contenu}</div>
        ) : contenu;

    const enTete = (c: DataColumn<T>, i: number, rowSpan?: number) => {
        const triable = Boolean(c.sortValue);
        const actif = tri?.id === c.id;
        const contenu = (
            <span className={cn("inline-flex items-center gap-1", alignement(c.align))}>
                {c.header}
                {triable && (
                    actif
                        ? (tri!.dir === "asc" ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />)
                        : <ChevronsUpDown className="h-3.5 w-3.5 opacity-40" />
                )}
            </span>
        );
        return (
            <th
                key={c.id}
                scope="col"
                data-col={i}
                rowSpan={rowSpan}
                aria-sort={actif ? (tri!.dir === "asc" ? "ascending" : "descending") : undefined}
                style={styleFigee(i)}
                className={cn(
                    "whitespace-nowrap border-b border-[var(--border-strong)] px-3 py-2.5 text-[13px] font-semibold text-[var(--text-secondary)] align-bottom",
                    alignement(c.align),
                    classesColonne(c, i),
                    c.headerClassName,
                )}
            >
                {triable ? (
                    <button
                        type="button"
                        onClick={() => basculerTri(c.id)}
                        className="hover:text-[var(--text-primary)]"
                        title={typeof c.hint === "string" ? c.hint : undefined}
                    >
                        {contenu}
                    </button>
                ) : c.hint ? (
                    <Tooltip content={c.hint}><span className="cursor-help">{contenu}</span></Tooltip>
                ) : contenu}
            </th>
        );
    };

    // Première ligne d'en-tête quand il y a des groupes : un titre par groupe,
    // et les colonnes sans groupe sur deux lignes.
    const ligneGroupes: ReactNode[] = [];
    if (avecGroupes) {
        for (let i = 0; i < columns.length;) {
            const c = columns[i];
            if (!c.group) {
                ligneGroupes.push(enTete(c, i, 2));
                i++;
                continue;
            }
            let j = i;
            while (j < columns.length && columns[j].group === c.group) j++;
            ligneGroupes.push(
                <th
                    key={`groupe-${i}`}
                    scope="colgroup"
                    colSpan={j - i}
                    className={cn(
                        "whitespace-nowrap border-b border-l border-[var(--border)] px-3 pt-2 pb-1 text-center text-[13px] font-semibold text-[var(--text-primary)]",
                        "border-l-[var(--border-strong)]",
                        columns.slice(i, j).every((x) => x.highlight) && "dt-highlight",
                    )}
                >
                    {c.group}
                </th>,
            );
            i = j;
        }
    }

    return (
        <div className={cn("space-y-3", className)}>
            {/* Barre d'outils */}
            <div className="flex flex-wrap items-end justify-between gap-3">
                <div className="flex flex-wrap items-end gap-3">
                    {toolbar}
                    {searchIn && (
                        <SearchInput value={recherche} onChange={setRecherche} placeholder={searchPlaceholder} aria-label="Rechercher dans le tableau" />
                    )}
                    {filters.map((f) => (
                        <Select
                            key={f.id}
                            aria-label={f.label}
                            label={f.label}
                            value={valeursFiltres[f.id] ?? ""}
                            onChange={(v) => setValeursFiltres((s) => ({ ...s, [f.id]: v }))}
                            placeholder={f.allLabel ?? "Tous"}
                            options={optionsFiltres[f.id] ?? []}
                        />
                    ))}
                    {filtreActif && (
                        <Button
                            variant="ghost"
                            onClick={() => { setRecherche(""); setValeursFiltres({}); }}
                        >
                            <RotateCcw /> Effacer les filtres
                        </Button>
                    )}
                </div>
                <div className="flex items-center gap-3">
                    <span className="text-[13px] text-[var(--text-secondary)] tabular-nums">
                        <span className="font-semibold text-[var(--text-primary)]">{total.toLocaleString("fr-FR")}</span> {unite}
                        {filtreActif && total !== rows.length && <> sur {rows.length.toLocaleString("fr-FR")}</>}
                    </span>
                    {onExport && (
                        <Button variant="outline" onClick={exporter} disabled={exportEnCours || total === 0}>
                            {exportEnCours ? <Loader2 className="animate-spin" /> : <Download />}
                            {exportEnCours ? "Export en cours…" : exportLabel}
                        </Button>
                    )}
                </div>
            </div>

            {/* Tableau */}
            {total === 0 ? (
                <EmptyState
                    title={filtreActif ? "Aucune ligne ne correspond aux filtres" : emptyTitle}
                    description={filtreActif ? "Modifiez la recherche ou effacez les filtres." : emptyDescription}
                />
            ) : (
                <div
                    // Largeur du contenu, sans dépasser l'écran (au-delà : défilement).
                    className="w-fit max-w-full overflow-auto rounded-xl border border-[var(--border)] bg-[var(--bg-surface)] shadow-[var(--shadow-sm)]"
                    style={{ maxHeight }}
                >
                    <table ref={tableRef} className="dt-table text-sm">
                        <thead className="sticky top-0 z-10">
                            {avecGroupes ? (
                                <>
                                    <tr className="bg-[var(--bg-elevated)]">{ligneGroupes}</tr>
                                    <tr className="bg-[var(--bg-elevated)]">
                                        {columns.map((c, i) => (c.group ? enTete(c, i) : null))}
                                    </tr>
                                </>
                            ) : (
                                <tr className="bg-[var(--bg-elevated)]">{columns.map((c, i) => enTete(c, i))}</tr>
                            )}
                        </thead>
                        <tbody>
                            {lignesAffichees.map((r, i) => (
                                <tr
                                    key={rowKey(r, i)}
                                    onClick={onRowClick ? () => onRowClick(r) : undefined}
                                    className={cn(
                                        "dt-row border-b border-[var(--border)] last:border-b-0",
                                        onRowClick && "cursor-pointer",
                                    )}
                                >
                                    {columns.map((c, ci) => (
                                        <td
                                            key={c.id}
                                            style={styleFigee(ci)}
                                            className={cn(
                                                "px-3 py-2 text-[var(--text-primary)]",
                                                c.align === "right" && "text-right tabular-nums whitespace-nowrap",
                                                c.align === "center" && "text-center",
                                                classesColonne(c, ci),
                                                c.className,
                                            )}
                                        >
                                            {borne(c, ci, c.cell(r))}
                                        </td>
                                    ))}
                                </tr>
                            ))}
                        </tbody>
                        {showFooter && (
                            <tfoot className="sticky bottom-0 z-10 font-semibold">
                                <tr className="bg-[var(--bg-elevated)]">
                                    {columns.map((c, ci) => (
                                        <td
                                            key={c.id}
                                            style={styleFigee(ci)}
                                            className={cn(
                                                "border-t border-[var(--border-strong)] px-3 py-2.5 text-[var(--text-primary)]",
                                                c.align === "right" && "text-right tabular-nums whitespace-nowrap",
                                                c.align === "center" && "text-center",
                                                classesColonne(c, ci),
                                            )}
                                        >
                                            {c.footer ? borne(c, ci, c.footer(triees)) : null}
                                        </td>
                                    ))}
                                </tr>
                            </tfoot>
                        )}
                    </table>
                </div>
            )}

            {pagine && (
                <Pagination
                    page={pageCourante}
                    totalPages={totalPages}
                    total={total}
                    pageSize={pageSize}
                    onChange={setPage}
                    unite={unite}
                />
            )}
        </div>
    );
}
