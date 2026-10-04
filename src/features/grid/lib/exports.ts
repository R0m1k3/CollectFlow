/**
 * Exports de la Grille — regroupés en un seul menu.
 *
 * Il y avait deux menus d'export (en-tête et barre du bas) aux droits différents.
 * Les bibliothèques lourdes (exceljs, jspdf) ne sont chargées qu'au clic.
 * Les lignes sont lues dans le store au moment de l'export.
 */

import { useGridStore } from "@/features/grid/store/use-grid-store";
import type { ProductRow } from "@/types/grid";

function telecharger(blob: Blob, nomFichier: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = nomFichier;
    a.click();
    URL.revokeObjectURL(url);
}

const aujourdhui = () => new Date().toISOString().slice(0, 10);
const nomFichierSur = (nom: string) => nom.replace(/\s+/g, "_");

function gammeEffective(r: ProductRow, drafts: Record<string, string>): string | null {
    return (drafts[r.codein] ?? r.codeGamme) as string | null;
}

/** Lignes dont la gamme diffère de la gamme enregistrée dans FF. */
export function lignesModifiees(): ProductRow[] {
    const { rows, draftChanges } = useGridStore.getState();
    return rows.filter((r) => gammeEffective(r, draftChanges) !== r.codeGammeInit);
}

/**
 * Fichier d'import des gammes (CODE FOURNISSEUR, GENCOD, GAMME), généré par le
 * serveur. `seulementModifiees` : uniquement les gammes changées.
 * Renvoie `false` s'il n'y a rien à exporter.
 */
export async function exporterFichierGammes(seulementModifiees: boolean): Promise<boolean> {
    const { rows, draftChanges } = useGridStore.getState();
    const lignes = seulementModifiees ? lignesModifiees() : rows;
    if (lignes.length === 0) return false;

    const nomFournisseur = lignes[0].nomFournisseur;
    const changes = lignes.map((r) => ({
        codein: r.codein,
        gtin: r.gtin,
        codeFournisseur: r.codeFournisseur,
        gamme: gammeEffective(r, draftChanges) as string,
    }));

    const res = await fetch("/api/export/modified-gammes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nomFournisseur, changes }),
    });
    if (!res.ok) throw new Error(`le serveur a répondu ${res.status}`);

    const prefixe = seulementModifiees ? "Modifications_Gammes" : "Export_Complet";
    telecharger(await res.blob(), `${prefixe}_${nomFichierSur(nomFournisseur)}_${aujourdhui()}.xlsx`);
    return true;
}

/** Tous les produits avec gamme avant/après et chiffres sur 12 mois (Excel, généré par le serveur). */
export async function exporterTousProduits(nomFournisseur: string): Promise<boolean> {
    const { rows, draftChanges } = useGridStore.getState();
    if (rows.length === 0) return false;
    const supplier = nomFournisseur || rows[0]?.nomFournisseur || "Fournisseur";

    const res = await fetch("/api/export/excel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            nomFournisseur: supplier,
            rows: rows.map((r) => ({
                codein: r.codein,
                libelle1: r.libelle1 || "",
                code3: r.code3 || "",
                libelle3: r.libelle3 || "",
                codeGamme: gammeEffective(r, draftChanges),
                totalQuantite: r.totalQuantite,
                totalCa: r.totalCa,
                tauxMarge: r.tauxMarge,
                gammeAvant: r.codeGammeInit ?? null,
            })),
        }),
    });
    if (!res.ok) throw new Error(`le serveur a répondu ${res.status}`);
    telecharger(await res.blob(), `Assortiment_Complet_${nomFichierSur(supplier)}_${aujourdhui()}.xlsx`);
    return true;
}

/** Liste des produits en gamme A, pour les magasins (Excel). */
export async function exporterGammeA(): Promise<boolean> {
    const { rows, draftChanges } = useGridStore.getState();
    const gammeA = rows.filter((r) => gammeEffective(r, draftChanges) === "A");
    if (gammeA.length === 0) return false;

    const { Workbook } = await import("exceljs");
    const workbook = new Workbook();
    const worksheet = workbook.addWorksheet("Gamme A");
    worksheet.columns = [
        { header: "Magasin(s)", key: "magasins", width: 25 },
        { header: "Gencode", key: "gtin", width: 15 },
        { header: "Référence", key: "reference", width: 20 },
        { header: "Libellé", key: "libelle", width: 45 },
        { header: "Gamme", key: "gamme", width: 10 },
    ];
    worksheet.getRow(1).font = { bold: true };
    for (const row of gammeA) {
        worksheet.addRow({
            magasins: row.workingStores.join(", "),
            gtin: row.gtin || row.codein,
            reference: row.reference || "",
            libelle: row.libelle1 || "",
            gamme: gammeEffective(row, draftChanges),
        });
    }
    const buffer = await workbook.xlsx.writeBuffer();
    telecharger(
        new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
        `Export_Gamme_A_${aujourdhui()}.xlsx`,
    );
    return true;
}

/** Tableau imprimable (PDF paysage). */
export async function imprimerPdf(nomFournisseur: string): Promise<boolean> {
    const { rows, draftChanges } = useGridStore.getState();
    if (rows.length === 0) return false;

    const [{ default: jsPDF }, { default: autoTable }] = await Promise.all([
        import("jspdf"),
        import("jspdf-autotable"),
    ]);
    const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
    doc.setFontSize(16);
    doc.text("Analyse d'assortiment", 14, 15);
    doc.setFontSize(14);
    doc.setTextColor(50);
    if (nomFournisseur) doc.text(nomFournisseur, 14, 23);
    doc.setFontSize(10);
    doc.setTextColor(100);
    doc.text(`Export généré le : ${new Date().toLocaleDateString("fr-FR")}`, 14, 30);

    const head = [["Code-barres", "Code article", "Réf.", "Libellé", "Magasins réseau", "Qté", "CA", "Marge", "Gamme"]];
    const body = rows.map((r) => [
        r.gtin || r.codein,
        r.codein,
        r.reference || "-",
        r.libelle1 ? r.libelle1.substring(0, 60) + (r.libelle1.length > 60 ? "..." : "") : "",
        r.nbMagasinsReseau != null ? r.nbMagasinsReseau.toString() : "-",
        Math.round(r.totalQuantite).toLocaleString("fr-FR"),
        `${Math.round(r.totalCa).toLocaleString("fr-FR")} €`,
        `${Math.round(r.totalMarge).toLocaleString("fr-FR")} €\n(${r.tauxMarge.toFixed(1)}%)`,
        gammeEffective(r, draftChanges) || "-",
    ]);

    autoTable(doc, {
        head,
        body,
        startY: 35,
        styles: { fontSize: 8, cellPadding: 2, lineColor: [200, 200, 200], lineWidth: 0.1 },
        headStyles: { fillColor: [15, 23, 42], textColor: [255, 255, 255], fontStyle: "bold", halign: "center" },
        columnStyles: {
            0: { cellWidth: 28 },
            1: { cellWidth: 18, fontStyle: "bold", halign: "center" },
            2: { cellWidth: 25 },
            3: { cellWidth: 80 },
            4: { cellWidth: 12, halign: "center", fontStyle: "bold", textColor: [16, 185, 129] },
        },
        theme: "grid",
        didDrawPage: (data: { pageNumber: number; settings: { margin: { left: number } } }) => {
            doc.setFontSize(8);
            doc.text(`Page ${data.pageNumber}`, data.settings.margin.left, doc.internal.pageSize.height - 10);
        },
    });
    doc.save(`Assortiment_${aujourdhui()}.pdf`);
    return true;
}
