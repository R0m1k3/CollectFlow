"use client";

/**
 * CollectFlow — Trous d'assortiment : ce qu'un magasin ne travaille pas.
 *
 * On part du CLASSEMENT AFFICHÉ, pas d'un classement maison : le tri en cours
 * dans la Grille — CA réseau, quantité, marge, peu importe — fixe l'ordre et
 * donc ce que « le haut du classement » veut dire. Recalculer un ordre ici
 * répondrait à une autre question que celle qu'on vient de poser à l'écran.
 *
 * « Non travaillé » = aucune vente sur 12 mois ET aucun stock au dernier mois
 * connu. Les deux conditions comptent : un article sans vente mais en stock est
 * détenu par le magasin, ce n'est pas un trou d'assortiment mais un invendu.
 */

import React, { useMemo, useState } from "react";
import { PackageX, Store, FileSpreadsheet, Loader2 } from "lucide-react";
import { DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { TuileStat } from "@/features/grid/components/stat-tile";
import { SITE_LABELS } from "@/features/grid/lib/months";
import type { ProductRow } from "@/types/grid";

/** Ligne du classement affiché : le produit et la valeur qui l'a classé. */
export interface LigneClassee {
    row: ProductRow;
    valeurCritere: unknown;
}

const PROFONDEURS = [100, 200, 500] as const;
export const PROFONDEUR_MAX = PROFONDEURS[PROFONDEURS.length - 1];

const nb = (v: number) => Math.round(v).toLocaleString("fr-FR");
const eur0 = (v: number) => `${Math.round(v).toLocaleString("fr-FR")} €`;
const eur2 = (v: number) => v.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";

/**
 * Libellé et mise en forme de la colonne de tri.
 *
 * Le tri porte sur des grandeurs sans commune mesure — des euros, des unités,
 * des pourcentages. Afficher la valeur brute rendrait la colonne illisible, et
 * ne rien afficher priverait le classement de sa justification.
 */
interface Critere {
    label: string;
    format: (v: number) => string;
    /** Format de nombre Excel — la valeur part BRUTE dans le tableur, qui doit
     *  pouvoir la trier et la sommer ; seule sa présentation est reprise ici. */
    xlsx: string;
    /** Normalisation avant export, quand la donnée stockée n'est pas l'unité affichée. */
    brut?: (v: number) => number;
}

const CRITERES: Record<string, Critere> = {
    caReseau:           { label: "CA réseau",          format: eur0, xlsx: '#,##0 "€"' },
    qteReseau:          { label: "Qté réseau",         format: nb,   xlsx: "#,##0" },
    nbMagasinsReseau:   { label: "Magasins réseau",    format: nb,   xlsx: "#,##0" },
    tendanceReseau:     { label: "Tendance réseau",    format: (v) => `${v >= 0 ? "+" : ""}${Math.round(v * 100)} %`, xlsx: "0 %" },
    prixMoyenReseau:    { label: "PV moyen réseau",    format: eur2, xlsx: '#,##0.00 "€"' },
    prixVente:          { label: "PV magasin",         format: eur2, xlsx: '#,##0.00 "€"' },
    caParMagasinReseau: { label: "CA / magasin réseau", format: eur0, xlsx: '#,##0 "€"' },
    margePctReseau:     { label: "Marge % réseau",     format: (v) => `${(Math.abs(v) <= 1 ? v * 100 : v).toFixed(1)} %`,
                          xlsx: '0.0 "%"', brut: (v) => (Math.abs(v) <= 1 ? v * 100 : v) },
    totalQuantite:      { label: "Qté 12 m",           format: nb,   xlsx: "#,##0" },
    totalCa:            { label: "CA 12 m",            format: eur0, xlsx: '#,##0 "€"' },
    totalMarge:         { label: "Marge 12 m",         format: eur0, xlsx: '#,##0 "€"' },
};

function libelleCritere(id: string | null): string {
    if (!id) return "ordre d'affichage";
    return CRITERES[id]?.label ?? id;
}

function formatCritere(id: string | null, valeur: unknown): string {
    if (valeur == null) return "—";
    if (typeof valeur !== "number") return String(valeur);
    // Les sentinelles de tri (valeurs manquantes, produit « nouveau ») ne sont
    // pas des mesures : les écrire donnerait un nombre qui n'existe pas.
    if (!Number.isFinite(valeur)) return "—";
    return (id && CRITERES[id]?.format(valeur)) ?? nb(valeur);
}

/** Ce que le magasin fait de ce produit, et ce que les autres en font. */
interface Constat {
    ventesMagasin: number;
    stockMagasin: number;
    /** Le magasin a déjà détenu ce produit sur la période (stock ou réception). */
    dejaDetenu: boolean;
    ventesAilleurs: number;
    stockAilleurs: number;
}

function constater(row: ProductRow, site: string, mois: string[]): Constat {
    const ventesParSite = row.sales12mByStore ?? {};
    const stockParSite = row.stock12mByStore ?? {};
    const receptionsParSite = row.receptions12mByStore ?? {};

    const somme = (serie?: Record<string, number>) =>
        mois.reduce((total, m) => total + (serie?.[m] ?? 0), 0);
    const dernier = (serie?: Record<string, number>) => serie?.[mois[mois.length - 1]] ?? 0;

    const ventesMagasin = row.quantiteByStore?.[site] ?? somme(ventesParSite[site]);
    const stockMagasin = dernier(stockParSite[site]);
    const maxStock = mois.reduce((max, m) => Math.max(max, stockParSite[site]?.[m] ?? 0), 0);

    let ventesAilleurs = 0;
    let stockAilleurs = 0;
    for (const autre of new Set([...Object.keys(ventesParSite), ...Object.keys(stockParSite)])) {
        if (autre === site) continue;
        ventesAilleurs += row.quantiteByStore?.[autre] ?? somme(ventesParSite[autre]);
        stockAilleurs += dernier(stockParSite[autre]);
    }

    return {
        ventesMagasin,
        stockMagasin,
        dejaDetenu: maxStock > 0 || somme(receptionsParSite[site]) > 0,
        ventesAilleurs,
        stockAilleurs,
    };
}

/** Ligne prête pour le tableur : le rang, le produit, le constat. */
interface TrouClasse {
    row: ProductRow;
    valeurCritere: unknown;
    rang: number;
    constat: Constat;
}

/**
 * Classeur Excel de la liste affichée.
 *
 * Deux feuilles : les données seules d'un côté — en-têtes ligne 1, filtre
 * automatique, valeurs NUMÉRIQUES pour que le tableur puisse trier et sommer —
 * et le contexte de l'extraction de l'autre. Mêler les deux dans une même
 * feuille condamnerait le filtre et le tri, alors que ce fichier a vocation à
 * être retravaillé.
 *
 * `exceljs` est chargé à la demande : il pèse lourd, et la Grille n'a pas à le
 * transporter pour tous ceux qui n'exportent jamais.
 */
async function construireClasseur(
    trous: TrouClasse[],
    contexte: { fournisseur?: string; magasin: string; critere: string; profondeur: number; examines: number },
    critereId: string | null,
): Promise<Blob> {
    const { Workbook } = await import("exceljs");
    const classeur = new Workbook();
    classeur.creator = "CollectFlow";
    classeur.created = new Date();

    const critere = critereId ? CRITERES[critereId] : undefined;
    const feuille = classeur.addWorksheet("Non travaillés", { views: [{ state: "frozen", ySplit: 1 }] });

    feuille.columns = [
        { header: "Rang", key: "rang", width: 8 },
        { header: "Code interne", key: "codein", width: 14 },
        { header: "Référence", key: "reference", width: 18 },
        { header: "EAN / GTIN", key: "gtin", width: 16 },
        { header: "Désignation", key: "libelle", width: 45 },
        { header: "Famille", key: "famille", width: 30 },
        { header: contexte.critere, key: "critere", width: 18 },
        { header: "Ventes ailleurs 12 m", key: "ventesAilleurs", width: 20 },
        { header: "Stock ailleurs", key: "stockAilleurs", width: 15 },
        { header: "Constat", key: "constat", width: 24 },
    ];

    feuille.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    feuille.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0F172A" } };
    feuille.getRow(1).height = 20;

    for (const { row, valeurCritere, rang, constat } of trous) {
        feuille.addRow({
            rang,
            codein: row.codein,
            reference: row.reference || "",
            gtin: row.gtin || "",
            libelle: row.libelle1 || "",
            famille: [row.code3, row.libelle3].filter(Boolean).join(" — "),
            critere: typeof valeurCritere === "number" && Number.isFinite(valeurCritere)
                ? (critere?.brut?.(valeurCritere) ?? valeurCritere)
                : (valeurCritere == null ? "" : String(valeurCritere)),
            ventesAilleurs: constat.ventesAilleurs,
            stockAilleurs: constat.stockAilleurs,
            constat: constat.dejaDetenu ? "déjà détenu, sans vente" : "jamais détenu",
        });
    }

    if (critere) feuille.getColumn("critere").numFmt = critere.xlsx;
    feuille.getColumn("ventesAilleurs").numFmt = "#,##0";
    feuille.getColumn("stockAilleurs").numFmt = "#,##0";
    feuille.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: feuille.columns.length } };

    const contexteFeuille = classeur.addWorksheet("Contexte");
    contexteFeuille.columns = [{ width: 26 }, { width: 60 }];
    for (const [cle, valeur] of [
        ["Extraction", "Produits non travaillés par un magasin"],
        ["Fournisseur", contexte.fournisseur ?? "—"],
        ["Magasin examiné", contexte.magasin],
        ["Classement", `${contexte.critere} — ${contexte.profondeur} premiers (${contexte.examines} examinés)`],
        ["Critère retenu", "aucune vente sur 12 mois glissants ET aucun stock au dernier mois connu"],
        ["Non travaillés", String(trous.length)],
        ["Généré le", new Date().toLocaleString("fr-FR")],
    ]) {
        const ligne = contexteFeuille.addRow([cle, valeur]);
        ligne.getCell(1).font = { bold: true };
    }

    const buffer = await classeur.xlsx.writeBuffer();
    return new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

export function AssortmentGapsModal({ classement, critereId, mois, magasinInitial, nomFournisseur, onClose }: {
    /** Le classement AFFICHÉ, dans son ordre — déjà tronqué à PROFONDEUR_MAX. */
    classement: LigneClassee[];
    critereId: string | null;
    /** Les 12 clés de mois, du plus ancien au plus récent. */
    mois: string[];
    magasinInitial: string;
    /** Sert à nommer le fichier exporté et à le documenter. */
    nomFournisseur?: string;
    onClose: () => void;
}) {
    // Magasins réellement présents dans les données, à défaut les deux sites connus.
    const sites = useMemo(() => {
        const trouves = new Set<string>();
        for (const { row } of classement) {
            for (const s of Object.keys(row.sales12mByStore ?? {})) trouves.add(s);
            for (const s of Object.keys(row.stock12mByStore ?? {})) trouves.add(s);
        }
        return trouves.size > 0 ? [...trouves].sort() : Object.keys(SITE_LABELS);
    }, [classement]);

    const [site, setSite] = useState(() => (sites.includes(magasinInitial) ? magasinInitial : sites[0]));
    const [profondeur, setProfondeur] = useState<number>(200);

    const examine = useMemo(() => classement.slice(0, profondeur), [classement, profondeur]);

    const trous = useMemo(() => examine
        .map((ligne, index) => ({ ...ligne, rang: index + 1, constat: constater(ligne.row, site, mois) }))
        .filter(({ constat }) => constat.ventesMagasin <= 0 && constat.stockMagasin <= 0),
        [examine, site, mois]);

    const [exportEnCours, setExportEnCours] = useState(false);
    const [exportErreur, setExportErreur] = useState<string | null>(null);

    const vendusAilleurs = trous.filter((t) => t.constat.ventesAilleurs > 0).length;
    const dejaTentes = trous.filter((t) => t.constat.dejaDetenu).length;
    const nomMagasin = SITE_LABELS[site]?.nom ?? site;
    const autresMagasins = sites.filter((s) => s !== site).map((s) => SITE_LABELS[s]?.nom ?? s).join(", ") || "les autres";

    const exporter = async () => {
        if (trous.length === 0 || exportEnCours) return;
        setExportEnCours(true);
        setExportErreur(null);
        try {
            const blob = await construireClasseur(
                trous,
                {
                    fournisseur: nomFournisseur,
                    magasin: nomMagasin,
                    critere: libelleCritere(critereId),
                    profondeur,
                    examines: examine.length,
                },
                critereId,
            );
            const url = URL.createObjectURL(blob);
            const lien = document.createElement("a");
            lien.href = url;
            lien.download = [
                "Non_travailles",
                nomFournisseur?.replace(/[^\w]+/g, "_"),
                nomMagasin.replace(/[^\w]+/g, "_"),
                `Top${profondeur}`,
                new Date().toISOString().slice(0, 10),
            ].filter(Boolean).join("_") + ".xlsx";
            lien.click();
            URL.revokeObjectURL(url);
        } catch (e) {
            // Un export qui échoue en silence laisse croire au téléchargement.
            console.error("[trous d'assortiment] export Excel :", e);
            setExportErreur("L'export a échoué. Réessayez, ou signalez-le si cela persiste.");
        } finally {
            setExportEnCours(false);
        }
    };

    return (
        <DialogContent
            className="max-w-[calc(100%-2rem)] sm:max-w-5xl grid-cols-1 max-h-[88vh] overflow-y-auto"
            style={{ background: "var(--bg-surface)", border: "1px solid var(--border)" }}
            onInteractOutside={onClose}
        >
            <DialogHeader>
                <DialogTitle className="text-lg leading-snug pr-6 flex items-center gap-2" style={{ color: "var(--text-primary)" }}>
                    <PackageX className="w-5 h-5 shrink-0" style={{ color: "var(--accent-warning)" }} />
                    Produits non travaillés par un magasin
                </DialogTitle>
                <p className="text-[13px] mt-1" style={{ color: "var(--text-muted)" }}>
                    Sur le classement affiché — trié par{" "}
                    <span className="font-semibold" style={{ color: "var(--text-secondary)" }}>{libelleCritere(critereId)}</span>
                    {" — ni vente ni stock sur 12 mois."}
                </p>
            </DialogHeader>

            {/* Réglages : quel magasin, et jusqu'où dans le classement */}
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
                <div className="flex items-center gap-2">
                    <span className="text-[12px] font-semibold uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>Magasin</span>
                    <div className="inline-flex rounded-lg p-0.5" style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)" }}>
                        {sites.map((s) => (
                            <button
                                key={s}
                                type="button"
                                onClick={() => setSite(s)}
                                aria-pressed={site === s}
                                className="px-3 py-1 text-[12px] font-semibold rounded-md transition-colors flex items-center gap-1.5"
                                style={site === s
                                    ? { background: "var(--bg-surface)", color: "var(--text-primary)" }
                                    : { color: "var(--text-muted)" }}
                            >
                                <Store className="w-3 h-3" />
                                {SITE_LABELS[s]?.nom ?? s}
                            </button>
                        ))}
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    <span className="text-[12px] font-semibold uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>Profondeur</span>
                    <div className="inline-flex rounded-lg p-0.5" style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)" }}>
                        {PROFONDEURS.map((p) => (
                            <button
                                key={p}
                                type="button"
                                onClick={() => setProfondeur(p)}
                                aria-pressed={profondeur === p}
                                className="px-3 py-1 text-[12px] font-semibold rounded-md transition-colors tabular-nums"
                                style={profondeur === p
                                    ? { background: "var(--bg-surface)", color: "var(--text-primary)" }
                                    : { color: "var(--text-muted)" }}
                            >
                                Top {p}
                            </button>
                        ))}
                    </div>
                    {classement.length < profondeur && (
                        <span className="text-[11.5px]" style={{ color: "var(--text-muted)" }}>
                            ({classement.length} lignes affichées seulement)
                        </span>
                    )}
                </div>

                {/* L'export reprend exactement la liste affichée : même magasin,
                    même profondeur, même classement. */}
                <button
                    type="button"
                    onClick={exporter}
                    disabled={trous.length === 0 || exportEnCours}
                    title={trous.length === 0
                        ? "Rien à exporter : aucun trou dans ce périmètre"
                        : `Exporter les ${trous.length} produits non travaillés au format Excel`}
                    className="ml-auto flex items-center gap-2 px-3 py-1.5 rounded-md text-[12px] font-semibold border transition-all disabled:opacity-50"
                    style={{ background: "var(--bg-elevated)", borderColor: "var(--border-strong)", color: "var(--text-secondary)" }}
                >
                    {exportEnCours ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileSpreadsheet className="w-3.5 h-3.5" />}
                    {exportEnCours ? "Génération…" : "Export Excel"}
                </button>
            </div>

            {exportErreur && (
                <div className="rounded-lg px-3 py-2 text-[12px]" style={{ background: "var(--accent-error-bg)", border: "1px solid var(--accent-error)", color: "var(--accent-error)" }}>
                    {exportErreur}
                </div>
            )}

            <div className="flex flex-wrap gap-2">
                <TuileStat
                    label="Non travaillés"
                    valeur={`${trous.length} / ${examine.length}`}
                    indice={`à ${nomMagasin}`}
                    couleur={trous.length > 0 ? "var(--accent-warning)" : undefined}
                    icone={PackageX}
                />
                <TuileStat
                    label="Vendus ailleurs"
                    valeur={nb(vendusAilleurs)}
                    indice={`déjà vendus chez ${autresMagasins} — le gisement le plus sûr`}
                />
                <TuileStat
                    label="Déjà détenus"
                    valeur={nb(dejaTentes)}
                    indice="stock ou réception sur la période, sans vente : essayés, pas oubliés"
                />
            </div>

            {trous.length === 0 ? (
                <div className="rounded-xl p-4 text-center text-[13px]" style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)", color: "var(--text-muted)" }}>
                    Aucun trou dans les {examine.length} premiers : {nomMagasin} travaille tout le haut de ce classement.
                </div>
            ) : (
                <div className="rounded-xl overflow-x-auto min-w-0" style={{ border: "1px solid var(--border)" }}>
                    <table className="w-full text-[12px]" style={{ minWidth: 820 }}>
                        <thead>
                            <tr style={{ background: "var(--bg-elevated)" }}>
                                <th className="text-right px-2.5 py-1.5 font-semibold" style={{ color: "var(--text-secondary)" }}>#</th>
                                <th className="text-left px-2.5 py-1.5 font-semibold" style={{ color: "var(--text-secondary)" }}>Code</th>
                                <th className="text-left px-2.5 py-1.5 font-semibold" style={{ color: "var(--text-secondary)" }}>Référence</th>
                                <th className="text-left px-2.5 py-1.5 font-semibold" style={{ color: "var(--text-secondary)" }}>Désignation</th>
                                <th className="text-right px-2.5 py-1.5 font-semibold whitespace-nowrap" style={{ color: "var(--text-secondary)" }}>
                                    {libelleCritere(critereId)}
                                </th>
                                <th className="text-right px-2.5 py-1.5 font-semibold whitespace-nowrap" style={{ color: "var(--text-secondary)" }}>Ventes ailleurs</th>
                                <th className="text-right px-2.5 py-1.5 font-semibold whitespace-nowrap" style={{ color: "var(--text-secondary)" }}>Stock ailleurs</th>
                                <th className="text-left px-2.5 py-1.5 font-semibold" style={{ color: "var(--text-secondary)" }}>Constat</th>
                            </tr>
                        </thead>
                        <tbody>
                            {trous.map(({ row, valeurCritere, rang, constat }) => (
                                <tr key={row.codein} style={{ borderTop: "1px solid var(--border)" }}>
                                    <td className="px-2.5 py-1.5 text-right tabular-nums" style={{ color: "var(--text-muted)" }}>{rang}</td>
                                    <td className="px-2.5 py-1.5 tabular-nums font-semibold whitespace-nowrap" style={{ color: "var(--text-secondary)" }}>{row.codein}</td>
                                    <td className="px-2.5 py-1.5 font-mono text-[11.5px] whitespace-nowrap" style={{ color: "var(--text-secondary)" }}>
                                        {row.reference || "—"}
                                    </td>
                                    <td className="px-2.5 py-1.5" style={{ color: "var(--text-primary)" }} title={row.libelle1}>
                                        <span className="font-semibold">{row.libelle1}</span>
                                        {row.libelle3 && (
                                            <span className="ml-1.5 text-[10.5px]" style={{ color: "var(--text-muted)" }}>{row.libelle3}</span>
                                        )}
                                    </td>
                                    <td className="px-2.5 py-1.5 text-right tabular-nums font-semibold whitespace-nowrap" style={{ color: "var(--text-primary)" }}>
                                        {formatCritere(critereId, valeurCritere)}
                                    </td>
                                    <td className="px-2.5 py-1.5 text-right tabular-nums whitespace-nowrap"
                                        style={{ color: constat.ventesAilleurs > 0 ? "var(--accent-success)" : "var(--text-muted)" }}>
                                        {constat.ventesAilleurs > 0 ? nb(constat.ventesAilleurs) : "—"}
                                    </td>
                                    <td className="px-2.5 py-1.5 text-right tabular-nums whitespace-nowrap" style={{ color: "var(--text-secondary)" }}>
                                        {constat.stockAilleurs > 0 ? nb(constat.stockAilleurs) : "—"}
                                    </td>
                                    <td className="px-2.5 py-1.5 whitespace-nowrap" style={{ color: "var(--text-muted)" }}>
                                        {constat.dejaDetenu ? "déjà détenu, sans vente" : "jamais détenu"}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            <p className="text-[11.5px] leading-snug" style={{ color: "var(--text-muted)" }}>
                Non travaillé = aucune vente sur les 12 mois glissants ET aucun stock au dernier mois connu, à {nomMagasin}.
                Un produit sans vente mais en stock n&apos;apparaît pas ici : le magasin le détient, c&apos;est un invendu, pas un trou d&apos;assortiment.
            </p>
        </DialogContent>
    );
}
