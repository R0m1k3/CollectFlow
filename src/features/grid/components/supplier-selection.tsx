"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Search, Building2, ChevronRight } from "lucide-react";

interface Supplier {
    code: string;
    nom: string;
}

export function SupplierSelection({ fournisseurs }: { fournisseurs: Supplier[] }) {
    const router = useRouter();
    const [search, setSearch] = useState("");

    const filtered = fournisseurs.filter((f) =>
        f.nom.toLowerCase().includes(search.toLowerCase()) ||
        f.code.toLowerCase().includes(search.toLowerCase())
    );

    return (
        <div className="max-w-4xl mx-auto py-12 px-6">
            <div className="mb-10 text-center">
                <h1 className="text-[32px] font-bold tracking-tight mb-2">Choisir un fournisseur</h1>
                <p className="text-[15px]" style={{ color: "var(--text-secondary)" }}>
                    Sélectionnez un fournisseur pour commencer la révision de l&apos;assortiment.
                </p>
            </div>

            <div className="relative mb-8 max-w-xl mx-auto">
                <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
                <input
                    type="text"
                    placeholder="Rechercher par nom ou code..."
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="apple-input pl-12 h-14 text-lg w-full"
                />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {filtered.map((f) => (
                    <button
                        key={f.code}
                        onClick={() => router.push(`/grid?fournisseur=${f.code}`)}
                        className="flex items-center justify-between p-5 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:border-emerald-500/50 hover:bg-emerald-50/10 transition-all text-left shadow-sm group active:scale-[0.98]"
                    >
                        <div className="flex items-center gap-4">
                            <div className="w-12 h-12 rounded-xl bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-slate-500 group-hover:bg-emerald-500/10 group-hover:text-emerald-500 transition-colors">
                                <Building2 className="w-6 h-6" />
                            </div>
                            <div>
                                <div className="text-[17px] font-bold tracking-tight text-slate-900 dark:text-white">
                                    {f.nom}
                                </div>
                                <div className="text-[13px] font-medium text-slate-500">
                                    Code: {f.code}
                                </div>
                            </div>
                        </div>
                        <ChevronRight className="w-5 h-5 text-slate-300 group-hover:text-emerald-500 transition-colors" />
                    </button>
                ))}
            </div>

            {filtered.length === 0 && (
                <div className="text-center py-20 bg-slate-50/50 dark:bg-slate-900/50 rounded-3xl border border-dashed border-slate-200 dark:border-slate-800">
                    <p className="text-slate-500 font-medium">Aucun fournisseur trouvé pour &quot;{search}&quot;</p>
                </div>
            )}
        </div>
    );
}
