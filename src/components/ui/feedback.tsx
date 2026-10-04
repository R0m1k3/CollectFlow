"use client";

/**
 * Retours à l'utilisateur, communs à toute l'application :
 * - `toast.succes / toast.erreur / toast.info` : message discret en bas à droite,
 *   qui disparaît seul (remplace les fenêtres de succès et les `alert()`).
 * - `confirmer({...})` : demande de confirmation, renvoie une promesse de booléen
 *   (remplace `window.confirm`, au rendu non maîtrisé et en anglais selon le poste).
 *
 * Le rendu est assuré par un unique `<FeedbackHost />` (cf. app/providers.tsx).
 */

import { create } from "zustand";
import { CheckCircle2, Info, X, XCircle } from "lucide-react";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type TonToast = "succes" | "erreur" | "info";

interface ToastItem {
    id: number;
    ton: TonToast;
    message: string;
}

interface DemandeConfirmation {
    titre: string;
    message?: string;
    libelleConfirmer: string;
    danger: boolean;
    resoudre: (ok: boolean) => void;
}

interface FeedbackState {
    toasts: ToastItem[];
    confirmation: DemandeConfirmation | null;
}

const useFeedback = create<FeedbackState>(() => ({ toasts: [], confirmation: null }));

let prochainId = 1;

function ajouterToast(ton: TonToast, message: string, dureeMs: number) {
    const id = prochainId++;
    useFeedback.setState((s) => ({ toasts: [...s.toasts.slice(-3), { id, ton, message }] }));
    window.setTimeout(() => retirerToast(id), dureeMs);
}

function retirerToast(id: number) {
    useFeedback.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}

export const toast = {
    succes: (message: string) => ajouterToast("succes", message, 3500),
    erreur: (message: string) => ajouterToast("erreur", message, 7000),
    info: (message: string) => ajouterToast("info", message, 4500),
};

interface OptionsConfirmation {
    titre: string;
    message?: string;
    /** Libellé du bouton de validation : un verbe (« Supprimer »), jamais « OK ». */
    libelleConfirmer?: string;
    /** Action irréversible : bouton rouge. */
    danger?: boolean;
}

export function confirmer(options: OptionsConfirmation): Promise<boolean> {
    return new Promise((resolve) => {
        // Une demande encore ouverte est considérée comme refusée.
        useFeedback.getState().confirmation?.resoudre(false);
        useFeedback.setState({
            confirmation: {
                titre: options.titre,
                message: options.message,
                libelleConfirmer: options.libelleConfirmer ?? "Confirmer",
                danger: options.danger ?? false,
                resoudre: resolve,
            },
        });
    });
}

function repondre(ok: boolean) {
    const demande = useFeedback.getState().confirmation;
    if (!demande) return;
    useFeedback.setState({ confirmation: null });
    demande.resoudre(ok);
}

const ICONES = { succes: CheckCircle2, erreur: XCircle, info: Info } as const;
const COULEURS: Record<TonToast, string> = {
    succes: "var(--accent-success)",
    erreur: "var(--accent-error)",
    info: "var(--accent)",
};

export function FeedbackHost() {
    const toasts = useFeedback((s) => s.toasts);
    const confirmation = useFeedback((s) => s.confirmation);

    return (
        <>
            <div
                aria-live="polite"
                className="pointer-events-none fixed bottom-4 right-4 z-[300] flex w-[min(380px,calc(100vw-2rem))] flex-col gap-2"
            >
                {toasts.map((t) => {
                    const Icone = ICONES[t.ton];
                    return (
                        <div
                            key={t.id}
                            role={t.ton === "erreur" ? "alert" : "status"}
                            className="pointer-events-auto flex items-start gap-3 rounded-xl border px-4 py-3 shadow-[var(--shadow-lg)] animate-in fade-in-0 slide-in-from-bottom-2"
                            style={{ background: "var(--bg-surface)", borderColor: "var(--border-strong)" }}
                        >
                            <Icone className="mt-0.5 h-5 w-5 shrink-0" style={{ color: COULEURS[t.ton] }} aria-hidden />
                            <p className="flex-1 text-sm text-[var(--text-primary)]">{t.message}</p>
                            <button
                                type="button"
                                onClick={() => retirerToast(t.id)}
                                aria-label="Fermer le message"
                                className="rounded p-0.5 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                            >
                                <X className="h-4 w-4" />
                            </button>
                        </div>
                    );
                })}
            </div>

            <Dialog open={confirmation !== null} onOpenChange={(open) => { if (!open) repondre(false); }}>
                <DialogContent showCloseButton={false} className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>{confirmation?.titre}</DialogTitle>
                        {confirmation?.message && (
                            <DialogDescription className="text-[var(--text-secondary)]">{confirmation.message}</DialogDescription>
                        )}
                    </DialogHeader>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => repondre(false)}>Annuler</Button>
                        <Button
                            variant={confirmation?.danger ? "destructive" : "default"}
                            onClick={() => repondre(true)}
                            className={cn(confirmation?.danger && "dark:bg-destructive")}
                        >
                            {confirmation?.libelleConfirmer}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    );
}
