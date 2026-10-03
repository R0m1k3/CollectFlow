/**
 * Les magasins suivis par l'application — source unique des noms affichés.
 *
 * Chaque page avait sa propre version (« 292 — Frouard / Nancy », « Frouard »,
 * « Nancy », « F », « Site 292 »…) : un même magasin portait jusqu'à huit noms.
 * Toute page qui affiche un magasin passe désormais par `nomMagasin()`.
 */

export interface Magasin {
    /** Code FF du site (clé de toutes les requêtes). */
    code: string;
    /** Nom complet, celui affiché par défaut. */
    nom: string;
    /** Nom court, pour les en-têtes de colonnes étroites. */
    court: string;
    /** Initiale, pour les pastilles. */
    initiale: string;
}

export const MAGASINS: readonly Magasin[] = [
    { code: "292", nom: "Frouard (Nancy)", court: "Frouard", initiale: "F" },
    { code: "579", nom: "Houdemont", court: "Houdemont", initiale: "H" },
];

/** Code utilisé par la Grille et l'API pour « tous nos magasins ». */
export const CODE_TOUS_MAGASINS = "TOTAL";
/** Libellé de l'ensemble de nos magasins (à ne pas confondre avec le réseau). */
export const LIBELLE_TOUS_MAGASINS = "Nos 2 magasins";

/** Anciens codes encore présents dans certaines réponses de l'API FF. */
const ALIAS: Record<string, string> = { F01: "292", F02: "579" };

export function trouverMagasin(code: string | null | undefined): Magasin | undefined {
    if (!code) return undefined;
    const c = String(code).trim();
    return MAGASINS.find((m) => m.code === (ALIAS[c] ?? c));
}

/**
 * Nom lisible d'un magasin. `TOTAL` (ou vide) donne « Nos 2 magasins » ; un code
 * inconnu est renvoyé tel quel plutôt que masqué.
 */
export function nomMagasin(code: string | null | undefined, options: { court?: boolean } = {}): string {
    if (!code || code === CODE_TOUS_MAGASINS) return LIBELLE_TOUS_MAGASINS;
    const m = trouverMagasin(code);
    if (!m) return String(code);
    return options.court ? m.court : m.nom;
}
