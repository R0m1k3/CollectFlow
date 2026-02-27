"use client";

import { useEffect, useRef, useState } from "react";
import { X, AlertTriangle } from "lucide-react";

interface ConfirmModalProps {
    isOpen: boolean;
    onClose: () => void;
    onConfirm: () => void;
    title?: string;
    message: string;
    confirmLabel?: string;
    cancelLabel?: string;
    variant?: "danger" | "default";
}

export function ConfirmModal({
    isOpen,
    onClose,
    onConfirm,
    title = "Confirmation",
    message,
    confirmLabel = "OK",
    cancelLabel = "Annuler",
    variant = "default",
}: ConfirmModalProps) {
    const [isVisible, setIsVisible] = useState(false);
    const confirmBtnRef = useRef<HTMLButtonElement>(null);

    useEffect(() => {
        if (isOpen) {
            setIsVisible(true);
            setTimeout(() => confirmBtnRef.current?.focus(), 50);
        } else {
            setIsVisible(false);
        }
    }, [isOpen]);

    const handleClose = () => {
        setIsVisible(false);
        setTimeout(onClose, 250);
    };

    const handleConfirm = () => {
        setIsVisible(false);
        setTimeout(onConfirm, 250);
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === "Escape") handleClose();
        if (e.key === "Enter") handleConfirm();
    };

    if (!isOpen && !isVisible) return null;

    const isDanger = variant === "danger";

    return (
        <div
            className={`fixed inset-0 z-[200] flex items-center justify-center p-4 transition-all duration-250 ${isVisible ? "opacity-100 backdrop-blur-sm" : "opacity-0"}`}
            onKeyDown={handleKeyDown}
        >
            {/* Backdrop */}
            <div
                className="fixed inset-0"
                style={{ background: "rgba(0,0,0,0.55)" }}
                onClick={handleClose}
            />

            {/* Panel */}
            <div
                className={`relative w-full max-w-sm rounded-2xl overflow-hidden shadow-2xl transition-all duration-250 ${isVisible ? "scale-100 translate-y-0" : "scale-95 translate-y-4"}`}
                style={{ background: "var(--bg-surface)", border: "1px solid var(--border)" }}
            >
                {/* Accent bar */}
                <div
                    className="absolute top-0 left-0 w-full h-0.5"
                    style={{
                        background: isDanger
                            ? "linear-gradient(to right, var(--accent-error), #fb7185)"
                            : "linear-gradient(to right, var(--accent), var(--accent-success))"
                    }}
                />

                {/* Close button */}
                <button
                    onClick={handleClose}
                    className="absolute top-4 right-4 p-1.5 rounded-lg hover:bg-[var(--bg-elevated)] text-[var(--text-muted)] transition-colors"
                >
                    <X className="w-4 h-4" />
                </button>

                <div className="p-7">
                    {/* Icon + Title */}
                    <div className="flex items-center gap-3 mb-4">
                        <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${isDanger ? "bg-[var(--accent-error-bg)] border border-[var(--accent-error)]" : "bg-[var(--accent-bg)] border border-[var(--accent-border)]"}`}>
                            <AlertTriangle className={`w-5 h-5 ${isDanger ? "text-[var(--accent-error)]" : "text-[var(--accent)]"}`} />
                        </div>
                        <h3 className="text-base font-bold text-[var(--text-primary)]">{title}</h3>
                    </div>

                    {/* Message */}
                    <p className="text-sm text-[var(--text-secondary)] mb-7 leading-relaxed pl-[52px]">
                        {message}
                    </p>

                    {/* Actions */}
                    <div className="flex gap-3 justify-end">
                        <button
                            onClick={handleClose}
                            className="apple-btn-secondary"
                        >
                            {cancelLabel}
                        </button>
                        <button
                            ref={confirmBtnRef}
                            onClick={handleConfirm}
                            className={isDanger ? "apple-btn-danger" : "apple-btn-primary"}
                        >
                            {confirmLabel}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
