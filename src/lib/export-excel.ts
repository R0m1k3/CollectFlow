/**
 * Export Excel côté navigateur, commun aux pages (Stocks, Meilleures ventes,
 * Ventes par mois…). La bibliothèque n'est chargée qu'au moment de l'export.
 *
 * Il y avait trois mécanismes et deux bibliothèques (xlsx, exceljs) : une seule
 * subsiste, avec la même mise en forme d'en-tête partout.
 */

export type CelluleExcel = string | number | null | undefined;

interface ExportExcel {
    /** Nom de l'onglet du classeur. */
    feuille: string;
    /** Nom du fichier, sans extension ni date (ajoutées automatiquement). */
    fichier: string;
    entetes: string[];
    /** Largeurs de colonnes, en caractères. */
    largeurs?: number[];
    lignes: CelluleExcel[][];
    /** Ligne de totaux, mise en gras. */
    totaux?: CelluleExcel[];
}

export async function telechargerExcel({ feuille, fichier, entetes, largeurs, lignes, totaux }: ExportExcel): Promise<void> {
    const { Workbook } = await import("exceljs");
    const classeur = new Workbook();
    classeur.creator = "CollectFlow";
    classeur.created = new Date();
    const ws = classeur.addWorksheet(feuille.slice(0, 31)); // limite Excel

    ws.addRow(entetes);
    const entete = ws.getRow(1);
    entete.height = 22;
    entete.eachCell((cell) => {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1E293B" } };
        cell.font = { color: { argb: "FFFFFFFF" }, bold: true };
        cell.alignment = { vertical: "middle", horizontal: "center" };
    });
    ws.views = [{ state: "frozen", ySplit: 1 }];

    for (const l of lignes) ws.addRow(l.map((v) => v ?? ""));
    if (totaux) ws.addRow(totaux.map((v) => v ?? "")).font = { bold: true };
    if (largeurs) ws.columns = largeurs.map((width) => ({ width }));

    const buffer = await classeur.xlsx.writeBuffer();
    const blob = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${fichier}_${new Date().toISOString().slice(0, 10)}.xlsx`;
    a.click();
    URL.revokeObjectURL(url);
}
