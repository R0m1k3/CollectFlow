"use client";

import * as React from "react";
import { SupplierCombobox } from "./supplier-combobox";
import { useRouter } from "next/navigation";

interface Supplier {
    code: string;
    nom: string;
}

interface SupplierSelectionLandingProps {
    fournisseurs: Supplier[];
}

export function SupplierSelectionLanding({ fournisseurs }: SupplierSelectionLandingProps) {
    const router = useRouter();

    const handleSelect = (code: string) => {
        router.push(`/grid?fournisseur=${code}`);
    };

    return (
        <div className="h-full flex flex-col items-center justify-center p-6 text-center animate-in fade-in zoom-in duration-500">
            <div className="max-w-md space-y-6">
                <div className="space-y-4">
                    <div className="w-16 h-16 bg-emerald-500/10 rounded-2xl flex items-center justify-center mx-auto mb-2 text-emerald-600">
                        <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 002 2h2a2 2 0 002-2" />
                        </svg>
                    </div>
                    <h1 className="text-4xl font-black tracking-tight text-slate-900 dark:text-white">CollectFlow</h1>
                    <p className="text-lg text-slate-500 dark:text-slate-400">
                        Optimisez votre assortiment en quelques clics. Sélectionnez un fournisseur pour commencer.
                    </p>
                </div>
                <div className="flex justify-center pt-4">
                    <SupplierCombobox
                        fournisseurs={fournisseurs}
                        selectedCode={null}
                        onSelect={handleSelect}
                        className="w-[400px] !h-12 text-lg shadow-xl"
                    />
                </div>
                <div className="pt-8 text-[11px] text-slate-400 uppercase tracking-[0.2em] font-bold">
                    Accès Rapide • {fournisseurs.length} Fournisseurs Disponibles
                </div>
            </div>
        </div>
    );
}
