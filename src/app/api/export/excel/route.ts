import { NextRequest, NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { z } from "zod";

const ExportSchema = z.object({
    nomFournisseur: z.string(),
    rows: z.array(z.object({
        codein: z.string(),
        libelle1: z.string(),
        code3: z.string(),
        libelle3: z.string(),
        codeGamme: z.string().nullable(),
        totalQuantite: z.number(),
        totalCa: z.number(),
        tauxMarge: z.number(),
        // Before gamme for delta
        gammeAvant: z.string().nullable().optional(),
    })),
});

export async function POST(req: NextRequest) {
    const body = await req.json();
    const parsed = ExportSchema.safeParse(body);
    if (!parsed.success) {
        return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
    }

    const { nomFournisseur, rows } = parsed.data;
    const workbook = new ExcelJS.Workbook();
    workbook.creator = "CollectFlow";
    workbook.created = new Date();

    const sheet = workbook.addWorksheet("Assortiment", {
        views: [{ state: "frozen", ySplit: 1 }],
    });

    // Header style
    const headerStyle: Partial<ExcelJS.Style> = {
        font: { bold: true, color: { argb: "FFFFFFFF" } },
        fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FF0F172A" } },
        alignment: { horizontal: "center" },
        border: { bottom: { style: "thin", color: { argb: "FF334155" } } },
    };

    sheet.columns = [
        { header: "Code", key: "codein", width: 14 },
        { header: "Désignation", key: "libelle1", width: 40 },
        { header: "Nomenclature", key: "libelle3", width: 25 },
        { header: "Gamme Avant", key: "gammeAvant", width: 14 },
        { header: "Gamme Après", key: "codeGamme", width: 14 },
        { header: "Delta", key: "delta", width: 10 },
        { header: "Vol. 12m", key: "totalQuantite", width: 12 },
        { header: "CA 12m (€)", key: "totalCa", width: 14 },
        { header: "Marge (%)", key: "tauxMarge", width: 12 },
    ];

    // Apply header style
    sheet.getRow(1).eachCell((cell) => { Object.assign(cell, headerStyle); });
    sheet.getRow(1).height = 22;

    // Gamme colours
    const GAMME_COLORS: Record<string, string> = {
        A: "FF064E3B", B: "FF1E3A5F", C: "FF78350F", Z: "FF4C0519",
    };

    for (const row of rows) {
        const delta = row.gammeAvant !== row.codeGamme ? `${row.gammeAvant ?? "—"} → ${row.codeGamme ?? "—"}` : "";
        const excelRow = sheet.addRow({
            codein: row.codein,
            libelle1: row.libelle1,
            libelle3: row.libelle3,
            gammeAvant: row.gammeAvant ?? "—",
            codeGamme: row.codeGamme ?? "—",
            delta,
            totalQuantite: Math.round(row.totalQuantite),
            totalCa: parseFloat(row.totalCa.toFixed(2)),
            tauxMarge: parseFloat(row.tauxMarge.toFixed(2)),
        });

        // Colour the "Gamme Après" cell
        const gammeCell = excelRow.getCell("codeGamme");
        if (row.codeGamme && GAMME_COLORS[row.codeGamme]) {
            gammeCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: GAMME_COLORS[row.codeGamme] } };
            gammeCell.font = { bold: true, color: { argb: "FFFFFFFF" } };
        }

        // Highlight changed rows
        if (delta) {
            excelRow.getCell("delta").font = { bold: true, color: { argb: "FFFBBF24" } };
        }

        // Format numbers
        excelRow.getCell("totalCa").numFmt = '#,##0.00 "€"';
        excelRow.getCell("tauxMarge").numFmt = '0.00"%"';
    }

    // Generate buffer
    const buffer = await workbook.xlsx.writeBuffer();

    const filename = `Assortiment_${nomFournisseur.replace(/\s+/g, "_")}_${new Date().toISOString().slice(0, 10)}.xlsx`;

    return new NextResponse(buffer, {
        headers: {
            "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "Content-Disposition": `attachment; filename="${filename}"`,
        },
    });
}
