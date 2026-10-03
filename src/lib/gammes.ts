/**
 * Les gammes d'assortiment : code, nom et couleurs — source unique.
 *
 * Les couleurs étaient définies trois fois (liste déroulante, filtre, actions
 * groupées) et le sens des lettres n'apparaissait que dans la barre d'actions
 * groupées : ailleurs, l'utilisateur ne voyait que « A », « B »…
 */

export type CodeGamme = "A" | "B" | "C" | "Y" | "Z";

export interface Gamme {
    code: CodeGamme;
    /** Nom court : « Cœur », « Sortie »… */
    nom: string;
    /** Phrase d'explication pour les infobulles. */
    description: string;
    /** Classes de pastille (fond, bordure, texte) lisibles en clair comme en sombre. */
    classes: string;
}

export const GAMMES: readonly Gamme[] = [
    {
        code: "A",
        nom: "Cœur",
        description: "Produit permanent, au cœur de l'assortiment.",
        classes: "border-emerald-500/40 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300",
    },
    {
        code: "B",
        nom: "Complémentaire",
        description: "Produit qui complète l'offre du rayon.",
        classes: "border-blue-500/40 bg-blue-500/10 text-blue-800 dark:text-blue-300",
    },
    {
        code: "C",
        nom: "Saisonnier",
        description: "Produit présent selon la saison.",
        classes: "border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-300",
    },
    {
        code: "Y",
        nom: "En veille",
        description: "Produit mis en attente : il n'est plus commandé pour l'instant.",
        classes: "border-violet-500/40 bg-violet-500/10 text-violet-800 dark:text-violet-300",
    },
    {
        code: "Z",
        nom: "Sortie",
        description: "Produit à retirer de l'assortiment.",
        classes: "border-rose-500/40 bg-rose-500/10 text-rose-800 dark:text-rose-300",
    },
];

/** Pastille d'un produit sans gamme. */
export const CLASSES_SANS_GAMME = "border-slate-400/40 bg-slate-500/10 text-slate-700 dark:text-slate-300";

export function trouverGamme(code: string | null | undefined): Gamme | undefined {
    if (!code) return undefined;
    return GAMMES.find((g) => g.code === code.trim());
}

/** « A — Cœur », ou « Sans gamme ». */
export function libelleGamme(code: string | null | undefined): string {
    const g = trouverGamme(code);
    return g ? `${g.code} — ${g.nom}` : "Sans gamme";
}
