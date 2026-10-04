import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { DeltaBadge } from "@/components/ui/badge";

interface StatCardProps {
    label: ReactNode;
    value: ReactNode;
    /** Précision sous la valeur (« dont 12 en promo », « hier »…). */
    hint?: ReactNode;
    /** Évolution en % à afficher en pastille (vs N-1). */
    delta?: number | null;
    deltaLabel?: ReactNode;
    icon?: LucideIcon;
    className?: string;
}

/** Indicateur chiffré : libellé lisible, valeur en grand, évolution. */
export function StatCard({ label, value, hint, delta, deltaLabel = "vs N-1", icon: Icon, className }: StatCardProps) {
    return (
        <div
            className={cn(
                "rounded-xl border p-4 flex flex-col gap-2 bg-[var(--bg-surface)] border-[var(--border)] shadow-[var(--shadow-sm)]",
                className,
            )}
        >
            <div className="flex items-center justify-between gap-2">
                <span className="text-[13px] font-medium text-[var(--text-secondary)]">{label}</span>
                {Icon && <Icon className="h-4 w-4 shrink-0 text-[var(--text-muted)]" aria-hidden />}
            </div>
            <div className="text-2xl font-bold tabular-nums tracking-tight text-[var(--text-primary)]">{value}</div>
            {(delta !== undefined || hint) && (
                <div className="flex flex-wrap items-center gap-2 text-[13px] text-[var(--text-muted)]">
                    {delta !== undefined && (
                        <>
                            <DeltaBadge pct={delta} />
                            <span>{deltaLabel}</span>
                        </>
                    )}
                    {hint && <span>{hint}</span>}
                </div>
            )}
        </div>
    );
}
