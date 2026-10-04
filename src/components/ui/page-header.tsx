import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface PageHeaderProps {
    title: ReactNode;
    /** Une phrase : à quoi sert la page, en langage courant. */
    description?: ReactNode;
    icon?: LucideIcon;
    /** Boutons ou filtres alignés à droite du titre. */
    actions?: ReactNode;
    className?: string;
}

/**
 * En-tête commun à toutes les pages : même taille de titre, même place pour
 * l'explication et pour les actions. Il y en avait sept variantes.
 */
export function PageHeader({ title, description, icon: Icon, actions, className }: PageHeaderProps) {
    return (
        <header className={cn("flex flex-wrap items-start justify-between gap-4 mb-6", className)}>
            <div className="flex items-start gap-3 min-w-0">
                {Icon && (
                    <div
                        className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border"
                        style={{ background: "var(--accent-bg)", borderColor: "var(--accent-border)", color: "var(--accent)" }}
                    >
                        <Icon className="h-5 w-5" strokeWidth={2} />
                    </div>
                )}
                <div className="min-w-0">
                    <h1 className="text-2xl font-bold tracking-tight" style={{ color: "var(--text-primary)" }}>
                        {title}
                    </h1>
                    {description && (
                        <p className="mt-1 text-sm max-w-3xl" style={{ color: "var(--text-secondary)" }}>
                            {description}
                        </p>
                    )}
                </div>
            </div>
            {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </header>
    );
}
