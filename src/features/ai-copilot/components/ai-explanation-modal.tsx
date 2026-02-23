"use client";

import { useEffect, useState } from "react";
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

    useEffect(() => {
        if (isOpen) {
            setIsVisible(true);
        } else {
            setIsVisible(false);
        }
    }, [isOpen]);

    const handleClose = () => {
        setIsVisible(false);
        setTimeout(onClose, 250);
    };

    if (!isOpen && !isVisible) return null;

    const getGammeColor = (g?: string | null) => {
        switch (g) {
            case "A": return "text-emerald-500 border-emerald-500/50 bg-emerald-500/10";
            case "C": return "text-amber-500 border-amber-500/50 bg-amber-500/10";
            case "Z": return "text-rose-500 border-rose-500/50 bg-rose-500/10";
            default: return "text-slate-500 border-slate-500/50 bg-slate-500/10";
        }
    };

    return (
        <div
            className={`fixed inset-0 z-[300] flex items-center justify-center p-4 transition-all duration-250 ${isVisible ? "opacity-100 backdrop-blur-md" : "opacity-0 backdrop-blur-0"}`}
        >
            {/* Backdrop */}
            <div
                className="fixed inset-0"
                style={{ background: "rgba(0,0,0,0.6)" }}
                onClick={handleClose}
            />

            {/* Panel */}
            <div
                className={`relative w-full max-w-lg rounded-3xl overflow-hidden shadow-2xl transition-all duration-250 ${isVisible ? "scale-100 translate-y-0" : "scale-95 translate-y-8"}`}
                style={{
                    background: "var(--bg-surface)",
                    border: "1px solid var(--border-strong)",
                    boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.5)"
                }}
            >
                {/* Header with Mary Icon */}
                <div className="p-6 pb-0 flex items-start justify-between">
                    <div className="flex gap-4">
                        <div className="w-12 h-12 rounded-2xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center shrink-0">
                            <Bot className="w-6 h-6 text-indigo-500" />
                        </div>
                        <div>
                            <h2 className="text-xl font-black tracking-tight" style={{ color: "var(--text-primary)" }}>
                                Analyse de Mary 🧙
                            </h2>
                            <p className="text-xs font-bold opacity-60 uppercase tracking-widest mt-0.5">
                                {productName} <span className="opacity-40">({productCode})</span>
                            </p>
                        </div>
                    </div>
                    <button
                        onClick={handleClose}
                        className="p-2 rounded-xl hover:bg-white/5 text-[var(--text-muted)] transition-colors"
                    >
                        <X className="w-5 h-5" />
                    </button>
                </div>

                {/* Content */}
                <div className="p-6">
                    <div className="space-y-6">
                        {/* Recommandation Badge */}
                        <div className="flex items-center gap-2">
                            <span className="text-[10px] font-black uppercase tracking-widest opacity-40">Verdict :</span>
                            <div className={`px-3 py-1 rounded-full border text-xs font-black flex items-center gap-1.5 ${getGammeColor(recommandation)}`}>
                                {recommandation === "A" && <Sparkles className="w-3 h-3" />}
                                {recommandation === "C" && <TrendingUp className="w-3 h-3" />}
                                {recommandation === "Z" && <ShieldAlert className="w-3 h-3" />}
                                {recommandation ? `GAMME ${recommandation}` : "AUCUN"}
                            </div>
                        </div>

                        {/* Explanation Text */}
                        <div
                            className="text-[14px] leading-relaxed p-5 rounded-2xl border"
                            style={{
                                background: "var(--bg-elevated)",
                                borderColor: "var(--border)",
                                color: "var(--text-secondary)"
                            }}
                        >
                            <div className="flex gap-3">
                                <History className="w-4 h-4 mt-1 text-indigo-400 shrink-0" />
                                <div className="whitespace-pre-wrap font-medium italic italic-custom">
                                    "{explanation}"
                                </div>
                            </div>
                        </div>

                        <div className="flex flex-col gap-2">
                            <div className="h-px w-full bg-gradient-to-r from-transparent via-[var(--border)] to-transparent" />
                            <p className="text-[10px] text-center opacity-40 font-bold italic">
                                Analyse générée en temps réel selon les indicateurs CA, Marge et Régularité.
                            </p>
                        </div>
                    </div>
                </div>

                {/* Footers / Action */}
                <div className="p-6 pt-0">
                    <button
                        onClick={handleClose}
                        className="w-full py-3 rounded-2xl font-black text-sm transition-all hover:scale-[1.02] active:scale-95"
                        style={{
                            background: "var(--bg-elevated)",
                            border: "1px solid var(--border-strong)",
                            color: "var(--text-primary)"
                        }}
                    >
                        Fermer l'Analyse
                    </button>
                </div>
            </div>

            <style jsx>{`
                .italic-custom {
                    font-family: var(--font-serif, serif);
                    font-style: italic;
                }
            `}</style>
        </div>
    );
}
