"use client";

import { useState } from "react";
import { Download, FileSpreadsheet, FileText, ChevronDown } from "lucide-react";
import * as ExcelJS from "exceljs";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { useGridStore } from "@/features/grid/store/use-grid-store";

export function ExportDropdown() {
    const [isOpen, setIsOpen] = useState(false);
    const { rows, draftChanges } = useGridStore();

    const handleExportExcel = async () => {
        setIsOpen(false);
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet("Gamme A");

        worksheet.columns = [
            { header: "Magasin(s)", key: "magasins", width: 25 },
            { header: "Gencode", key: "gtin", width: 15 },
            { header: "Référence", key: "reference", width: 20 },
            { header: "Libellé", key: "libelle", width: 45 },
            { header: "Gamme", key: "gamme", width: 10 },
        ];

        // Format Header
        worksheet.getRow(1).font = { bold: true };

        // Filter for effective Gamme A
        const gammeARows = rows.filter((row) => {
            const effectiveGamme = draftChanges[row.codein] ?? row.codeGamme;
            return effectiveGamme === "A";
        });

        gammeARows.forEach((row) => {
            worksheet.addRow({
                magasins: row.workingStores.join(", "),
                gtin: row.gtin || row.codein, // Fallback if no true gtin
                reference: row.reference || "",
                libelle: row.libelle1 || "",
                gamme: draftChanges[row.codein] ?? row.codeGamme,
            });
        });

        const buffer = await workbook.xlsx.writeBuffer();
        const blob = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
        const url = URL.createObjectURL(blob);

        const a = document.createElement("a");
        a.href = url;
        a.download = `Export_Gamme_A_${new Date().toISOString().split("T")[0]}.xlsx`;
        a.click();
        URL.revokeObjectURL(url);
    };

    const handlePrintPDF = () => {
        setIsOpen(false);
        const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });

        doc.setFontSize(16);
        doc.text("Analyse d'Assortiment", 14, 15);
        doc.setFontSize(10);
        doc.setTextColor(100);
        doc.text(`Export généré le : ${new Date().toLocaleDateString("fr-FR")}`, 14, 22);

        // Dynamically get last 12 months for headers
        const months: string[] = [];
        const now = new Date();
        for (let i = 12; i >= 1; i--) {
            const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
            months.push(`${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}`);
        }

        const formatMonth = (key: string) => {
            const m = parseInt(key.slice(4, 6), 10);
            const names = ["Jan", "Fév", "Mar", "Avr", "Mai", "Jun", "Jul", "Aoû", "Sep", "Oct", "Nov", "Déc"];
            return `${names[m - 1]} ${key.slice(2, 4)}`;
        };

        const head = [
            ["Mag", "Code In", "Réf.", "Libellé", "Score", ...months.map(formatMonth), "Vol.", "CA", "Marge", "Gamme"]
        ];

        const body = rows.map(r => {
            const effectiveGamme = draftChanges[r.codein] ?? r.codeGamme;
            return [
                r.workingStores.join(","),
                r.codein,
                r.reference || "-",
                r.libelle1 ? r.libelle1.substring(0, 40) + (r.libelle1.length > 40 ? "..." : "") : "",
                r.score.toString(),
                ...months.map(m => r.sales12m[m] ? Math.round(r.sales12m[m]).toString() : ""),
                Math.round(r.totalQuantite).toLocaleString("fr-FR"),
                `${Math.round(r.totalCa).toLocaleString("fr-FR")} €`,
                `${Math.round(r.totalMarge).toLocaleString("fr-FR")} €\n(${r.tauxMarge.toFixed(1)}%)`,
                effectiveGamme || "-"
            ];
        });

        // @ts-ignore (autotable acts as a plugin)
        autoTable(doc, {
            head,
            body,
            startY: 28,
            styles: { fontSize: 6.5, cellPadding: 1.5, lineColor: [200, 200, 200], lineWidth: 0.1 },
            headStyles: { fillColor: [15, 23, 42], textColor: [255, 255, 255], fontStyle: "bold", halign: "center" },
            columnStyles: {
                0: { cellWidth: 10, halign: "center" }, // Magasins
                1: { cellWidth: 14, fontStyle: "bold" }, // Code In
                2: { cellWidth: 18 }, // Réf
                3: { cellWidth: 45 }, // Libellé
                4: { cellWidth: 10, halign: "center", fontStyle: "bold", textColor: [16, 185, 129] }, // Score
                // The next 12 columns are the months. Let autotable size them.
            },
            theme: "grid",
            didDrawPage: (data: any) => {
                // Footer pagination
                doc.setFontSize(8);
                doc.text(
                    `Page ${data.pageNumber}`,
                    data.settings.margin.left,
                    doc.internal.pageSize.height - 10
                );
            }
        });

        doc.save(`Assortiment_${new Date().toISOString().split("T")[0]}.pdf`);
    };

    return (
        <div className="relative z-50 print:hidden">
            <button
                onClick={() => setIsOpen(!isOpen)}
                className="btn-action btn-action-secondary flex items-center gap-2"
                title="Exporter les données"
            >
                <Download className="w-[14px] h-[14px]" />
                <span className="text-[13px] font-semibold">Exporter</span>
                <ChevronDown className="w-[12px] h-[12px] opacity-60" />
            </button>

            {isOpen && (
                <>
                    <div
                        className="fixed inset-0 z-40"
                        onClick={() => setIsOpen(false)}
                    />
                    <div className="absolute right-0 mt-2 w-56 rounded-xl border z-50 overflow-hidden shadow-lg animate-in fade-in slide-in-from-top-2"
                        style={{
                            background: "var(--bg-elevated)",
                            borderColor: "var(--border-strong)"
                        }}
                    >
                        <div className="p-1">
                            <button
                                onClick={handleExportExcel}
                                className="w-full flex items-center gap-3 px-3 py-2 text-sm text-left rounded-lg transition-colors hover:bg-white/5"
                            >
                                <FileSpreadsheet className="w-4 h-4 text-emerald-500" />
                                <div>
                                    <div className="font-semibold text-[var(--text-primary)]">Gamme A vers Excel</div>
                                    <div className="text-[11px] text-[var(--text-muted)] mt-0.5">Gencode, Réf, Libellé...</div>
                                </div>
                            </button>

                            <div className="my-1 h-px bg-[var(--border)] mx-2" />

                            <button
                                onClick={handlePrintPDF}
                                className="w-full flex items-center gap-3 px-3 py-2 text-sm text-left rounded-lg transition-colors hover:bg-white/5"
                            >
                                <FileText className="w-4 h-4 text-rose-500" />
                                <div>
                                    <div className="font-semibold text-[var(--text-primary)]">Tableau en PDF</div>
                                    <div className="text-[11px] text-[var(--text-muted)] mt-0.5">Mise en page épurée (Réf. incluse)</div>
                                </div>
                            </button>
                        </div>
                    </div>
                </>
            )}
        </div>
    );
}
