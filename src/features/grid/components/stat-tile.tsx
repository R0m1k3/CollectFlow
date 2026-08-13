"use client";

import React from "react";

/**
 * Tuile de statistique : intitulé en phrase, valeur en chiffres proportionnels.
 *
 * Pas de `tabular-nums` ici : à grande taille, des chiffres de largeur égale font
 * paraître un nombre court anormalement lâche. Les chiffres tabulaires sont
 * réservés aux colonnes qui s'alignent verticalement (tableau, axes).
 *
 * Extraite de `heatmap-grid.tsx` pour être partagée entre la modale de tendance
 * réseau et la modale de détail mensuel produit. Aucun changement de rendu.
 */
export function TuileStat({ label, valeur, indice, couleur, icone: Icone }: {
    label: string;
    valeur: string;
    indice?: string;
    couleur?: string;
    icone?: React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
}) {
    return (
        <div className="rounded-xl px-3.5 py-3 flex-1 min-w-[160px]" style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)" }}>
            <div className="text-[12px] font-semibold uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
                {label}
            </div>
            <div className="flex items-center gap-1.5 mt-1">
                {Icone && <Icone className="w-5 h-5 shrink-0" style={{ color: couleur ?? "var(--text-primary)" }} />}
                <span className="text-[26px] font-bold leading-tight" style={{ color: couleur ?? "var(--text-primary)" }}>
                    {valeur}
                </span>
            </div>
            {indice && <div className="text-[12px] mt-1 leading-snug" style={{ color: "var(--text-muted)" }}>{indice}</div>}
        </div>
    );
}
