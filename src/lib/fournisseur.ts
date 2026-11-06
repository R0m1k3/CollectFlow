/**
 * Affichage d'un fournisseur : toujours son nom ET son code.
 *
 * Les requêtes renvoient le nom, ou le code quand la fiche fournisseur n'a pas
 * de nom (le nom vaut alors le code), ou « Sans fournisseur » quand l'article
 * n'est rattaché à aucun. Le code est vide dans ce dernier cas.
 */

/** Nom exploitable : vide quand la requête n'a eu que le code à proposer. */
export function nomFournisseur(nom: string | null | undefined, code: string | null | undefined): string {
    const n = (nom ?? "").trim();
    const c = (code ?? "").trim();
    return n && n !== c ? n : "";
}

/** Libellé texte « Nom (CODE) » : filtres, tris, titres. */
export function libelleFournisseur(nom: string | null | undefined, code: string | null | undefined): string {
    const c = (code ?? "").trim();
    if (!c) return (nom ?? "").trim() || "Sans fournisseur";
    return `${nomFournisseur(nom, c) || "Nom introuvable"} (${c})`;
}
