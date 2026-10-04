import type { ReactNode } from "react";
import { AlertTriangle, Inbox, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface EmptyStateProps {
    title: ReactNode;
    description?: ReactNode;
    icon?: LucideIcon;
    action?: ReactNode;
    className?: string;
}

/** Rien à afficher : dire pourquoi, et quoi faire. */
export function EmptyState({ title, description, icon: Icon = Inbox, action, className }: EmptyStateProps) {
    return (
        <div
            className={cn(
                "flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed px-6 py-12 text-center",
                "border-[var(--border-strong)] bg-[var(--bg-surface)]",
                className,
            )}
        >
            <Icon className="h-8 w-8 text-[var(--text-muted)]" aria-hidden />
            <p className="text-base font-semibold text-[var(--text-primary)]">{title}</p>
            {description && <p className="max-w-md text-sm text-[var(--text-secondary)]">{description}</p>}
            {action && <div className="mt-2">{action}</div>}
        </div>
    );
}

interface ErrorStateProps {
    title?: ReactNode;
    /** Explication pour l'utilisateur ; le détail technique va dans `detail`. */
    description?: ReactNode;
    /** Message technique, replié par défaut. */
    detail?: string;
    action?: ReactNode;
    className?: string;
}

/** Un chargement a échoué : message clair, détail technique replié, action de reprise. */
export function ErrorState({
    title = "Les données n'ont pas pu être chargées",
    description = "Réessayez dans un instant. Si le problème persiste, prévenez un administrateur.",
    detail,
    action,
    className,
}: ErrorStateProps) {
    return (
        <div
            role="alert"
            className={cn(
                "flex flex-col items-center gap-2 rounded-xl border px-6 py-10 text-center",
                "border-[var(--accent-error)]/40 bg-[var(--accent-error-bg)]",
                className,
            )}
        >
            <AlertTriangle className="h-8 w-8 text-[var(--accent-error)]" aria-hidden />
            <p className="text-base font-semibold text-[var(--text-primary)]">{title}</p>
            <p className="max-w-md text-sm text-[var(--text-secondary)]">{description}</p>
            {detail && (
                <details className="mt-1 max-w-xl text-left text-xs text-[var(--text-muted)]">
                    <summary className="cursor-pointer">Détail technique</summary>
                    <pre className="mt-1 whitespace-pre-wrap break-words font-mono">{detail}</pre>
                </details>
            )}
            {action && <div className="mt-2">{action}</div>}
        </div>
    );
}

export function Skeleton({ className }: { className?: string }) {
    return <div className={cn("animate-pulse rounded-md bg-[var(--bg-elevated)]", className)} aria-hidden />;
}

/**
 * Silhouette d'une page pendant son chargement : la mise en page reste visible
 * et rien ne bloque l'écran (contrairement à l'ancienne fenêtre plein écran).
 */
export function PageSkeleton({ cards = 0, rows = 8 }: { cards?: number; rows?: number }) {
    return (
        <div className="space-y-6" aria-busy="true" aria-label="Chargement de la page">
            <div className="flex items-center gap-3">
                <Skeleton className="h-10 w-10 rounded-xl" />
                <div className="space-y-2">
                    <Skeleton className="h-6 w-56" />
                    <Skeleton className="h-4 w-80" />
                </div>
            </div>
            {cards > 0 && (
                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                    {Array.from({ length: cards }, (_, i) => <Skeleton key={i} className="h-28 rounded-xl" />)}
                </div>
            )}
            <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-surface)] p-4 space-y-3">
                <Skeleton className="h-9 w-full" />
                {Array.from({ length: rows }, (_, i) => <Skeleton key={i} className="h-7 w-full" />)}
            </div>
        </div>
    );
}
