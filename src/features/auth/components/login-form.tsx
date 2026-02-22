"use client";

import { useActionState } from "react";
import { loginAction } from "../api/login-action";
import { Loader2, Lock, User, ShieldCheck } from "lucide-react";

export function LoginForm() {
    const [error, action, isPending] = useActionState(loginAction, undefined);

    return (
        <div className="w-full max-w-md p-8 rounded-[2.5rem] bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-2xl shadow-slate-200/10 dark:shadow-none">
            <div className="flex flex-col items-center mb-10 text-center">
                <div className="w-16 h-16 rounded-2xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center mb-6">
                    <ShieldCheck className="w-8 h-8 text-indigo-500" />
                </div>
                <h1 className="text-3xl font-black text-slate-900 dark:text-white tracking-tight mb-2">
                    CollectFlow
                </h1>
                <p className="text-slate-500 dark:text-slate-400 text-sm font-medium">
                    Connectez-vous pour accéder à votre espace d&apos;arbitrage.
                </p>
            </div>

            <form action={action} className="space-y-6">
                <div className="space-y-2">
                    <label className="text-xs font-black uppercase tracking-widest text-slate-400 ml-1">
                        Utilisateur
                    </label>
                    <div className="relative group">
                        <User className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 group-focus-within:text-indigo-500 transition-colors" />
                        <input
                            name="username"
                            type="text"
                            required
                            placeholder="admin"
                            className="w-full pl-12 pr-4 py-4 rounded-2xl bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-800 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 outline-none transition-all text-slate-900 dark:text-white font-medium"
                        />
                    </div>
                </div>

                <div className="space-y-2">
                    <label className="text-xs font-black uppercase tracking-widest text-slate-400 ml-1">
                        Mot de passe
                    </label>
                    <div className="relative group">
                        <Lock className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 group-focus-within:text-indigo-500 transition-colors" />
                        <input
                            name="password"
                            type="password"
                            required
                            placeholder="••••••••"
                            className="w-full pl-12 pr-4 py-4 rounded-2xl bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-800 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 outline-none transition-all text-slate-900 dark:text-white font-medium"
                        />
                    </div>
                </div>

                {error && (
                    <div className="p-4 rounded-2xl bg-rose-500/10 border border-rose-500/20 text-rose-500 text-xs font-bold flex items-center gap-3 animate-in fade-in slide-in-from-top-2">
                        <div className="w-1.5 h-1.5 rounded-full bg-rose-500 shrink-0" />
                        {error}
                    </div>
                )}

                <button
                    type="submit"
                    disabled={isPending}
                    className="w-full py-4 rounded-2xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-black transition-all active:scale-[0.98] shadow-lg shadow-indigo-600/20 flex items-center justify-center gap-2 group"
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

            <div className="mt-8 text-center border-t border-slate-100 dark:border-slate-800 pt-8">
                <p className="text-[10px] text-slate-400 uppercase font-black tracking-widest leading-relaxed">
                    Plateforme d&apos;Arbitrage Magasin<br />
                    Propulsée par l&apos;Intelligence Artificielle
                </p>
            </div>
        </div>
    );
}
