"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X, Bot, Sparkles, TrendingUp, ShieldAlert, History } from "lucide-react";

interface AiExplanationModalProps {
    isOpen: boolean;
    onClose: () => void;
    productName: string;
    productCode: string;
    explanation: string;
    recommandation?: "A" | "C" | "Z" | null;
}

export function AiExplanationModal({
    isOpen,
    onClose,
    productName,
    productCode,
    explanation,
    recommandation
}: AiExplanationModalProps) {
    const [isVisible, setIsVisible] = useState(false);
    const [mounted, setMounted] = useState(false);

    useEffect(() => {
        setMounted(true);
        if (isOpen) {
            setIsVisible(true);
        } else {
            setIsVisible(false);
        }
    }, [isOpen]);

    const handleClose = () => {
        setIsVisible(false);
        setTimeout(onClose, 200);
    };

    if (!isOpen && !isVisible) return null;
    if (!mounted) return null;

    const getGammeStyles = (g?: string | null) => {
        switch (g) {
            case "A": return "text-[var(--accent-success)] border-[var(--accent-success-bg)] bg-[var(--accent-success-bg)]";
            case "C": return "text-[var(--accent-warning)] border-[var(--accent-warning-bg)] bg-[var(--accent-warning-bg)]";
            case "Z": return "text-[var(--accent-error)] border-[var(--accent-error-bg)] bg-[var(--accent-error-bg)]";
            default: return "text-[var(--text-muted)] border-[var(--border)] bg-[var(--bg-elevated)]";
        }
    };

    const modalContent = (
        <div
            className={`fixed inset-0 z-[9999] flex items-center justify-center p-6 transition-all duration-200 ${isVisible ? "opacity-100 backdrop-blur-sm" : "opacity-0 backdrop-blur-0"}`}
        >
            {/* Backdrop - consistent with Apple overlay */}
            <div
                className="fixed inset-0 bg-black/40"
                onClick={handleClose}
            />

            {/* Panel - Using var(--bg-surface) and strict spacing */}
            <div
                className={`relative w-full max-w-xl rounded-2xl overflow-hidden shadow-2xl border border-[var(--border-strong)] transition-all duration-200 ${isVisible ? "scale-100 translate-y-0" : "scale-[0.98] translate-y-4"}`}
                style={{
                    background: "var(--bg-surface)",
                }}
            >
                {/* Header - Clean & Monochromatic */}
                <div className="px-6 py-5 border-b border-[var(--border)] flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-lg bg-[var(--bg-elevated)] border border-[var(--border)] flex items-center justify-center shrink-0">
                            <Bot className="w-5 h-5 text-[var(--text-secondary)]" />
                        </div>
                        <div>
                            <h2 className="text-sm font-bold tracking-tight text-[var(--text-primary)]">
                                Analyse Décisionnelle IA
                            </h2>
                            <p className="text-[11px] font-medium text-[var(--text-muted)] truncate max-w-[300px]">
                                {productName} <span className="opacity-60 tabular-numbers">({productCode})</span>
                            </p>
                        </div>
                    </div>
                    <button
                        onClick={handleClose}
                        className="p-1.5 rounded-md hover:bg-[var(--bg-elevated)] text-[var(--text-muted)] transition-colors"
                    >
                        <X className="w-4 h-4" />
                    </button>
                </div>

                {/* Body */}
                <div className="p-6 space-y-6">
                    {/* Recommendation Row */}
                    <div className="flex items-center justify-between px-1">
                        <span className="text-[11px] font-bold uppercase tracking-wider text-[var(--text-muted)]">Arbitrage suggéré</span>
                        <div className={`px-2.5 py-1 rounded-md border text-[11px] font-bold flex items-center gap-1.5 ${getGammeStyles(recommandation)}`}>
                            {recommandation === "A" && <Sparkles className="w-3 h-3" />}
                            {recommandation === "C" && <TrendingUp className="w-3 h-3" />}
                            {recommandation === "Z" && <ShieldAlert className="w-3 h-3" />}
                            {recommandation ? `GAMME ${recommandation}` : "NON DÉFINI"}
                        </div>
                    </div>

                    {/* Explanation Box - Monospace for figures */}
                    <div
                        className="p-5 rounded-xl border border-[var(--border)] bg-[var(--bg-base)]/50 relative overflow-hidden"
                    >
                        <div className="flex gap-4">
                            <History className="w-4 h-4 mt-0.5 text-[var(--accent)] shrink-0 opacity-80" />
                            <div className="text-[13px] leading-relaxed text-[var(--text-secondary)] font-medium">
                                <span className="font-mono-nums leading-relaxed whitespace-pre-wrap">
                                    {explanation}
                                </span>
                            </div>
                        </div>
                    </div>

                    {/* Meta Info */}
                    <div className="flex items-center justify-center gap-4 py-2 border-t border-[var(--border)]">
                        <div className="flex items-center gap-2 text-[10px] text-[var(--text-muted)] font-medium italic">
                            <span>Basé sur CA, Marge & Volumes réels</span>
                        </div>
                    </div>
                </div>

                {/* Footer Action */}
                <div className="px-6 py-4 bg-[var(--bg-elevated)]/50 border-t border-[var(--border)] flex justify-end">
                    <button
                        onClick={handleClose}
                        className="apple-btn-secondary px-6"
                    >
                        Fermer l'Analyse
                    </button>
                </div>
            </div>

            <style jsx>{`
                .font-mono-nums {
                    font-family: inherit;
                    font-variant-numeric: tabular-nums;
                }
            `}</style>
        </div>
    );

    return createPortal(modalContent, document.body);
}
