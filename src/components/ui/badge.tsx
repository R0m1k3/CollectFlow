import type { ReactNode } from "react";
import { TrendingDown, TrendingUp, Minus } from "lucide-react";
import { cn } from "@/lib/utils";
import { nomMagasin } from "@/lib/magasins";
import { CLASSES_SANS_GAMME, trouverGamme } from "@/lib/gammes";
import { fmtDecimal1 } from "@/lib/format";

export type Ton = "neutre" | "accent" | "succes" | "alerte" | "erreur" | "info";

const TONS: Record<Ton, string> = {
    neutre: "bg-[var(--bg-elevated)] text-[var(--text-secondary)] border-[var(--border)]",
    accent: "bg-[var(--accent-bg)] text-[var(--accent)] border-[var(--accent-border)]",
    succes: "bg-[var(--accent-success-bg)] text-[var(--accent-success)] border-[var(--accent-success)]/30",
    alerte: "bg-[var(--accent-warning-bg)] text-[var(--accent-warning)] border-[var(--accent-warning)]/30",
    erreur: "bg-[var(--accent-error-bg)] text-[var(--accent-error)] border-[var(--accent-error)]/30",
    info: "bg-[var(--accent-bg)] text-[var(--viz-1)] border-[var(--border)]",
};

export function Badge({ ton = "neutre", children, className, title }: {
    ton?: Ton;
    children: ReactNode;
    className?: string;
    title?: string;
}) {
    return (
        <span
            title={title}
            className={cn(
                "inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-semibold",
                TONS[ton],
                className,
            )}
        >
            {children}
        </span>
    );
}

/**
 * Évolution en pourcentage (vs N-1) : flèche, signe et couleur. `null` (pas de
 * base de comparaison) s'affiche « — » plutôt qu'un faux 0 %.
 */
export function DeltaBadge({ pct, className }: { pct: number | null | undefined; className?: string }) {
    if (pct == null || !Number.isFinite(pct)) {
        return <Badge className={className} title="Pas de comparaison possible">—</Badge>;
    }
    const ton: Ton = pct > 0.05 ? "succes" : pct < -0.05 ? "erreur" : "neutre";
    const Icone = pct > 0.05 ? TrendingUp : pct < -0.05 ? TrendingDown : Minus;
    return (
        <Badge ton={ton} className={cn("tabular-nums", className)}>
            <Icone className="h-3.5 w-3.5" aria-hidden />
            {pct > 0 ? "+" : ""}{fmtDecimal1(pct)} %
        </Badge>
    );
}

/** Nom du magasin, jamais son code brut. */
export function StoreBadge({ code, court = false }: { code: string | null | undefined; court?: boolean }) {
    return <Badge ton="accent">{nomMagasin(code, { court })}</Badge>;
}

/** Pastille de gamme avec, au besoin, son nom (« A — Cœur »). */
export function GammeBadge({ code, avecNom = false }: { code: string | null | undefined; avecNom?: boolean }) {
    const g = trouverGamme(code);
    return (
        <span
            title={g ? `${g.code} — ${g.nom} : ${g.description}` : "Aucune gamme"}
            className={cn(
                "inline-flex items-center gap-1 whitespace-nowrap rounded-md border px-2 py-0.5 text-xs font-bold",
                g ? g.classes : CLASSES_SANS_GAMME,
            )}
        >
            {g ? g.code : "—"}
            {avecNom && <span className="font-medium">{g ? g.nom : "Sans gamme"}</span>}
        </span>
    );
}
