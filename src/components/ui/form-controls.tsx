"use client";

import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";
import { Search, X } from "lucide-react";
import { cn } from "@/lib/utils";

const CHAMP =
    "h-9 rounded-lg border px-3 text-sm bg-[var(--bg-surface)] border-[var(--border-strong)] text-[var(--text-primary)] " +
    "placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent-bg)] " +
    "disabled:opacity-60 disabled:cursor-not-allowed";

/** Libellé au-dessus d'un champ (et non à côté) : plus lisible en colonne étroite. */
export function Label({ children, htmlFor, className }: { children: ReactNode; htmlFor?: string; className?: string }) {
    return (
        <label htmlFor={htmlFor} className={cn("block mb-1 text-[13px] font-medium text-[var(--text-secondary)]", className)}>
            {children}
        </label>
    );
}

export interface SelectOption {
    value: string;
    label: string;
}

interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "onChange"> {
    label?: ReactNode;
    options: readonly SelectOption[];
    onChange: (value: string) => void;
    /** Option vide en tête (« Tous », « Tous les fournisseurs »…). */
    placeholder?: string;
}

/** Liste déroulante native, au style du thème. */
export function Select({ label, options, onChange, placeholder, className, id, ...props }: SelectProps) {
    const select = (
        <select
            id={id}
            onChange={(e) => onChange(e.target.value)}
            className={cn(CHAMP, "pr-8 min-w-[160px] cursor-pointer", className)}
            {...props}
        >
            {placeholder !== undefined && <option value="">{placeholder}</option>}
            {options.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
            ))}
        </select>
    );
    if (!label) return select;
    return (
        <div>
            <Label htmlFor={id}>{label}</Label>
            {select}
        </div>
    );
}

interface SearchInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "onChange" | "value"> {
    value: string;
    onChange: (value: string) => void;
}

/** Champ de recherche avec loupe et bouton d'effacement. */
export function SearchInput({ value, onChange, className, placeholder = "Rechercher…", ...props }: SearchInputProps) {
    return (
        <div className={cn("relative", className)}>
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]" aria-hidden />
            <input
                type="search"
                value={value}
                onChange={(e) => onChange(e.target.value)}
                placeholder={placeholder}
                className={cn(CHAMP, "w-full min-w-[240px] pl-9 pr-8")}
                {...props}
            />
            {value && (
                <button
                    type="button"
                    onClick={() => onChange("")}
                    aria-label="Effacer la recherche"
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                >
                    <X className="h-3.5 w-3.5" />
                </button>
            )}
        </div>
    );
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
    return <input className={cn(CHAMP, className)} {...props} />;
}
