"use client";

import React, { useEffect, useState } from "react";
import { CheckCircle2, X } from "lucide-react";

interface SuccessModalProps {
    isOpen: boolean;
    onClose: () => void;
    title: string;
    message: string;
    duration?: number;
}

export function SuccessModal({
    isOpen,
    onClose,
    title,
    message,
    duration = 3000
}: SuccessModalProps) {
    const [isVisible, setIsVisible] = useState(false);

    useEffect(() => {
        if (isOpen) {
            setIsVisible(true);
            const timer = setTimeout(() => handleClose(), duration);
            return () => clearTimeout(timer);
        }
    }, [isOpen, duration]);

    const handleClose = () => {
        setIsVisible(false);
        setTimeout(onClose, 250);
    };

    if (!isOpen && !isVisible) return null;

    return (
        <div
            className={`fixed inset-0 z-[100] flex items-center justify-center p-4 transition-all duration-250 ${isVisible ? "opacity-100 backdrop-blur-sm" : "opacity-0"}`}
        >
            {/* Backdrop */}
            <div
                className="fixed inset-0"
                style={{ background: "rgba(0,0,0,0.45)" }}
                onClick={handleClose}
            />

            {/* Panel */}
            <div
                className={`relative w-full max-w-sm rounded-2xl overflow-hidden shadow-2xl transition-all duration-250 ${isVisible ? "scale-100 translate-y-0" : "scale-95 translate-y-4"}`}
                style={{ background: "var(--bg-surface)", border: "1px solid var(--border)" }}
            >
                {/* Accent bar */}
                <div className="absolute top-0 left-0 w-full h-0.5" style={{ background: "linear-gradient(to right, var(--accent), var(--accent-success))" }} />

                {/* Close button */}
                <button
                    onClick={handleClose}
                    className="absolute top-4 right-4 p-1.5 rounded-lg hover:bg-[var(--bg-elevated)] text-[var(--text-muted)] transition-colors"
                >
                    <X className="w-4 h-4" />
                </button>

                <div className="p-8 flex flex-col items-center text-center">
                    {/* Icon */}
                    <div className="w-16 h-16 rounded-2xl bg-[var(--accent-bg)] border border-[var(--accent-border)] flex items-center justify-center mb-5">
                        <CheckCircle2 className="w-8 h-8 text-[var(--accent)]" />
                    </div>

                    <h3 className="text-lg font-bold text-[var(--text-primary)] mb-2 tracking-tight">
                        {title}
                    </h3>
                    <p className="text-sm text-[var(--text-secondary)] font-medium leading-relaxed">
                        {message}
                    </p>

                    <button
                        onClick={handleClose}
                        className="apple-btn-primary mt-7 w-full justify-center"
                    >
                        Continuer
                    </button>
                </div>
            </div>
        </div>
    );
}
