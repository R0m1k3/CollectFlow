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
} from "lucide-react";
import { SuccessModal } from "@/components/shared/success-modal";
import { ConfirmModal } from "@/components/shared/confirm-modal";

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
    const [modal, setModal] = useState<{ isOpen: boolean, title: string, message: string }>({
        isOpen: false,
        title: "",
        message: ""
    });

    const [confirmModal, setConfirmModal] = useState<{
        isOpen: boolean;
        title: string;
        message: string;
        variant?: "danger" | "default";
        onConfirm: () => void;
    }>({ isOpen: false, title: "", message: "", onConfirm: () => { } });

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

    const handleDelete = (id: number) => {
        setConfirmModal({
            isOpen: true,
            title: "Supprimer",
            message: `Supprimer cet ${type === 'export' ? 'export' : 'snapshot'} définitivement ?`,
            variant: "danger",
            onConfirm: async () => {
                setIsDeleting(id);
                try {
                    const res = await deleteSnapshot(id);
                    if (res.success) {
                        setSnapshots(prev => prev.filter(s => s.id !== id));
                        setModal({ isOpen: true, title: "Action Réussie", message: "L'élément a été supprimé de votre historique." });
                    } else {
                        setModal({ isOpen: true, title: "Erreur", message: "Impossible de supprimer l'élément." });
                    }
                } catch (err) {
                    setModal({ isOpen: true, title: "Erreur Technique", message: "Une erreur est survenue lors de la suppression." });
                } finally {
                    setIsDeleting(null);
                }
            },
        });
    };

    const handleLoad = (snapshot: any) => {
        setConfirmModal({
            isOpen: true,
            title: "Restaurer la session",
            message: `Charger la session "${snapshot.label}" ? Cela remplacera vos brouillons actuels.`,
            variant: "default",
            onConfirm: () => {
                const changes: Record<string, string> = {};
                Object.entries(snapshot.changes as any).forEach(([codein, delta]: [string, any]) => {
                    changes[codein] = delta.after;
                });
                restoreSnapshot(changes);
                const query = new URLSearchParams();
                if (snapshot.codeFournisseur) query.set("fournisseur", snapshot.codeFournisseur);
                if (snapshot.magasin) query.set("magasin", snapshot.magasin);
                router.push(`/grid?${query.toString()}`);
            },
        });
    };

    if (loading) {
        return (
            <div className="flex flex-col items-center justify-center p-20 space-y-4">
                <Loader2 className="w-8 h-8 text-[var(--accent)] animate-spin" />
                <p className="text-[var(--text-muted)] text-sm">Récupération de l&apos;historique...</p>
            </div>
        );
    }

    if (snapshots.length === 0) {
        return (
            <div className="border border-dashed border-[var(--border-strong)] rounded-2xl p-16 text-center bg-[var(--bg-elevated)]/30">
                <div className="w-16 h-16 rounded-full bg-[var(--bg-elevated)] flex items-center justify-center mx-auto mb-4 border border-[var(--border)]">
                    <History className="w-8 h-8 text-[var(--text-muted)]" />
                </div>
                <h3 className="text-[var(--text-primary)] font-bold mb-1">
                    {type === "export" ? "Aucun export pour le moment" : "Aucun snapshot pour le moment"}
                </h3>
                <p className="text-[var(--text-secondary)] text-sm max-w-xs mx-auto">
                    {type === "export"
                        ? "Vos exports Excel apparaîtront ici pour historique."
                        : "Capturez l'état de votre travail depuis la grille pour le retrouver ici ultérieurement."}
                </p>
            </div>
        );
    }

    return (
        <div className="grid gap-3">
            {snapshots.map((s) => (
                <div
                    key={s.id}
                    className="group relative flex items-center gap-6 p-5 rounded-xl border transition-all hover:shadow-lg bg-[var(--bg-surface)] border-[var(--border)] hover:border-[var(--accent-border)]"
                >
                    <div className="w-11 h-11 rounded-xl bg-[var(--accent-bg)] border border-[var(--accent-border)] flex items-center justify-center shrink-0">
                        <Store className="w-5 h-5 text-[var(--accent)]" />
                    </div>

                    <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-3 mb-1">
                            <h3 className="text-sm font-bold text-[var(--text-primary)] truncate">{s.label}</h3>
                            <span className="px-2 py-0.5 rounded-full bg-[var(--accent-bg)] border border-[var(--accent-border)] text-[10px] font-black uppercase text-[var(--accent)] tracking-wider">
                                {s.magasin || "Magasin Inconnu"}
                            </span>
                        </div>

                        <div className="flex items-center gap-4 text-[11px] text-[var(--text-muted)] font-medium">
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
                        <div className="hidden xl:flex items-center gap-8 border-l border-[var(--border)] pl-8 mr-4">
                            <div className="flex flex-col">
                                <span className="text-[9px] uppercase font-black text-[var(--text-muted)] tracking-wider">CA</span>
                                <span className="text-xs font-bold text-[var(--accent-success)]">
                                    {(s.summaryJson.totalCa || 0).toLocaleString("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 })}
                                </span>
                            </div>
                            <div className="flex flex-col">
                                <span className="text-[9px] uppercase font-black text-[var(--text-muted)] tracking-wider">Marge</span>
                                <span className="text-xs font-bold text-[var(--text-secondary)]">
                                    {s.summaryJson.tauxMargeGlobal?.toFixed(1)}%
                                </span>
                            </div>
                        </div>
                    )}

                    <div className="flex items-center gap-2">
                        <button
                            onClick={() => handleLoad(s)}
                            className="apple-btn-primary flex items-center gap-2"
                        >
                            Restaurer
                            <ChevronRight className="w-4 h-4" />
                        </button>

                        <button
                            onClick={() => handleDelete(s.id)}
                            disabled={isDeleting === s.id}
                            className="p-2.5 rounded-xl border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--accent-error)] hover:bg-[var(--accent-error-bg)] hover:border-[var(--accent-error)] transition-all active:scale-95"
                            title="Supprimer"
                        >
                            {isDeleting === s.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                        </button>
                    </div>
                </div>
            ))}

            <SuccessModal
                isOpen={modal.isOpen}
                onClose={() => setModal(prev => ({ ...prev, isOpen: false }))}
                title={modal.title}
                message={modal.message}
            />

            <ConfirmModal
                isOpen={confirmModal.isOpen}
                onClose={() => setConfirmModal(prev => ({ ...prev, isOpen: false }))}
                onConfirm={confirmModal.onConfirm}
                title={confirmModal.title}
                message={confirmModal.message}
                variant={confirmModal.variant}
                confirmLabel={confirmModal.variant === "danger" ? "Supprimer" : "Confirmer"}
            />
        </div>
    );
}
