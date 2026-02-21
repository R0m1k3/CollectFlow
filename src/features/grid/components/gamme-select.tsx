"use client";

import { GammeCode } from "@/types/grid";
import { cn } from "@/lib/utils";

interface GammeSelectProps {
    value: GammeCode | null;
    isDraft: boolean;
    onChange: (gamme: GammeCode) => void;
}

const GAMME_STYLES: Record<GammeCode, string> = {
    A: "border-[1px] border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/20 dark:text-emerald-400",
    B: "border-[1px] border-blue-500/30 bg-blue-500/10 text-blue-700 dark:border-blue-500/30 dark:bg-blue-500/20 dark:text-blue-400",
    C: "border-[1px] border-amber-500/30 bg-amber-500/10 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/20 dark:text-amber-400",
    Z: "border-[1px] border-rose-500/30 bg-rose-500/10 text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/20 dark:text-rose-400",
};

export function GammeSelect({ value, isDraft, onChange }: GammeSelectProps) {
    return (
        <select
            value={value ?? ""}
            onChange={(e) => onChange(e.target.value as GammeCode)}
            className={cn(
                "w-full text-xs font-bold rounded-lg py-1.5 px-2 outline-none cursor-pointer shadow-sm transition-all text-center",
                "focus:ring-2 focus:ring-brand-500/20",
                value
                    ? GAMME_STYLES[value]
                    : "border-[1px] border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-500",
                isDraft && "shadow-[0_0_8px_rgba(251,191,36,0.3)] border-amber-400/50"
            )}
        >
            <option value="" disabled>—</option>
            <option value="A">A</option>
            <option value="B">B</option>
            <option value="C">C</option>
            <option value="Z">Z</option>
        </select>
    );
}
