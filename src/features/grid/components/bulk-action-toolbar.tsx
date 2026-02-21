"use client";

import { useGridStore } from "@/features/grid/store/use-grid-store";
import { GammeCode } from "@/types/grid";
import { cn } from "@/lib/utils";

const GAMME_OPTIONS: { label: string; code: GammeCode; color: string }[] = [
    { label: "A — Cœur", code: "A", color: "border-emerald-600 text-emerald-400 hover:bg-emerald-900/20" },
    { label: "B — Complémentaire", code: "B", color: "border-blue-600 text-blue-400 hover:bg-blue-900/20" },
    { label: "C — Saisonnier", code: "C", color: "border-amber-600 text-amber-400 hover:bg-amber-900/20" },
    { label: "Z — Sortie", code: "Z", color: "border-rose-600 text-rose-400 hover:bg-rose-900/20" },
];

interface BulkActionToolbarProps {
    selectedCodeins: string[];
    onClearSelection: () => void;
}

export function BulkActionToolbar({ selectedCodeins, onClearSelection }: BulkActionToolbarProps) {
    const { setDraftGamme } = useGridStore();

    if (selectedCodeins.length === 0) return null;

    const applyBulk = (code: GammeCode) => {
        selectedCodeins.forEach((codein) => setDraftGamme(codein, code));
        onClearSelection();
    };

    return (
        <div className="flex items-center gap-3 px-4 py-2 bg-slate-900 border border-slate-700/50 rounded-xl backdrop-blur-md shadow-2xl animate-in fade-in slide-in-from-top-2 duration-200">
            <span className="text-[11px] font-black uppercase tracking-wider text-slate-200">
                {selectedCodeins.length} sélectionné{selectedCodeins.length > 1 ? "s" : ""}
            </span>
            <div className="h-4 w-px bg-slate-700/50" />
            <span className="text-[11px] font-bold text-slate-400 uppercase tracking-tight">Appliquer en masse :</span>
            {GAMME_OPTIONS.map(({ label, code, color }) => (
                <button
                    key={code}
                    onClick={() => applyBulk(code)}
                    className={cn(
                        "px-3 py-1 text-xs font-bold border rounded transition-colors",
                        color
                    )}
                >
                    {label}
                </button>
            ))}
            <button
                onClick={onClearSelection}
                className="ml-auto text-xs text-slate-500 hover:text-slate-300 transition-colors"
            >
                Annuler
            </button>
        </div>
    );
}
