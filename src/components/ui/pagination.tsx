"use client";

import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react";

interface PaginationProps {
    page: number;
    totalPages: number;
    total: number;
    pageSize: number;
    onChange: (page: number) => void;
    /** Nom des éléments comptés (« articles », « publicités »…). */
    unite?: string;
}

/** Pagination commune : « 51 à 100 sur 1 234 articles » et quatre boutons. */
export function Pagination({ page, totalPages, total, pageSize, onChange, unite = "lignes" }: PaginationProps) {
    if (total === 0 || totalPages <= 1) return null;
    const debut = (page - 1) * pageSize + 1;
    const fin = Math.min(page * pageSize, total);
    const aller = (p: number) => onChange(Math.min(Math.max(1, p), totalPages));
    const bouton =
        "rounded-lg border p-1.5 border-[var(--border-strong)] bg-[var(--bg-surface)] text-[var(--text-secondary)] " +
        "hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-40";

    return (
        <nav aria-label="Pagination" className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-[13px] text-[var(--text-secondary)] tabular-nums">
                {debut.toLocaleString("fr-FR")} à {fin.toLocaleString("fr-FR")} sur{" "}
                <span className="font-semibold text-[var(--text-primary)]">{total.toLocaleString("fr-FR")}</span> {unite}
            </span>
            <div className="flex items-center gap-1.5">
                <button type="button" className={bouton} onClick={() => aller(1)} disabled={page <= 1} aria-label="Première page">
                    <ChevronsLeft className="h-4 w-4" />
                </button>
                <button type="button" className={bouton} onClick={() => aller(page - 1)} disabled={page <= 1} aria-label="Page précédente">
                    <ChevronLeft className="h-4 w-4" />
                </button>
                <span className="px-2 text-[13px] text-[var(--text-secondary)] tabular-nums">
                    Page {page.toLocaleString("fr-FR")} / {totalPages.toLocaleString("fr-FR")}
                </span>
                <button type="button" className={bouton} onClick={() => aller(page + 1)} disabled={page >= totalPages} aria-label="Page suivante">
                    <ChevronRight className="h-4 w-4" />
                </button>
                <button type="button" className={bouton} onClick={() => aller(totalPages)} disabled={page >= totalPages} aria-label="Dernière page">
                    <ChevronsRight className="h-4 w-4" />
                </button>
            </div>
        </nav>
    );
}
