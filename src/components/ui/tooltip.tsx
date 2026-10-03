"use client";

import type { ReactNode } from "react";
import { Tooltip as TooltipPrimitive } from "radix-ui";
import { Info } from "lucide-react";
import { GLOSSAIRE, type CleGlossaire } from "@/lib/glossaire";
import { cn } from "@/lib/utils";

/** À placer une fois en haut de l'arbre (cf. app/providers.tsx). */
export function TooltipProvider({ children }: { children: ReactNode }) {
    return (
        <TooltipPrimitive.Provider delayDuration={250} skipDelayDuration={100}>
            {children}
        </TooltipPrimitive.Provider>
    );
}

interface TooltipProps {
    content: ReactNode;
    children: ReactNode;
    side?: "top" | "right" | "bottom" | "left";
}

/** Infobulle accessible (survol et focus clavier), lisible dans les deux thèmes. */
export function Tooltip({ content, children, side = "top" }: TooltipProps) {
    return (
        <TooltipPrimitive.Root>
            <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
            <TooltipPrimitive.Portal>
                <TooltipPrimitive.Content
                    side={side}
                    sideOffset={6}
                    collisionPadding={8}
                    className="z-[200] max-w-xs rounded-lg border px-3 py-2 text-[13px] leading-snug shadow-[var(--shadow-md)] animate-in fade-in-0 zoom-in-95"
                    style={{ background: "var(--bg-surface)", borderColor: "var(--border-strong)", color: "var(--text-primary)" }}
                >
                    {content}
                </TooltipPrimitive.Content>
            </TooltipPrimitive.Portal>
        </TooltipPrimitive.Root>
    );
}

interface TermeProps {
    /** Entrée du glossaire à expliquer. */
    id: CleGlossaire;
    /** Texte affiché ; par défaut le libellé du glossaire. */
    children?: ReactNode;
    className?: string;
}

/**
 * Terme métier avec sa définition au survol : un petit « i » signale qu'une
 * explication existe, sans encombrer la lecture.
 */
export function Terme({ id, children, className }: TermeProps) {
    const entree = GLOSSAIRE[id];
    return (
        <Tooltip
            content={
                <>
                    <span className="font-semibold">{entree.terme}</span>
                    <span className="block mt-0.5" style={{ color: "var(--text-secondary)" }}>{entree.definition}</span>
                </>
            }
        >
            <span
                tabIndex={0}
                className={cn("inline-flex items-center gap-1 cursor-help outline-none", className)}
            >
                {children ?? entree.terme}
                <Info className="h-3.5 w-3.5 shrink-0 opacity-60" aria-hidden />
            </span>
        </Tooltip>
    );
}
