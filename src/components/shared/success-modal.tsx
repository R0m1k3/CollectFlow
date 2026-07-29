"use client";

import React, { useCallback, useEffect, useState } from "react";
import { AlertCircle, CheckCircle2, X } from "lucide-react";

interface SuccessModalProps {
    isOpen: boolean;
    onClose: () => void;
    title: string;
    message: string;
    duration?: number;
    /**
     * `error` change l'icône, l'accent et **désactive la fermeture automatique** :
     * un message d'échec doit rester à l'écran le temps d'être lu, et il ne doit
     * pas s'afficher sous une coche verte de succès.
     */
    variant?: "success" | "error";
    /** Action secondaire optionnelle (ex. « Recharger la page »). */
    action?: { label: string; onClick: () => void };
}

/** Durée de l'animation de sortie, alignée sur les classes `animate-out`. */
const EXIT_MS = 200;

export function SuccessModal({
    isOpen,
    onClose,
    title,
    message,
    duration = 3000,
    variant = "success",
    action,
}: SuccessModalProps) {
    // Seul l'état de SORTIE est porté par un state : l'entrée est jouée par CSS
    // au montage (`animate-in`), ce qui évite un setState synchrone dans l'effet.
    const [closing, setClosing] = useState(false);
    const isError = variant === "error";

    const handleClose = useCallback(() => {
        setClosing(true);
        setTimeout(() => {
            setClosing(false);
            onClose();
        }, EXIT_MS);
    }, [onClose]);

    useEffect(() => {
        // Une erreur ne disparaît pas toute seule : l'utilisateur la ferme.
        if (!isOpen || isError) return;
        const timer = setTimeout(() => handleClose(), duration);
        return () => clearTimeout(timer);
    }, [isOpen, duration, isError, handleClose]);

    if (!isOpen) return null;

    const state = closing ? "closed" : "open";
    const Icon = isError ? AlertCircle : CheckCircle2;

    return (
        <div
            data-state={state}
            className="fixed inset-0 z-[100] flex items-center justify-center p-4 backdrop-blur-sm duration-200 data-[state=open]:animate-in data-[state=open]:fade-in data-[state=closed]:animate-out data-[state=closed]:fade-out"
        >
            {/* Backdrop */}
            <div
                className="fixed inset-0"
                style={{ background: "rgba(0,0,0,0.45)" }}
                onClick={handleClose}
            />

            {/* Panel */}
            <div
                data-state={state}
                className="relative w-full max-w-sm rounded-2xl overflow-hidden shadow-2xl duration-200 data-[state=open]:animate-in data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:zoom-out-95"
                style={{ background: "var(--bg-surface)", border: "1px solid var(--border)" }}
            >
                {/* Accent bar */}
                <div
                    className="absolute top-0 left-0 w-full h-0.5"
                    style={{
                        background: isError
                            ? "var(--accent-error)"
                            : "linear-gradient(to right, var(--accent), var(--accent-success))",
                    }}
                />

                {/* Close button */}
                <button
                    onClick={handleClose}
                    className="absolute top-4 right-4 p-1.5 rounded-lg hover:bg-[var(--bg-elevated)] text-[var(--text-muted)] transition-colors"
                >
                    <X className="w-4 h-4" />
                </button>

                <div className="p-8 flex flex-col items-center text-center">
                    {/* Icon */}
                    <div
                        className="w-16 h-16 rounded-2xl flex items-center justify-center mb-5"
                        style={
                            isError
                                ? { background: "var(--accent-error-bg)", border: "1px solid var(--accent-error)" }
                                : { background: "var(--accent-bg)", border: "1px solid var(--accent-border)" }
                        }
                    >
                        <Icon className="w-8 h-8" style={{ color: isError ? "var(--accent-error)" : "var(--accent)" }} />
                    </div>

                    <h3 className="text-lg font-bold text-[var(--text-primary)] mb-2 tracking-tight">
                        {title}
                    </h3>
                    <p className="text-sm text-[var(--text-secondary)] font-medium leading-relaxed">
                        {message}
                    </p>

                    {action && (
                        <button onClick={action.onClick} className="apple-btn-primary mt-7 w-full justify-center">
                            {action.label}
                        </button>
                    )}
                    <button
                        onClick={handleClose}
                        className={`${action ? "apple-btn-secondary mt-2" : "apple-btn-primary mt-7"} w-full justify-center`}
                    >
                        {action ? "Plus tard" : "Continuer"}
                    </button>
                </div>
            </div>
        </div>
    );
}
