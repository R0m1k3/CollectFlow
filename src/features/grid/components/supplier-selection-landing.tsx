"use client";

import * as React from "react";
import { LayoutGrid } from "lucide-react";
import { useRouter } from "next/navigation";
import { SupplierCombobox } from "./supplier-combobox";
import { GAMMES } from "@/lib/gammes";
import { cn } from "@/lib/utils";

interface Supplier {
    code: string;
    nom: string;
}

interface SupplierSelectionLandingProps {
    fournisseurs: Supplier[];
}

/** Entrée de la Grille : une seule question, « quel fournisseur ? ». */
export function SupplierSelectionLanding({ fournisseurs }: SupplierSelectionLandingProps) {
    const router = useRouter();

    const handleSelect = (code: string) => {
        router.push(`/grid?fournisseur=${encodeURIComponent(code)}`);
    };

    return (
        <div className="flex h-full flex-col items-center justify-center p-6 text-center">
            <div className="w-full max-w-xl space-y-6">
                <div className="space-y-3">
                    <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border border-[var(--accent-border)] bg-[var(--accent-bg)] text-[var(--accent)]">
                        <LayoutGrid className="h-7 w-7" />
                    </div>
                    <h1 className="text-3xl font-bold tracking-tight text-[var(--text-primary)]">Révision d&apos;assortiment</h1>
                    <p className="text-base text-[var(--text-secondary)]">
                        Choisissez un fournisseur : vous verrez tous ses produits avec leurs ventes, et vous pourrez
                        attribuer à chacun sa gamme.
                    </p>
                </div>
                <div className="flex justify-center">
                    <SupplierCombobox
                        fournisseurs={fournisseurs}
                        selectedCode={null}
                        onSelect={handleSelect}
                        className="w-full max-w-md"
                    />
                </div>
                <p className="text-[13px] text-[var(--text-muted)]">
                    {fournisseurs.length.toLocaleString("fr-FR")} fournisseurs disponibles
                </p>
                <div className="flex flex-wrap justify-center gap-2 pt-2" aria-label="Signification des gammes">
                    {GAMMES.map((g) => (
                        <span
                            key={g.code}
                            title={g.description}
                            className={cn("inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[13px]", g.classes)}
                        >
                            <span className="font-bold">{g.code}</span> {g.nom}
                        </span>
                    ))}
                </div>
            </div>
        </div>
    );
}
