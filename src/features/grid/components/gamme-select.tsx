"use client";

import { GammeCode } from "@/types/grid";
import { cn } from "@/lib/utils";
import { CLASSES_SANS_GAMME, GAMMES, trouverGamme } from "@/lib/gammes";

interface GammeSelectProps {
    value: GammeCode | null;
    isDraft?: boolean;
    onChange: (gamme: GammeCode) => void;
}

/**
 * Choix de la gamme dans une ligne de la Grille.
 *
 * La case affiche la lettre (la colonne est étroite) mais la liste déroulante
 * donne le sens de chaque gamme (« A — Cœur », « Z — Sortie »…) : une liste
 * native transparente est posée sur la pastille.
 */
export function GammeSelect({ value, isDraft, onChange }: GammeSelectProps) {
    const gamme = trouverGamme(value);

    return (
        <div
            className={cn(
                "relative w-full rounded-lg border py-1.5 px-2 text-center text-xs font-bold shadow-sm",
                gamme ? gamme.classes : CLASSES_SANS_GAMME,
                isDraft && "ring-2 ring-[var(--accent-warning)]/60",
            )}
            title={gamme ? `${gamme.code} — ${gamme.nom} : ${gamme.description}` : "Aucune gamme"}
        >
            <span aria-hidden>{gamme ? gamme.code : "—"}</span>
            <select
                aria-label="Gamme du produit"
                value={gamme ? gamme.code : ""}
                onChange={(e) => onChange(e.target.value as GammeCode)}
                onClick={(e) => e.stopPropagation()}
                className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
            >
                <option value="" disabled>— Aucune gamme</option>
                {GAMMES.map((g) => (
                    <option key={g.code} value={g.code}>{g.code} — {g.nom}</option>
                ))}
            </select>
        </div>
    );
}
