"use client";

import { useActionState } from "react";
import { loginAction } from "../api/login-action";
import { AlertCircle, Loader2, Lock, ShieldCheck, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/form-controls";

export function LoginForm() {
    const [error, action, isPending] = useActionState(loginAction, undefined);

    return (
        <div className="w-full max-w-sm rounded-2xl border border-[var(--border)] bg-[var(--bg-surface)] p-8 shadow-[var(--shadow-md)]">
            <div className="mb-8 flex flex-col items-center text-center">
                <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl border border-[var(--accent-border)] bg-[var(--accent-bg)]">
                    <ShieldCheck className="h-6 w-6 text-[var(--accent)]" aria-hidden />
                </div>
                <h1 className="text-2xl font-bold tracking-tight text-[var(--text-primary)]">CollectFlow</h1>
                <p className="mt-1 text-sm text-[var(--text-secondary)]">
                    Connectez-vous avec votre identifiant et votre mot de passe.
                </p>
            </div>

            <form action={action} className="space-y-5">
                <div className="space-y-1.5">
                    <label htmlFor="username" className="block text-sm font-medium text-[var(--text-primary)]">
                        Identifiant
                    </label>
                    <div className="relative">
                        <User className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]" aria-hidden />
                        <Input
                            id="username"
                            name="username"
                            type="text"
                            required
                            autoComplete="username"
                            placeholder="Votre identifiant"
                            className="h-11 w-full pl-10"
                        />
                    </div>
                </div>

                <div className="space-y-1.5">
                    <label htmlFor="password" className="block text-sm font-medium text-[var(--text-primary)]">
                        Mot de passe
                    </label>
                    <div className="relative">
                        <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]" aria-hidden />
                        <Input
                            id="password"
                            name="password"
                            type="password"
                            required
                            autoComplete="current-password"
                            placeholder="Votre mot de passe"
                            className="h-11 w-full pl-10"
                        />
                    </div>
                </div>

                {error && (
                    <div
                        role="alert"
                        className="flex items-start gap-2.5 rounded-lg border border-[var(--accent-error)]/40 bg-[var(--accent-error-bg)] px-3 py-2.5 text-sm text-[var(--text-primary)]"
                    >
                        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--accent-error)]" aria-hidden />
                        {error}
                    </div>
                )}

                <Button type="submit" size="lg" disabled={isPending} className="h-11 w-full">
                    {isPending ? (
                        <>
                            <Loader2 className="animate-spin" />
                            Connexion…
                        </>
                    ) : (
                        "Se connecter"
                    )}
                </Button>
            </form>

            <p className="mt-6 border-t border-[var(--border)] pt-5 text-center text-[13px] text-[var(--text-muted)]">
                Révision d&apos;assortiment et suivi des ventes des magasins
            </p>
        </div>
    );
}
