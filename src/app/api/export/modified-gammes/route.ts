import { NextRequest, NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { z } from "zod";

const ExportModifiedGammesSchema = z.object({
    nomFournisseur: z.string(),
    changes: z.array(z.object({
        codein: z.string(),
        gtin: z.string(),
        codeFournisseur: z.string().optional(),
        gamme: z.string(),
    })),
});

export async function POST(req: NextRequest) {
    const body = await req.json();
    const parsed = ExportModifiedGammesSchema.safeParse(body);
    if (!parsed.success) {
        return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
    }

    const { nomFournisseur, changes } = parsed.data;
    const workbook = new ExcelJS.Workbook();
    workbook.creator = "CollectFlow";
    workbook.created = new Date();

    const sheet = workbook.addWorksheet("Gammes Modifiées", {
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
        { header: "CODE FOURNISSEUR", key: "codeFournisseur", width: 22 },
        { header: "GENCOD", key: "gtin", width: 18 },
        { header: "GAMME", key: "gamme", width: 12 },
    ];

    // Apply header style
    sheet.getRow(1).eachCell((cell) => { Object.assign(cell, headerStyle); });
    sheet.getRow(1).height = 22;

    for (const row of changes) {
        sheet.addRow({
            codeFournisseur: row.codeFournisseur || "—",
            gtin: row.gtin || "—",
            gamme: row.gamme || "—",
        });
    }

    // Centrer la colonne Gamme
    const gammeCol = sheet.getColumn("gamme");
    gammeCol.alignment = { horizontal: "center" };

    // Format codein et gtin en texte pour eviter la notation scientifique excel
    sheet.getColumn("codeFournisseur").numFmt = "@";
    sheet.getColumn("gtin").numFmt = "@";

    // Generate buffer
    const buffer = await workbook.xlsx.writeBuffer();

    const filename = `Modifications_Gammes_${nomFournisseur.replace(/\s+/g, "_")}_${new Date().toISOString().slice(0, 10)}.xlsx`;

    return new NextResponse(buffer, {
        headers: {
            "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "Content-Disposition": `attachment; filename="${filename}"`,
        },
    });
}
