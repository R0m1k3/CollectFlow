import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Conteneur de base : fond, bordure et ombre du thème. */
export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
    return (
        <div
            className={cn("rounded-xl border bg-[var(--bg-surface)] border-[var(--border)] shadow-[var(--shadow-sm)]", className)}
            {...props}
        />
    );
}

interface CardHeaderProps {
    title: ReactNode;
    description?: ReactNode;
    actions?: ReactNode;
    className?: string;
}

export function CardHeader({ title, description, actions, className }: CardHeaderProps) {
    return (
        <div className={cn("flex flex-wrap items-start justify-between gap-3 px-5 pt-4 pb-3 border-b border-[var(--border)]", className)}>
            <div className="min-w-0">
                <h2 className="text-base font-semibold text-[var(--text-primary)]">{title}</h2>
                {description && <p className="mt-0.5 text-[13px] text-[var(--text-secondary)]">{description}</p>}
            </div>
            {actions && <div className="flex items-center gap-2">{actions}</div>}
        </div>
    );
}

export function CardContent({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
    return <div className={cn("p-5", className)} {...props} />;
}

/** Paire libellé / valeur dans une fiche (identité produit, réglages…). */
export function Field({ label, children, className }: { label: ReactNode; children: ReactNode; className?: string }) {
    return (
        <div className={cn("min-w-0", className)}>
            <div className="text-xs font-medium text-[var(--text-muted)]">{label}</div>
            <div className="mt-0.5 text-sm text-[var(--text-primary)] break-words">{children}</div>
        </div>
    );
}
