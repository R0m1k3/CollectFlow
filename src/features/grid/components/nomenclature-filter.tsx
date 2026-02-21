"use client";

import * as React from "react";
import { ChevronRight, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useRouter, useSearchParams } from "next/navigation";

interface NomenclatureFilterProps {
    hierarchy: any;
    className?: string;
}

export function NomenclatureFilter({ hierarchy, className }: NomenclatureFilterProps) {
    const router = useRouter();
    const searchParams = useSearchParams();

    const selected1 = searchParams.get("code1");
    const selected2 = searchParams.get("code2");
    const selected3 = searchParams.get("code3");

    const updateFilter = (params: Record<string, string | null>) => {
        const nextParams = new URLSearchParams(searchParams.toString());
        Object.entries(params).forEach(([key, value]) => {
            if (value) nextParams.set(key, value);
            else nextParams.delete(key);
        });

        // Reset children if parent changes
        if (params.code1 !== undefined) {
            nextParams.delete("code2");
            nextParams.delete("code3");
        }
        if (params.code2 !== undefined) {
            nextParams.delete("code3");
        }

        router.push(`/grid?${nextParams.toString()}`);
    };

    const l1Options = Object.entries(hierarchy).map(([code, data]: [string, any]) => ({
        code,
        label: data.label
    })).sort((a, b) => a.code.localeCompare(b.code));

    const l2Options = selected1 && hierarchy[selected1]
        ? Object.entries(hierarchy[selected1].children).map(([code, data]: [string, any]) => ({
            code,
            label: data.label
        })).sort((a, b) => a.code.localeCompare(b.code))
        : [];

    const l3Options = selected1 && selected2 && hierarchy[selected1]?.children[selected2]
        ? hierarchy[selected1].children[selected2].children
            .sort((a: any, b: any) => a.code.localeCompare(b.code))
        : [];

    return (
        <div className={cn("flex items-center gap-2", className)}>
            {/* Level 1 */}
            <select
                value={selected1 || ""}
                onChange={(e) => updateFilter({ code1: e.target.value || null })}
                className="apple-input text-[12px] h-8 min-w-[140px]"
                style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)" }}
            >
                <option value="">Tous les Secteurs</option>
                {l1Options.map(opt => (
                    <option key={opt.code} value={opt.code}>{opt.label}</option>
                ))}
            </select>

            <ChevronRight className="w-3 h-3 opacity-30" />

            {/* Level 2 */}
            <select
                value={selected2 || ""}
                onChange={(e) => updateFilter({ code2: e.target.value || null })}
                disabled={!selected1}
                className="apple-input text-[12px] h-8 min-w-[140px] disabled:opacity-50"
                style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)" }}
            >
                <option value="">Tous les Rayons</option>
                {l2Options.map(opt => (
                    <option key={opt.code} value={opt.code}>{opt.label}</option>
                ))}
            </select>

            <ChevronRight className="w-3 h-3 opacity-30" />

            {/* Level 3 */}
            <select
                value={selected3 || ""}
                onChange={(e) => updateFilter({ code3: e.target.value || null })}
                disabled={!selected2}
                className="apple-input text-[12px] h-8 min-w-[140px] disabled:opacity-50"
                style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)" }}
            >
                <option value="">Toutes les Familles</option>
                {l3Options.map((opt: any) => (
                    <option key={opt.code} value={opt.code}>{opt.label}</option>
                ))}
            </select>

            {(selected1 || selected2 || selected3) && (
                <button
                    onClick={() => updateFilter({ code1: null, code2: null, code3: null })}
                    className="p-1.5 hover:bg-rose-500/10 rounded-lg text-rose-500 transition-colors"
                    title="Réinitialiser la nomenclature"
                >
                    <X className="w-4 h-4" />
                </button>
            )}
        </div>
    );
}
