"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";
import { ChevronDown, Filter } from "lucide-react";

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

    // Valeur composite pour le select : "type:code"
    const currentValue = selected3 ? `code3:${selected3}` :
        selected2 ? `code2:${selected2}` :
            selected1 ? `code1:${selected1}` : "";

    const updateFilter = (value: string) => {
        const params = new URLSearchParams(searchParams.toString());

        // Reset all nomenclature filters
        params.delete("code1");
        params.delete("code2");
        params.delete("code3");

        if (value) {
            const [type, code] = value.split(":");
            params.set(type, code);
        }

        router.push(`/grid?${params.toString()}`);
    };

    // Aplatir la hiérarchie pour le menu unique et trier par code
    const options: { label: string; value: string; level: number; code: string }[] = [];

    // Sort Secteurs
    const sortedSecteurs = Object.entries(hierarchy).sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }));

    sortedSecteurs.forEach(([c1, s]: [string, any]) => {
        options.push({ label: s.label, value: `code1:${c1}`, level: 0, code: c1 });

        // Sort Rayons
        const sortedRayons = Object.entries(s.children).sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }));

        sortedRayons.forEach(([c2, r]: [string, any]) => {
            options.push({ label: r.label, value: `code2:${c2}`, level: 1, code: c2 });

            // Sort Familles
            const sortedFamilles = [...r.children].sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));

            sortedFamilles.forEach((f: any) => {
                options.push({ label: f.label, value: `code3:${f.code}`, level: 2, code: f.code });
            });
        });
    });

    return (
        <div className={cn("relative group", className)}>
            <div className="absolute left-3 top-1/2 -translate-y-1/2 flex items-center gap-2 pointer-events-none">
                <Filter className="h-3.5 w-3.5 opacity-40 group-focus-within:opacity-100 transition-opacity" style={{ color: "var(--text-primary)" }} />
            </div>

            <select
                value={currentValue}
                onChange={(e) => updateFilter(e.target.value)}
                className="apple-input pr-12 appearance-none w-full min-w-[240px]"
                style={{ fontSize: "12px", height: "36px", paddingLeft: "36px" }}
            >
                <option value="">Toute la nomenclature</option>
                {options.map((opt, idx) => (
                    <option
                        key={`${opt.value}-${idx}`}
                        value={opt.value}
                        style={{ paddingLeft: `${opt.level * 12}px` }}
                    >
                        {"\u00A0".repeat(opt.level * 4)}{opt.label}
                    </option>
                ))}
            </select>

            <div className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none opacity-40">
                <ChevronDown className="h-4 w-4" />
            </div>
        </div>
    );
}
