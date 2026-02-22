"use client";

import { useActionState } from "react";
import { loginAction } from "../api/login-action";
import { Loader2, Lock, User, ShieldCheck } from "lucide-react";

export function LoginForm() {
    const [error, action, isPending] = useActionState(loginAction, undefined);

    return (
        <div className="w-full max-w-md p-8 rounded-[2rem] bg-[var(--bg-surface)] border border-[var(--border)] shadow-lg" style={{ boxShadow: "var(--shadow-md)" }}>
            <div className="flex flex-col items-center mb-10 text-center">
                <div className="w-16 h-16 rounded-2xl bg-[var(--accent-bg)] border border-[var(--accent-border)] flex items-center justify-center mb-6">
                    <ShieldCheck className="w-8 h-8 text-[var(--accent)]" />
                </div>
                <h1 className="text-3xl font-black text-[var(--text-primary)] tracking-tight mb-2">
                    CollectFlow
                </h1>
                <p className="text-[var(--text-secondary)] text-sm font-medium">
                    Connectez-vous pour accéder à votre espace d&apos;arbitrage.
                </p>
            </div>

            <form action={action} className="space-y-6">
                <div className="space-y-2">
                    <label className="text-[10px] font-black uppercase tracking-widest text-[var(--text-muted)] ml-1">
                        Utilisateur
                    </label>
                    <div className="relative group">
                        <User className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)] group-focus-within:text-[var(--accent)] transition-colors" />
                        <input
                            name="username"
                            type="text"
                            required
                            placeholder="admin"
                            className="w-full pl-12 pr-4 py-4 rounded-xl bg-[var(--bg-elevated)] border border-[var(--border)] focus:border-[var(--accent)] outline-none transition-all text-[var(--text-primary)] font-medium"
                        />
                    </div>
                </div>

                <div className="space-y-2">
                    <label className="text-[10px] font-black uppercase tracking-widest text-[var(--text-muted)] ml-1">
                        Mot de passe
                    </label>
                    <div className="relative group">
                        <Lock className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)] group-focus-within:text-[var(--accent)] transition-colors" />
                        <input
                            name="password"
                            type="password"
                            required
                            placeholder="••••••••"
                            className="w-full pl-12 pr-4 py-4 rounded-xl bg-[var(--bg-elevated)] border border-[var(--border)] focus:border-[var(--accent)] outline-none transition-all text-[var(--text-primary)] font-medium"
                        />
                    </div>
                </div>

                {error && (
                    <div className="p-4 rounded-xl bg-[var(--accent-error-bg)] border border-[var(--accent-error)] text-[var(--accent-error)] text-xs font-bold flex items-center gap-3 animate-in fade-in slide-in-from-top-2">
                        <div className="w-1.5 h-1.5 rounded-full bg-[var(--accent-error)] shrink-0" />
                        {error}
                    </div>
                )}

                <button
                    type="submit"
                    disabled={isPending}
                    className="w-full py-4 rounded-xl bg-[var(--accent)] hover:opacity-90 disabled:opacity-50 text-white font-black transition-all active:scale-[0.98] shadow-lg flex items-center justify-center gap-2 group"
                    style={{ background: "var(--accent)" }}
                >
                    {isPending ? (
                        <>
                            <Loader2 className="w-5 h-5 animate-spin" />
                            Connexion...
                        </>
                    ) : (
                        "Se connecter"
                    )}
                </button>
            </form>

            <div className="mt-8 text-center border-t border-[var(--border)] pt-8">
                <p className="text-[10px] text-[var(--text-muted)] uppercase font-black tracking-widest leading-relaxed">
                    Plateforme d&apos;Arbitrage Magasin<br />
                    Propulsée par l&apos;Intelligence Artificielle
                </p>
            </div>
        </div>
    );
}
