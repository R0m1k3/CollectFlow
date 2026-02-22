"use client";

import { useState, useEffect, useRef } from "react";
import { X, KeyRound, Eye, EyeOff, Loader2, ShieldCheck } from "lucide-react";

interface ChangePasswordModalProps {
    isOpen: boolean;
    onClose: () => void;
    onConfirm: (newPassword: string) => Promise<void>;
    username: string;
}

export function ChangePasswordModal({
    isOpen,
    onClose,
    onConfirm,
    username,
}: ChangePasswordModalProps) {
    const [password, setPassword] = useState("");
    const [confirm, setConfirm] = useState("");
    const [showPassword, setShowPassword] = useState(false);
    const [showConfirm, setShowConfirm] = useState(false);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [isVisible, setIsVisible] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (isOpen) {
            setIsVisible(true);
            setPassword("");
            setConfirm("");
            setError(null);
            setTimeout(() => inputRef.current?.focus(), 50);
        } else {
            setIsVisible(false);
        }
    }, [isOpen]);

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === "Escape") handleClose();
    };

    const handleClose = () => {
        setIsVisible(false);
        setTimeout(onClose, 250);
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError(null);

        if (password.length < 4) {
            setError("Le mot de passe doit faire au moins 4 caractères.");
            return;
        }
        if (password !== confirm) {
            setError("Les mots de passe ne correspondent pas.");
            return;
        }

        setIsLoading(true);
        try {
            await onConfirm(password);
            handleClose();
        } catch (err: any) {
            setError(err?.message ?? "Une erreur est survenue.");
        } finally {
            setIsLoading(false);
        }
    };

    if (!isOpen && !isVisible) return null;

    return (
        <div
            className={`fixed inset-0 z-[100] flex items-center justify-center p-4 transition-all duration-250 ${isVisible ? "opacity-100 backdrop-blur-sm" : "opacity-0"}`}
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
                <div className="absolute top-0 left-0 w-full h-0.5 bg-gradient-to-r from-teal-400 to-emerald-400" />

                {/* Close button */}
                <button
                    onClick={handleClose}
                    className="absolute top-4 right-4 p-1.5 rounded-lg hover:bg-[var(--bg-elevated)] text-[var(--text-muted)] transition-colors"
                >
                    <X className="w-4 h-4" />
                </button>

                <div className="p-7">
                    {/* Header */}
                    <div className="flex items-center gap-4 mb-7">
                        <div className="w-11 h-11 rounded-xl bg-[var(--accent-bg)] border border-[var(--accent-border)] flex items-center justify-center shrink-0">
                            <KeyRound className="w-5 h-5 text-[var(--accent)]" />
                        </div>
                        <div>
                            <h3 className="text-base font-bold text-[var(--text-primary)]">Changer le mot de passe</h3>
                            <p className="text-xs text-[var(--text-muted)]">Compte : <span className="font-semibold text-[var(--text-secondary)]">{username}</span></p>
                        </div>
                    </div>

                    <form onSubmit={handleSubmit} className="space-y-4">
                        {/* New password */}
                        <div className="space-y-1.5">
                            <label className="text-[10px] font-black uppercase tracking-widest text-[var(--text-muted)]">
                                Nouveau mot de passe
                            </label>
                            <div className="relative">
                                <input
                                    ref={inputRef}
                                    type={showPassword ? "text" : "password"}
                                    value={password}
                                    onChange={(e) => setPassword(e.target.value)}
                                    placeholder="Min. 4 caractères"
                                    className="apple-input pr-10"
                                    required
                                />
                                <button
                                    type="button"
                                    onClick={() => setShowPassword(v => !v)}
                                    className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors"
                                >
                                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                                </button>
                            </div>
                        </div>

                        {/* Confirm */}
                        <div className="space-y-1.5">
                            <label className="text-[10px] font-black uppercase tracking-widest text-[var(--text-muted)]">
                                Confirmer le mot de passe
                            </label>
                            <div className="relative">
                                <input
                                    type={showConfirm ? "text" : "password"}
                                    value={confirm}
                                    onChange={(e) => setConfirm(e.target.value)}
                                    placeholder="Répétez le mot de passe"
                                    className="apple-input pr-10"
                                    required
                                />
                                <button
                                    type="button"
                                    onClick={() => setShowConfirm(v => !v)}
                                    className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors"
                                >
                                    {showConfirm ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                                </button>
                            </div>
                        </div>

                        {/* Password match indicator */}
                        {confirm.length > 0 && (
                            <div className={`flex items-center gap-2 text-xs font-semibold ${password === confirm ? "text-[var(--accent-success)]" : "text-[var(--accent-error)]"}`}>
                                <ShieldCheck className="w-3.5 h-3.5" />
                                {password === confirm ? "Les mots de passe correspondent" : "Les mots de passe ne correspondent pas"}
                            </div>
                        )}

                        {/* Error */}
                        {error && (
                            <div className="px-3 py-2.5 rounded-lg bg-[var(--accent-error-bg)] border border-[var(--accent-error)] text-[var(--accent-error)] text-xs font-semibold">
                                {error}
                            </div>
                        )}

                        {/* Actions */}
                        <div className="flex gap-3 pt-2">
                            <button
                                type="button"
                                onClick={handleClose}
                                className="apple-btn-secondary flex-1 justify-center"
                            >
                                Annuler
                            </button>
                            <button
                                type="submit"
                                disabled={isLoading || password !== confirm || password.length < 4}
                                className="apple-btn-primary flex-1 justify-center disabled:opacity-40"
                            >
                                {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <KeyRound className="w-4 h-4" />}
                                {isLoading ? "Mise à jour..." : "Valider"}
                            </button>
                        </div>
                    </form>
                </div>
            </div>
        </div>
    );
}
