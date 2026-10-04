"use client";

import { useState, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export interface TabItem<V extends string> {
    value: V;
    label: ReactNode;
    /** Compteur affiché à droite du libellé. */
    count?: number;
    /** Pastille d'alerte (rouge) au lieu d'un compteur neutre. */
    alert?: boolean;
    icon?: LucideIcon;
}

interface TabsProps<V extends string> {
    items: readonly TabItem<V>[];
    value: V;
    onChange: (value: V) => void;
    disabled?: boolean;
    className?: string;
}

/**
 * Onglets soulignés, identiques sur toutes les pages. L'appelant décide de la
 * synchronisation avec l'URL (cf. `useUrlTab`) : un onglet doit pouvoir être
 * partagé par lien et survivre au rechargement.
 */
export function Tabs<V extends string>({ items, value, onChange, disabled, className }: TabsProps<V>) {
    return (
        <div role="tablist" className={cn("flex shrink-0 gap-1 overflow-x-auto border-b border-[var(--border)]", className)}>
            {items.map((t) => {
                const actif = t.value === value;
                const Icone = t.icon;
                return (
                    <button
                        key={t.value}
                        role="tab"
                        type="button"
                        aria-selected={actif}
                        disabled={disabled}
                        onClick={() => !actif && onChange(t.value)}
                        className={cn(
                            "-mb-px inline-flex items-center gap-2 whitespace-nowrap border-b-2 px-4 py-2.5 text-sm font-medium transition-colors disabled:cursor-wait",
                            actif
                                ? "border-[var(--accent)] text-[var(--text-primary)]"
                                : "border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--border-strong)]",
                        )}
                    >
                        {Icone && <Icone className="h-4 w-4" aria-hidden />}
                        {t.label}
                        {t.count !== undefined && (
                            <span
                                className={cn(
                                    "rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums",
                                    t.alert && t.count > 0
                                        ? "bg-[var(--accent-error)] text-white"
                                        : actif
                                            ? "bg-[var(--accent-bg)] text-[var(--accent)]"
                                            : "bg-[var(--bg-elevated)] text-[var(--text-secondary)]",
                                )}
                            >
                                {t.count.toLocaleString("fr-FR")}
                            </span>
                        )}
                    </button>
                );
            })}
        </div>
    );
}

/**
 * Segment de choix court (2 à 4 options), pour les bascules du type
 * « Fournisseur / Nomenclature » ou « Tous / Frouard / Houdemont ».
 */
export function Segmented<V extends string>({ items, value, onChange, disabled, className }: TabsProps<V>) {
    return (
        <div
            role="radiogroup"
            className={cn("inline-flex w-fit shrink-0 gap-0.5 rounded-lg border p-0.5 bg-[var(--bg-elevated)] border-[var(--border)]", className)}
        >
            {items.map((t) => {
                const actif = t.value === value;
                return (
                    <button
                        key={t.value}
                        type="button"
                        role="radio"
                        aria-checked={actif}
                        disabled={disabled}
                        onClick={() => !actif && onChange(t.value)}
                        className={cn(
                            "rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors whitespace-nowrap disabled:cursor-wait",
                            actif
                                ? "bg-[var(--bg-surface)] text-[var(--text-primary)] shadow-[var(--shadow-sm)]"
                                : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]",
                        )}
                    >
                        {t.label}
                        {t.count !== undefined && (
                            <span className="ml-1.5 text-xs tabular-nums text-[var(--text-muted)]">{t.count.toLocaleString("fr-FR")}</span>
                        )}
                    </button>
                );
            })}
        </div>
    );
}

/**
 * Onglet actif reflété dans l'URL (`?param=valeur`) sans navigation serveur :
 * le lien se partage et survit au rechargement, et changer d'onglet ne relance
 * aucune requête. `initial` vient de la page serveur (searchParams).
 */
export function useUrlTab<V extends string>(param: string, initial: V): [V, (value: V) => void] {
    const [value, setValue] = useState<V>(initial);
    const change = (next: V) => {
        setValue(next);
        const url = new URL(window.location.href);
        url.searchParams.set(param, next);
        window.history.replaceState(window.history.state, "", url.toString());
    };
    return [value, change];
}
