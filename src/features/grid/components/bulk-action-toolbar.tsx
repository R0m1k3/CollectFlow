"use client";

import { useGridStore } from "@/features/grid/store/use-grid-store";
import { GammeCode } from "@/types/grid";
import { cn } from "@/lib/utils";
import { GAMMES } from "@/lib/gammes";
import { Button } from "@/components/ui/button";



interface BulkActionToolbarProps {
    selectedCodeins: string[];
    onClearSelection: () => void;
}

export function BulkActionToolbar({ selectedCodeins, onClearSelection }: BulkActionToolbarProps) {
    const batchSetDraftGamme = useGridStore((s) => s.batchSetDraftGamme);

    if (selectedCodeins.length === 0) return null;

    const applyBulk = (code: GammeCode) => {
        const changes = selectedCodeins.reduce((acc, codein) => {
            acc[codein] = code;
            return acc;
        }, {} as Record<string, GammeCode>);
        batchSetDraftGamme(changes);
        onClearSelection();
    };

    return (
        <div
            role="region"
            aria-label="Actions sur la sélection"
            className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border px-4 py-2 border-[var(--accent-border)] bg-[var(--accent-bg)] animate-in fade-in slide-in-from-top-2 duration-200"
        >
            <span className="text-sm font-semibold text-[var(--text-primary)]">
                {selectedCodeins.length} produit{selectedCodeins.length > 1 ? "s" : ""} sélectionné{selectedCodeins.length > 1 ? "s" : ""}
            </span>
            <span className="text-[13px] text-[var(--text-secondary)]">— leur donner la gamme :</span>
            {GAMMES.map((g) => (
                <button
                    key={g.code}
                    onClick={() => applyBulk(g.code as GammeCode)}
                    title={g.description}
                    className={cn("rounded-md border px-3 py-1 text-[13px] font-semibold transition-opacity hover:opacity-80", g.classes)}
                >
                    {g.code} — {g.nom}
                </button>
            ))}
            <Button variant="ghost" size="sm" onClick={onClearSelection} className="ml-auto">
                Annuler la sélection
            </Button>
        </div>
    );
}
