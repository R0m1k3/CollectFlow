/**
 * CollectFlow — Gammes proposées par l'API, en attente de validation.
 *
 * L'API `/api/v1` ne change plus une gamme directement : elle dépose une
 * proposition, que la Grille affiche comme une modification non enregistrée.
 * L'utilisateur voit ainsi quels produits changent de gamme, puis valide
 * (« Enregistrer ») ou rejette (« Annuler les modifications »).
 */

import "server-only";

import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { gammesAValider } from "@/db/schema";

export interface PropositionGamme {
    codein: string;
    /** Gamme proposée. */
    gamme: string;
    /** Gamme enregistrée au moment de la proposition. */
    gammePrecedente: string | null;
}

export interface GammeAValider extends PropositionGamme {
    auteur: string | null;
    /** Date ISO de la proposition. */
    proposeeLe: string;
}

/**
 * Dépose des propositions (la dernière l'emporte pour un même article) et retire
 * celles des articles `annules` — redemander la gamme déjà enregistrée annule la
 * proposition en attente.
 */
export async function proposerGammes(input: {
    codeFournisseur: string;
    propositions: PropositionGamme[];
    annules: string[];
    auteur: string;
}): Promise<void> {
    const { codeFournisseur, propositions, annules, auteur } = input;
    await db.transaction(async (tx) => {
        if (annules.length > 0) {
            await tx
                .delete(gammesAValider)
                .where(and(eq(gammesAValider.codeFournisseur, codeFournisseur), inArray(gammesAValider.codein, annules)));
        }
        if (propositions.length > 0) {
            const maintenant = new Date();
            await tx
                .insert(gammesAValider)
                .values(propositions.map((p) => ({
                    codeFournisseur,
                    codein: p.codein,
                    gamme: p.gamme,
                    gammePrecedente: p.gammePrecedente,
                    auteur: auteur.slice(0, 100),
                    createdAt: maintenant,
                })))
                .onConflictDoUpdate({
                    target: [gammesAValider.codeFournisseur, gammesAValider.codein],
                    set: {
                        gamme: sql`excluded.gamme`,
                        gammePrecedente: sql`excluded.gamme_precedente`,
                        auteur: sql`excluded.auteur`,
                        createdAt: sql`excluded.created_at`,
                    },
                });
        }
    });
}

/** Propositions en attente pour un fournisseur. */
export async function listerGammesAValider(codeFournisseur: string): Promise<GammeAValider[]> {
    const rows = await db
        .select()
        .from(gammesAValider)
        .where(eq(gammesAValider.codeFournisseur, codeFournisseur));
    return rows.map((r) => ({
        codein: r.codein,
        gamme: r.gamme,
        gammePrecedente: r.gammePrecedente,
        auteur: r.auteur,
        proposeeLe: r.createdAt.toISOString(),
    }));
}

/** Propositions en attente pour une liste d'articles, indexées par `fournisseur|codein`. */
export async function gammesAValiderParArticle(codeins: string[]): Promise<Map<string, string>> {
    if (codeins.length === 0) return new Map();
    const rows = await db
        .select({ codeFournisseur: gammesAValider.codeFournisseur, codein: gammesAValider.codein, gamme: gammesAValider.gamme })
        .from(gammesAValider)
        .where(inArray(gammesAValider.codein, codeins));
    return new Map(rows.map((r) => [`${r.codeFournisseur}|${r.codein}`, r.gamme]));
}

/** Retire des propositions, une fois validées ou rejetées dans la Grille. */
export async function supprimerGammesAValider(codeFournisseur: string, codeins: string[]): Promise<void> {
    if (codeins.length === 0) return;
    await db
        .delete(gammesAValider)
        .where(and(eq(gammesAValider.codeFournisseur, codeFournisseur), inArray(gammesAValider.codein, codeins)));
}
