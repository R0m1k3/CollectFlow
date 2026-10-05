"use client";

/**
 * CollectFlow — CA par nomenclature : nos magasins face au réseau.
 *
 * On part des lignes AFFICHÉES dans la Grille (filtres de nomenclature, de
 * gamme et recherche compris) et on les regroupe par nomenclature (`code3`).
 * La période est celle de la Grille : les 12 mois complets glissants, sur
 * laquelle sont calés à la fois les totaux FF par magasin et les chiffres
 * réseau Qlik.
 *
 * Comparer des montants bruts n'aurait pas de sens — le réseau compte ~270
 * magasins, nous deux. La comparaison passe donc par deux rapports :
 *   - le poids de la nomenclature dans le CA du périmètre, chez nous et dans
 *     le réseau (écart en points : où notre mix diverge de celui du réseau) ;
 *   - l'indice de chaque magasin face au magasin moyen du réseau
 *     (CA réseau ÷ 270) : 100 = au niveau du magasin moyen.
 */

import React, { useMemo, useState } from "react";
import { ChevronDown, ChevronUp, ChevronsUpDown, FileSpreadsheet, Layers, Loader2, Search } from "lucide-react";
import { DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { TuileStat } from "@/features/grid/components/stat-tile";
import { formatMonthLabel } from "@/features/grid/lib/months";
import { NB_MAGASINS_RESEAU } from "@/features/grid/lib/network-trend";
import { fmtDecimal1, fmtEntier, fmtEur2 } from "@/lib/format";
import { MAGASINS, nomMagasin } from "@/lib/magasins";
import type { ProductRow } from "@/types/grid";

/** Une nomenclature et ses chiffres sur la période. */
interface LigneNomenclature {
    code: string;
    libelle: string;
    nbProduits: number;
    /** Produits vendus dans au moins un de nos magasins. */
    nbVendus: number;
    /** Produits sans chiffre réseau (non rapprochés dans Qlik). */
    nbSansReseau: number;
    caParSite: Record<string, number>;
    caNous: number;
    caReseau: number;
    partNous: number | null;
    partReseau: number | null;
    /** Écart de poids, en points : partNous − partReseau. */
    ecartPoints: number | null;
    /** CA du magasin moyen du réseau (CA réseau ÷ nombre de magasins du réseau). */
    caMagasinMoyenReseau: number;
}

type CleTri = "libelle" | "caNous" | "caReseau" | "partNous" | "partReseau" | "ecartPoints" | `site:${string}`;

const SANS_NOMENCLATURE = "—";

const fmtPct = (v: number | null) => (v == null ? "—" : `${fmtDecimal1(v * 100)} %`);
const fmtPoints = (v: number | null) => (v == null ? "—" : `${v >= 0 ? "+" : ""}${fmtDecimal1(v * 100)} pts`);
const fmtEurOuTiret = (v: number) => (v !== 0 ? fmtEur2(v) : "—");

/** Indice d'un magasin face au magasin moyen du réseau (100 = au niveau). */
function indice(ca: number, caMagasinMoyen: number): number | null {
    if (caMagasinMoyen <= 0) return null;
    return (ca / caMagasinMoyen) * 100;
}

function couleurIndice(v: number | null): string {
    if (v == null) return "var(--text-muted)";
    return v >= 100 ? "var(--accent-success)" : "var(--accent-error)";
}

function couleurEcart(v: number | null): string {
    if (v == null || Math.abs(v) < 0.005) return "var(--text-muted)";
    return v > 0 ? "var(--accent-success)" : "var(--accent-error)";
}

/** Magasins présents dans les données, à défaut nos magasins connus — dans l'ordre de `MAGASINS`. */
function sitesDe(rows: ProductRow[]): string[] {
    const trouves = new Set<string>();
    for (const r of rows) for (const s of Object.keys(r.caByStore ?? {})) trouves.add(s);
    const connus = MAGASINS.map((m) => m.code);
    const autres = [...trouves].filter((s) => !connus.includes(s)).sort();
    return [...connus, ...autres];
}

function regrouper(rows: ProductRow[], sites: string[]): { lignes: LigneNomenclature[]; total: LigneNomenclature } {
    const groupes = new Map<string, LigneNomenclature>();
    const vide = (code: string, libelle: string): LigneNomenclature => ({
        code,
        libelle,
        nbProduits: 0,
        nbVendus: 0,
        nbSansReseau: 0,
        caParSite: Object.fromEntries(sites.map((s) => [s, 0])),
        caNous: 0,
        caReseau: 0,
        partNous: null,
        partReseau: null,
        ecartPoints: null,
        caMagasinMoyenReseau: 0,
    });
    const total = vide("", "Total");

    for (const r of rows) {
        const code = r.code3?.trim() || SANS_NOMENCLATURE;
        let g = groupes.get(code);
        if (!g) {
            g = vide(code, r.libelle3?.trim() || (code === SANS_NOMENCLATURE ? "Sans nomenclature" : code));
            groupes.set(code, g);
        }
        let caProduit = 0;
        for (const s of sites) {
            const ca = r.caByStore?.[s] ?? 0;
            g.caParSite[s] += ca;
            total.caParSite[s] += ca;
            caProduit += ca;
        }
        // Lignes sans détail par magasin : le total du produit reste compté.
        if (!r.caByStore && r.totalCa) caProduit = r.totalCa;
        g.caNous += caProduit;
        total.caNous += caProduit;

        for (const cible of [g, total]) {
            cible.nbProduits += 1;
            if (caProduit > 0) cible.nbVendus += 1;
            if (r.caReseau == null) cible.nbSansReseau += 1;
            else cible.caReseau += r.caReseau;
        }
    }

    const lignes = [...groupes.values()].filter((g) => g.caNous !== 0 || g.caReseau !== 0);
    for (const g of [...lignes, total]) {
        g.partNous = total.caNous > 0 ? g.caNous / total.caNous : null;
        g.partReseau = total.caReseau > 0 ? g.caReseau / total.caReseau : null;
        g.ecartPoints = g.partNous != null && g.partReseau != null ? g.partNous - g.partReseau : null;
        g.caMagasinMoyenReseau = g.caReseau / NB_MAGASINS_RESEAU;
    }
    return { lignes, total };
}

function valeurTri(l: LigneNomenclature, cle: CleTri): number | string {
    if (cle === "libelle") return l.libelle.toLowerCase();
    if (cle.startsWith("site:")) return l.caParSite[cle.slice(5)] ?? 0;
    const v = l[cle as Exclude<CleTri, "libelle" | `site:${string}`>];
    // Valeur absente : toujours en bas, quel que soit le sens.
    return v ?? Number.NaN;
}

/**
 * Classeur Excel de la liste affichée — valeurs numériques brutes pour que le
 * tableur puisse trier et sommer. `exceljs` est chargé à la demande.
 */
async function construireClasseur(
    lignes: LigneNomenclature[],
    total: LigneNomenclature,
    sites: string[],
    contexte: { fournisseur?: string; periode: string; nbLignesGrille: number },
): Promise<Blob> {
    const { Workbook } = await import("exceljs");
    const classeur = new Workbook();
    classeur.creator = "CollectFlow";
    classeur.created = new Date();

    const feuille = classeur.addWorksheet("CA par nomenclature", { views: [{ state: "frozen", ySplit: 1 }] });
    feuille.columns = [
        { header: "Code", key: "code", width: 12 },
        { header: "Nomenclature", key: "libelle", width: 36 },
        { header: "Produits", key: "nbProduits", width: 10 },
        { header: "Produits vendus", key: "nbVendus", width: 15 },
        ...sites.flatMap((s) => [
            { header: `CA ${nomMagasin(s, { court: true })}`, key: `ca_${s}`, width: 16 },
            { header: `Indice ${nomMagasin(s, { court: true })}`, key: `ind_${s}`, width: 14 },
        ]),
        { header: "CA nos magasins", key: "caNous", width: 16 },
        { header: "Poids chez nous", key: "partNous", width: 15 },
        { header: "CA réseau", key: "caReseau", width: 16 },
        { header: "CA magasin moyen réseau", key: "caMoyen", width: 22 },
        { header: "Poids réseau", key: "partReseau", width: 13 },
        { header: "Écart de poids (pts)", key: "ecart", width: 18 },
        { header: "Produits sans chiffre réseau", key: "nbSansReseau", width: 24 },
    ];
    feuille.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    feuille.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0F172A" } };
    feuille.getRow(1).height = 20;

    const ajouter = (l: LigneNomenclature) => feuille.addRow({
        code: l.code,
        libelle: l.libelle,
        nbProduits: l.nbProduits,
        nbVendus: l.nbVendus,
        ...Object.fromEntries(sites.flatMap((s) => {
            const ind = indice(l.caParSite[s] ?? 0, l.caMagasinMoyenReseau);
            return [[`ca_${s}`, l.caParSite[s] ?? 0], [`ind_${s}`, ind == null ? "" : Math.round(ind)]];
        })),
        caNous: l.caNous,
        partNous: l.partNous ?? "",
        caReseau: l.caReseau,
        caMoyen: l.caMagasinMoyenReseau,
        partReseau: l.partReseau ?? "",
        ecart: l.ecartPoints == null ? "" : Math.round(l.ecartPoints * 1000) / 10,
        nbSansReseau: l.nbSansReseau,
    });
    for (const l of lignes) ajouter(l);
    const ligneTotal = ajouter(total);
    ligneTotal.font = { bold: true };

    const eur = '#,##0.00 "€"';
    for (const cle of ["caNous", "caReseau", "caMoyen", ...sites.map((s) => `ca_${s}`)]) feuille.getColumn(cle).numFmt = eur;
    feuille.getColumn("partNous").numFmt = "0.0 %";
    feuille.getColumn("partReseau").numFmt = "0.0 %";
    feuille.getColumn("ecart").numFmt = '+0.0;-0.0;0.0';
    feuille.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: feuille.columns.length } };

    const contexteFeuille = classeur.addWorksheet("Contexte");
    contexteFeuille.columns = [{ width: 26 }, { width: 80 }];
    for (const [cle, valeur] of [
        ["Extraction", "CA par nomenclature — nos magasins et réseau"],
        ["Fournisseur", contexte.fournisseur ?? "—"],
        ["Période", contexte.periode],
        ["Périmètre", `${contexte.nbLignesGrille} produits affichés dans la Grille (filtres compris)`],
        ["Poids", "part de la nomenclature dans le CA du périmètre (chez nous / dans le réseau)"],
        ["Indice magasin", `CA du magasin ÷ CA du magasin moyen du réseau (CA réseau ÷ ${NB_MAGASINS_RESEAU}) × 100`],
        ["Généré le", new Date().toLocaleString("fr-FR")],
    ]) {
        contexteFeuille.addRow([cle, valeur]).getCell(1).font = { bold: true };
    }

    const buffer = await classeur.xlsx.writeBuffer();
    return new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

function EnTete({ label, cle, tri, onTri, align = "right", title }: {
    label: React.ReactNode;
    cle: CleTri;
    tri: { cle: CleTri; desc: boolean };
    onTri: (cle: CleTri) => void;
    align?: "left" | "right";
    title?: string;
}) {
    const actif = tri.cle === cle;
    const Icone = !actif ? ChevronsUpDown : tri.desc ? ChevronDown : ChevronUp;
    return (
        <th
            className={`px-2.5 py-1.5 font-semibold whitespace-nowrap ${align === "left" ? "text-left" : "text-right"}`}
            style={{ color: actif ? "var(--text-primary)" : "var(--text-secondary)" }}
            aria-sort={actif ? (tri.desc ? "descending" : "ascending") : "none"}
            title={title}
        >
            <button
                type="button"
                onClick={() => onTri(cle)}
                className={`inline-flex items-center gap-1 ${align === "left" ? "" : "flex-row-reverse"}`}
            >
                {label}
                <Icone className="w-3 h-3 shrink-0 opacity-60" />
            </button>
        </th>
    );
}

export function NomenclatureCaModal({ rows, mois, nomFournisseur, onClose }: {
    /** Les produits affichés dans la Grille (filtres et recherche compris). */
    rows: ProductRow[];
    /** Les 12 clés de mois de la Grille, du plus ancien au plus récent. */
    mois: string[];
    nomFournisseur?: string;
    onClose: () => void;
}) {
    const sites = useMemo(() => sitesDe(rows), [rows]);
    const { lignes, total } = useMemo(() => regrouper(rows, sites), [rows, sites]);

    const [tri, setTri] = useState<{ cle: CleTri; desc: boolean }>({ cle: "caNous", desc: true });
    const [recherche, setRecherche] = useState("");
    const [exportEnCours, setExportEnCours] = useState(false);
    const [exportErreur, setExportErreur] = useState<string | null>(null);

    const changerTri = (cle: CleTri) =>
        setTri((t) => (t.cle === cle ? { cle, desc: !t.desc } : { cle, desc: cle !== "libelle" }));

    const affichees = useMemo(() => {
        const q = recherche.trim().toLowerCase();
        const filtrees = q
            ? lignes.filter((l) => l.libelle.toLowerCase().includes(q) || l.code.toLowerCase().includes(q))
            : lignes;
        const sens = tri.desc ? -1 : 1;
        return [...filtrees].sort((a, b) => {
            const va = valeurTri(a, tri.cle);
            const vb = valeurTri(b, tri.cle);
            if (typeof va === "string" || typeof vb === "string") return String(va).localeCompare(String(vb), "fr") * sens;
            if (Number.isNaN(va)) return Number.isNaN(vb) ? 0 : 1;
            if (Number.isNaN(vb)) return -1;
            return (va - vb) * sens;
        });
    }, [lignes, recherche, tri]);

    const periode = mois.length > 0
        ? `${formatMonthLabel(mois[0])} → ${formatMonthLabel(mois[mois.length - 1])}`
        : "12 derniers mois";
    const absentesChezNous = lignes.filter((l) => l.caNous <= 0 && l.caReseau > 0).length;
    const indicesTotal = sites.map((s) => indice(total.caParSite[s] ?? 0, total.caMagasinMoyenReseau));

    const exporter = async () => {
        if (affichees.length === 0 || exportEnCours) return;
        setExportEnCours(true);
        setExportErreur(null);
        try {
            const blob = await construireClasseur(affichees, total, sites, {
                fournisseur: nomFournisseur,
                periode,
                nbLignesGrille: rows.length,
            });
            const url = URL.createObjectURL(blob);
            const lien = document.createElement("a");
            lien.href = url;
            lien.download = [
                "CA_nomenclatures",
                nomFournisseur?.replace(/[^\w]+/g, "_"),
                new Date().toISOString().slice(0, 10),
            ].filter(Boolean).join("_") + ".xlsx";
            lien.click();
            URL.revokeObjectURL(url);
        } catch (e) {
            console.error("[CA par nomenclature] export Excel :", e);
            setExportErreur("L'export a échoué. Réessayez, ou signalez-le si cela persiste.");
        } finally {
            setExportEnCours(false);
        }
    };

    const celluleSite = (l: LigneNomenclature, s: string, gras = false) => {
        const ca = l.caParSite[s] ?? 0;
        const ind = indice(ca, l.caMagasinMoyenReseau);
        return (
            <td key={s} className="px-2.5 py-1.5 text-right tabular-nums whitespace-nowrap">
                <div className={gras ? "font-bold" : "font-semibold"} style={{ color: ca !== 0 ? "var(--text-primary)" : "var(--text-muted)" }}>
                    {fmtEurOuTiret(ca)}
                </div>
                <div className="text-[11px]" style={{ color: couleurIndice(ind) }} title="Indice face au magasin moyen du réseau (100 = au niveau)">
                    {ind == null ? "—" : `indice ${fmtEntier(ind)}`}
                </div>
            </td>
        );
    };

    return (
        <DialogContent
            className="max-w-[calc(100%-2rem)] sm:max-w-6xl grid-cols-1 max-h-[88vh] overflow-y-auto"
            style={{ background: "var(--bg-surface)", border: "1px solid var(--border)" }}
            onInteractOutside={onClose}
        >
            <DialogHeader>
                <DialogTitle className="text-lg leading-snug pr-6 flex items-center gap-2" style={{ color: "var(--text-primary)" }}>
                    <Layers className="w-5 h-5 shrink-0" style={{ color: "var(--accent)" }} />
                    CA par nomenclature
                </DialogTitle>
                <p className="text-[13px] mt-1" style={{ color: "var(--text-muted)" }}>
                    {nomFournisseur ? <>{nomFournisseur} — </> : null}
                    <span className="font-semibold" style={{ color: "var(--text-secondary)" }}>{periode}</span>
                    {` — ${fmtEntier(rows.length)} produits affichés dans la Grille, par magasin et face au réseau.`}
                </p>
            </DialogHeader>

            <div className="flex flex-wrap gap-2">
                <TuileStat label="Nomenclatures" valeur={fmtEntier(lignes.length)} indice="avec du CA chez nous ou dans le réseau" />
                {sites.map((s, i) => (
                    <TuileStat
                        key={s}
                        label={`CA ${nomMagasin(s)}`}
                        valeur={fmtEur2(total.caParSite[s] ?? 0)}
                        indice={indicesTotal[i] == null ? undefined : `indice ${fmtEntier(indicesTotal[i]!)} face au magasin moyen du réseau`}
                    />
                ))}
                <TuileStat
                    label="CA réseau"
                    valeur={fmtEur2(total.caReseau)}
                    indice={`soit ${fmtEur2(total.caMagasinMoyenReseau)} par magasin moyen (${NB_MAGASINS_RESEAU} magasins)`}
                />
                <TuileStat
                    label="Absentes chez nous"
                    valeur={fmtEntier(absentesChezNous)}
                    indice="nomenclatures vendues dans le réseau, sans CA dans nos magasins"
                    couleur={absentesChezNous > 0 ? "var(--accent-warning)" : undefined}
                />
            </div>

            <div className="flex flex-wrap items-center gap-2">
                <div className="relative">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5" style={{ color: "var(--text-muted)" }} />
                    <input
                        type="search"
                        placeholder="Filtrer les nomenclatures…"
                        aria-label="Filtrer les nomenclatures"
                        value={recherche}
                        onChange={(e) => setRecherche(e.target.value)}
                        className="apple-input w-60"
                        style={{ paddingLeft: "32px" }}
                    />
                </div>
                <button
                    type="button"
                    onClick={exporter}
                    disabled={affichees.length === 0 || exportEnCours}
                    title="Exporter la liste affichée au format Excel"
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

            {affichees.length === 0 ? (
                <div className="rounded-xl p-4 text-center text-[13px]" style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)", color: "var(--text-muted)" }}>
                    {lignes.length === 0
                        ? "Aucune nomenclature avec du CA sur la période pour les produits affichés."
                        : "Aucune nomenclature ne correspond à ce filtre."}
                </div>
            ) : (
                <div className="rounded-xl overflow-x-auto min-w-0" style={{ border: "1px solid var(--border)" }}>
                    <table className="w-full text-[12px]" style={{ minWidth: 900 }}>
                        <thead>
                            <tr style={{ background: "var(--bg-elevated)" }}>
                                <EnTete label="Nomenclature" cle="libelle" tri={tri} onTri={changerTri} align="left" />
                                {sites.map((s) => (
                                    <EnTete key={s} label={`CA ${nomMagasin(s, { court: true })}`} cle={`site:${s}`} tri={tri} onTri={changerTri}
                                        title={`CA de ${nomMagasin(s)} sur la période, et son indice face au magasin moyen du réseau`} />
                                ))}
                                <EnTete label="CA nos magasins" cle="caNous" tri={tri} onTri={changerTri} />
                                <EnTete label="Poids chez nous" cle="partNous" tri={tri} onTri={changerTri}
                                    title="Part de la nomenclature dans le CA de nos magasins sur le périmètre affiché" />
                                <EnTete label="CA réseau" cle="caReseau" tri={tri} onTri={changerTri}
                                    title={`CA dans les magasins du réseau ; en dessous, le CA du magasin moyen (÷ ${NB_MAGASINS_RESEAU})`} />
                                <EnTete label="Poids réseau" cle="partReseau" tri={tri} onTri={changerTri}
                                    title="Part de la nomenclature dans le CA réseau sur le périmètre affiché" />
                                <EnTete label="Écart" cle="ecartPoints" tri={tri} onTri={changerTri}
                                    title="Poids chez nous − poids réseau, en points : positif = nomenclature plus forte chez nous que dans le réseau" />
                            </tr>
                        </thead>
                        <tbody>
                            {affichees.map((l) => (
                                <tr key={l.code} style={{ borderTop: "1px solid var(--border)" }}>
                                    <td className="px-2.5 py-1.5" style={{ color: "var(--text-primary)" }}>
                                        <div className="font-semibold">{l.libelle}</div>
                                        <div className="text-[11px] tabular-nums" style={{ color: "var(--text-muted)" }}>
                                            {l.code !== SANS_NOMENCLATURE && <>{l.code} · </>}
                                            {fmtEntier(l.nbVendus)} / {fmtEntier(l.nbProduits)} produits vendus
                                            {l.nbSansReseau > 0 && (
                                                <span title="Produits sans chiffre réseau (non rapprochés dans Qlik) : le CA réseau de la nomenclature est sous-estimé">
                                                    {" "}· {fmtEntier(l.nbSansReseau)} sans réseau
                                                </span>
                                            )}
                                        </div>
                                    </td>
                                    {sites.map((s) => celluleSite(l, s))}
                                    <td className="px-2.5 py-1.5 text-right tabular-nums font-bold whitespace-nowrap" style={{ color: l.caNous !== 0 ? "var(--text-primary)" : "var(--accent-warning)" }}>
                                        {fmtEurOuTiret(l.caNous)}
                                    </td>
                                    <td className="px-2.5 py-1.5 text-right tabular-nums whitespace-nowrap" style={{ color: "var(--text-secondary)" }}>
                                        {fmtPct(l.partNous)}
                                    </td>
                                    <td className="px-2.5 py-1.5 text-right tabular-nums whitespace-nowrap">
                                        <div className="font-semibold text-emerald-600 dark:text-emerald-400">{fmtEurOuTiret(l.caReseau)}</div>
                                        <div className="text-[11px]" style={{ color: "var(--text-muted)" }}>
                                            {l.caReseau !== 0 ? `${fmtEur2(l.caMagasinMoyenReseau)} / mag.` : ""}
                                        </div>
                                    </td>
                                    <td className="px-2.5 py-1.5 text-right tabular-nums whitespace-nowrap" style={{ color: "var(--text-secondary)" }}>
                                        {fmtPct(l.partReseau)}
                                    </td>
                                    <td className="px-2.5 py-1.5 text-right tabular-nums font-semibold whitespace-nowrap" style={{ color: couleurEcart(l.ecartPoints) }}>
                                        {fmtPoints(l.ecartPoints)}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                        <tfoot>
                            <tr style={{ borderTop: "2px solid var(--border-strong)", background: "var(--bg-elevated)" }}>
                                <td className="px-2.5 py-1.5 font-bold" style={{ color: "var(--text-primary)" }}>
                                    Total
                                    <div className="text-[11px] font-normal tabular-nums" style={{ color: "var(--text-muted)" }}>
                                        {fmtEntier(total.nbVendus)} / {fmtEntier(total.nbProduits)} produits vendus
                                    </div>
                                </td>
                                {sites.map((s) => celluleSite(total, s, true))}
                                <td className="px-2.5 py-1.5 text-right tabular-nums font-bold whitespace-nowrap" style={{ color: "var(--text-primary)" }}>
                                    {fmtEur2(total.caNous)}
                                </td>
                                <td className="px-2.5 py-1.5 text-right tabular-nums whitespace-nowrap" style={{ color: "var(--text-secondary)" }}>
                                    {fmtPct(total.partNous)}
                                </td>
                                <td className="px-2.5 py-1.5 text-right tabular-nums whitespace-nowrap">
                                    <div className="font-bold text-emerald-600 dark:text-emerald-400">{fmtEur2(total.caReseau)}</div>
                                    <div className="text-[11px]" style={{ color: "var(--text-muted)" }}>{fmtEur2(total.caMagasinMoyenReseau)} / mag.</div>
                                </td>
                                <td className="px-2.5 py-1.5 text-right tabular-nums whitespace-nowrap" style={{ color: "var(--text-secondary)" }}>
                                    {fmtPct(total.partReseau)}
                                </td>
                                <td className="px-2.5 py-1.5" />
                            </tr>
                        </tfoot>
                    </table>
                </div>
            )}

            <p className="text-xs leading-snug" style={{ color: "var(--text-muted)" }}>
                Période : les 12 mois complets de la Grille, communs à nos magasins et au réseau. Le poids est la part de la
                nomenclature dans le CA des produits affichés ; l&apos;écart compare notre mix à celui du réseau. L&apos;indice
                rapporte le CA d&apos;un magasin à celui du magasin moyen du réseau (CA réseau ÷ {NB_MAGASINS_RESEAU}) : 100 = au niveau.
                {total.nbSansReseau > 0 && ` ${fmtEntier(total.nbSansReseau)} produits n'ont pas de chiffre réseau : le CA réseau des nomenclatures concernées est sous-estimé.`}
            </p>
        </DialogContent>
    );
}
