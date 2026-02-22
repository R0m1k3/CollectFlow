"use client";

import React, { useState, useEffect } from "react";
import { getSnapshots } from "../api/get-snapshots";
import { deleteSnapshot } from "../api/delete-snapshot";
import { useGridStore } from "@/features/grid/store/use-grid-store";
import { useRouter } from "next/navigation";
import {
    Trash2,
    UploadCloud,
    Calendar,
    Store,
    History,
    ChevronRight,
    Loader2,
    AlertCircle
} from "lucide-react";

const formatDate = (date: Date) => {
    return new Intl.DateTimeFormat("fr-FR", {
        day: "numeric",
        month: "long",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit"
    }).format(date);
};

interface SnapshotListProps {
    type?: "snapshot" | "export";
}

export function SnapshotList({ type }: SnapshotListProps) {
    const [snapshots, setSnapshots] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [isDeleting, setIsDeleting] = useState<number | null>(null);

    const restoreSnapshot = useGridStore(state => state.restoreSnapshot);
    const router = useRouter();

    const fetchSnapshots = async () => {
        setLoading(true);
        try {
            const data = await getSnapshots(type);
            setSnapshots(data);
        } catch (err) {
            setError("Impossible de charger les données.");
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchSnapshots();
    }, [type]);

    const handleDelete = async (id: number) => {
        if (!window.confirm(`Supprimer cet ${type === 'export' ? 'export' : 'snapshot'} définitivement ?`)) return;
        setIsDeleting(id);
        try {
            const res = await deleteSnapshot(id);
            if (res.success) {
                setSnapshots(prev => prev.filter(s => s.id !== id));
            } else {
                alert("Erreur lors de la suppression.");
            }
        } catch (err) {
            alert("Erreur technique lors de la suppression.");
        } finally {
            setIsDeleting(null);
        }
    };

    const handleLoad = (snapshot: any) => {
        if (!window.confirm(`Charger la session "${snapshot.label}" ? Cela remplacera vos brouillons actuels.`)) return;

        // Les changements sont stockés sous forme d'objet { codein: { before, after } }
        // On doit re-transformer en Record<string, GammeCode>
        const changes: Record<string, string> = {};
        Object.entries(snapshot.changes as any).forEach(([codein, delta]: [string, any]) => {
            changes[codein] = delta.after;
        });

        restoreSnapshot(changes);

        // Redirection vers la grille avec les filtres du snapshot
        const query = new URLSearchParams();
        if (snapshot.codeFournisseur) query.set("fournisseur", snapshot.codeFournisseur);
        if (snapshot.magasin) query.set("magasin", snapshot.magasin);

        router.push(`/grid?${query.toString()}`);
    };

    if (loading) {
        return (
            <div className="flex flex-col items-center justify-center p-20 space-y-4">
                <Loader2 className="w-8 h-8 text-indigo-500 animate-spin" />
                <p className="text-slate-400 text-sm">Récupération de l&apos;historique...</p>
            </div>
        );
    }

    if (snapshots.length === 0) {
        return (
            <div className="border border-dashed border-slate-700 rounded-2xl p-16 text-center bg-slate-800/20">
                <div className="w-16 h-16 rounded-full bg-slate-800 flex items-center justify-center mx-auto mb-4 border border-slate-700">
                    <History className="w-8 h-8 text-slate-500" />
                </div>
                <h3 className="text-slate-200 font-bold mb-1">
                    {type === "export" ? "Aucun export pour le moment" : "Aucun snapshot pour le moment"}
                </h3>
                <p className="text-slate-500 text-sm max-w-xs mx-auto">
                    {type === "export"
                        ? "Vos exports Excel apparaîtront ici pour historique."
                        : "Capturez l'état de votre travail depuis la grille pour le retrouver ici ultérieurement."}
                </p>
            </div>
        );
    }

    return (
        <div className="grid gap-4">
            {snapshots.map((s) => (
                <div
                    key={s.id}
                    className="group relative flex items-center gap-6 p-5 rounded-2xl border transition-all hover:shadow-xl bg-slate-800/40 border-slate-700/50 hover:border-indigo-500/50 hover:bg-slate-800/60"
                >
                    <div className="w-12 h-12 rounded-xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center shrink-0">
                        <Store className="w-6 h-6 text-indigo-400" />
                    </div>

                    <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-3 mb-1">
                            <h3 className="text-sm font-bold text-slate-100 truncate">{s.label}</h3>
                            <span className="px-2 py-0.5 rounded-full bg-indigo-500/10 border border-indigo-500/20 text-[10px] font-black uppercase text-indigo-400 tracking-wider">
                                {s.magasin || "Magasin Inconnu"}
                            </span>
                        </div>

                        <div className="flex items-center gap-4 text-[11px] text-slate-400 font-medium">
                            <span className="flex items-center gap-1.5">
                                <Calendar className="w-3.5 h-3.5 opacity-60" />
                                {formatDate(new Date(s.createdAt))}
                            </span>
                            <span className="flex items-center gap-1.5">
                                <UploadCloud className="w-3.5 h-3.5 opacity-60" />
                                {Object.keys(s.changes as any).length} modifications enregistrées
                            </span>
                        </div>
                    </div>

                    {s.summaryJson && (
                        <div className="hidden xl:flex items-center gap-8 border-l border-slate-700/50 pl-8 mr-4">
                            <div className="flex flex-col">
                                <span className="text-[9px] uppercase font-black text-slate-500 tracking-wider">CA</span>
                                <span className="text-xs font-bold text-emerald-400">
                                    {(s.summaryJson.totalCa || 0).toLocaleString("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 })}
                                </span>
                            </div>
                            <div className="flex flex-col">
                                <span className="text-[9px] uppercase font-black text-slate-500 tracking-wider">Marge</span>
                                <span className="text-xs font-bold text-slate-200">
                                    {s.summaryJson.tauxMargeGlobal?.toFixed(1)}%
                                </span>
                            </div>
                        </div>
                    )}

                    <div className="flex items-center gap-2">
                        <button
                            onClick={() => handleLoad(s)}
                            className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-[12px] font-black transition-all active:scale-95 shadow-lg shadow-indigo-900/20"
                        >
                            Restaurer
                            <ChevronRight className="w-4 h-4" />
                        </button>

                        <button
                            onClick={() => handleDelete(s.id)}
                            disabled={isDeleting === s.id}
                            className="p-2.5 rounded-xl border border-slate-700 text-slate-500 hover:text-rose-500 hover:bg-rose-500/10 hover:border-rose-500/30 transition-all active:scale-95"
                            title="Supprimer"
                        >
                            {isDeleting === s.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                        </button>
                    </div>
                </div>
            ))}
        </div>
    );
}
