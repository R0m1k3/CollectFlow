"use client";

import { GammeCode } from "@/types/grid";
import { cn } from "@/lib/utils";

interface GammeSelectProps {
    value: GammeCode | null;
    isDraft: boolean;
    onChange: (gamme: GammeCode) => void;
}

const GAMME_STYLES: Record<GammeCode, string> = {
    A: "border-[2px] border-emerald-500 bg-emerald-50 text-emerald-900 dark:border-emerald-400 dark:bg-emerald-900/40 dark:text-emerald-100",
    B: "border-[2px] border-blue-500 bg-blue-50 text-blue-900 dark:border-blue-400 dark:bg-blue-900/40 dark:text-blue-100",
    C: "border-[2px] border-amber-500 bg-amber-50 text-amber-900 dark:border-amber-400 dark:bg-amber-900/40 dark:text-amber-100",
    Z: "border-[2px] border-rose-600 bg-rose-50 text-rose-900 dark:border-rose-500 dark:bg-rose-900/50 dark:text-rose-100",
};

export function GammeSelect({ value, isDraft, onChange }: GammeSelectProps) {
    return (
        <select
            value={value ?? ""}
            onChange={(e) => onChange(e.target.value as GammeCode)}
            className={cn(
                "w-full text-xs font-black rounded-lg py-2 px-2 outline-none cursor-pointer shadow-sm transition-all text-center",
                "focus:ring-2 focus:ring-brand-500/20",
                value
                    ? GAMME_STYLES[value]
                    : "border-2 border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-500",
                isDraft && "shadow-[0_0_10px_rgba(251,191,36,0.5)] border-amber-400"
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
