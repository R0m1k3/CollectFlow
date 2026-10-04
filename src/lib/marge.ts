/**
 * Seuils de couleur des taux de marge — une seule règle pour toute l'application.
 *
 * Le tableau de bord colorait à 25 / 15 %, la fiche produit à 40 / 25 %, la
 * Grille à 30 / 15 % pour le réseau : un même taux changeait de couleur d'une
 * page à l'autre. On retient la règle de la Grille (colonne Marge), l'écran
 * le plus utilisé : 40 % et 25 %.
 */

export const SEUILS_MARGE = {
    /** À partir de ce taux : vert. */
    bon: 40,
    /** À partir de ce taux : orange ; en dessous : rouge. */
    moyen: 25,
} as const;

export type NiveauMarge = "bon" | "moyen" | "faible";

export function niveauMarge(tauxPct: number | null | undefined): NiveauMarge | null {
    if (tauxPct == null || !Number.isFinite(tauxPct)) return null;
    if (tauxPct >= SEUILS_MARGE.bon) return "bon";
    if (tauxPct >= SEUILS_MARGE.moyen) return "moyen";
    return "faible";
}

/** Couleur CSS (variable du thème) associée au niveau de marge. */
export function couleurMarge(tauxPct: number | null | undefined): string {
    const niveau = niveauMarge(tauxPct);
    if (niveau === "bon") return "var(--accent-success)";
    if (niveau === "moyen") return "var(--accent-warning)";
    if (niveau === "faible") return "var(--accent-error)";
    return "var(--text-muted)";
}
