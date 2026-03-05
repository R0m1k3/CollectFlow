"use client";

import { useState } from "react";
import { Download, FileSpreadsheet, FileText, ChevronDown } from "lucide-react";
import * as ExcelJS from "exceljs";
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
        window.print();
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
