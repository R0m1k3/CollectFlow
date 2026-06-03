"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { commandeCadences } from "@/db/schema";
import { pgGetFournisseurs, pgGetDerniereReceptionParFournisseur } from "@/lib/pg-ff-client";

export type CadenceStatut = "a_commander" | "bientot" | "ok" | "inconnu";

export interface CadenceView {
    id: number;
    codefou: string;
    nomfou: string;
    site: string;
    intervalleSemaines: number;
    actif: boolean;
    /** Date ISO de la dernière réception, ou null si inconnue */
    derniereReception: string | null;
    /** Date ISO d'échéance (dernière réception + X semaines), ou null */
    echeance: string | null;
    /** Jours restants avant l'échéance (négatif = en retard), ou null */
    joursRestants: number | null;
    statut: CadenceStatut;
}

const MS_PAR_JOUR = 24 * 60 * 60 * 1000;
/** Seuil (en jours) en dessous duquel une cadence passe en "bientôt à commander" */
const SEUIL_BIENTOT_JOURS = 7;

function calcStatut(joursRestants: number | null): CadenceStatut {
    if (joursRestants === null) return "inconnu";
    if (joursRestants <= 0) return "a_commander";
    if (joursRestants <= SEUIL_BIENTOT_JOURS) return "bientot";
    return "ok";
}

/** Liste des fournisseurs (référentiel) pour le sélecteur de cadence. */
export async function getFournisseursPourCadence(): Promise<{ code: string; nom: string }[]> {
    return pgGetFournisseurs();
}

/**
 * Retourne toutes les cadences enrichies du calcul d'échéance à partir
 * de la dernière réception (FF Nancy).
 */
export async function listCadences(): Promise<CadenceView[]> {
    let rows: typeof commandeCadences.$inferSelect[] = [];
    let receptions = new Map<string, string>();
    try {
        [rows, receptions] = await Promise.all([
            db.select().from(commandeCadences),
            pgGetDerniereReceptionParFournisseur(),
        ]);
    } catch (e) {
        console.error("[cadence] listCadences error:", (e as Error).message);
        return [];
    }

    const now = Date.now();

    return rows.map((r) => {
        const receptionIso = receptions.get(`${r.codeFournisseur}|${r.site}`) ?? null;

        let echeanceIso: string | null = null;
        let joursRestants: number | null = null;
        if (receptionIso) {
            const echeance = new Date(receptionIso).getTime() + r.intervalleSemaines * 7 * MS_PAR_JOUR;
            echeanceIso = new Date(echeance).toISOString();
            joursRestants = Math.ceil((echeance - now) / MS_PAR_JOUR);
        }

        return {
            id: r.id,
            codefou: r.codeFournisseur,
            nomfou: r.nomFournisseur ?? r.codeFournisseur,
            site: r.site,
            intervalleSemaines: r.intervalleSemaines,
            actif: r.actif,
            derniereReception: receptionIso,
            echeance: echeanceIso,
            joursRestants,
            statut: r.actif ? calcStatut(joursRestants) : "inconnu",
        } satisfies CadenceView;
    });
}

export interface UpsertCadenceInput {
    codefou: string;
    nomfou?: string | null;
    site: string;
    intervalleSemaines: number;
    actif?: boolean;
}

/** Crée ou met à jour la cadence d'un fournisseur sur un site. */
export async function upsertCadence(input: UpsertCadenceInput): Promise<{ ok: boolean; error?: string }> {
    const codefou = input.codefou?.trim();
    const site = input.site?.trim();
    const intervalle = Math.round(Number(input.intervalleSemaines));

    if (!codefou || !site) return { ok: false, error: "Fournisseur et magasin requis." };
    if (!Number.isFinite(intervalle) || intervalle < 1 || intervalle > 104) {
        return { ok: false, error: "L'intervalle doit être compris entre 1 et 104 semaines." };
    }

    try {
        await db
            .insert(commandeCadences)
            .values({
                codeFournisseur: codefou,
                nomFournisseur: input.nomfou ?? null,
                site,
                intervalleSemaines: intervalle,
                actif: input.actif ?? true,
            })
            .onConflictDoUpdate({
                target: [commandeCadences.codeFournisseur, commandeCadences.site],
                set: {
                    nomFournisseur: input.nomfou ?? null,
                    intervalleSemaines: intervalle,
                    actif: input.actif ?? true,
                    updatedAt: new Date(),
                },
            });
        revalidatePath("/commandes-auto");
        return { ok: true };
    } catch (e) {
        console.error("[cadence] upsertCadence error:", (e as Error).message);
        return { ok: false, error: "Échec de l'enregistrement." };
    }
}

/** Active / désactive une cadence sans la supprimer. */
export async function toggleCadence(codefou: string, site: string, actif: boolean): Promise<{ ok: boolean }> {
    try {
        await db
            .update(commandeCadences)
            .set({ actif, updatedAt: new Date() })
            .where(and(eq(commandeCadences.codeFournisseur, codefou), eq(commandeCadences.site, site)));
        revalidatePath("/commandes-auto");
        return { ok: true };
    } catch (e) {
        console.error("[cadence] toggleCadence error:", (e as Error).message);
        return { ok: false };
    }
}

/** Supprime définitivement une cadence. */
export async function removeCadence(codefou: string, site: string): Promise<{ ok: boolean }> {
    try {
        await db
            .delete(commandeCadences)
            .where(and(eq(commandeCadences.codeFournisseur, codefou), eq(commandeCadences.site, site)));
        revalidatePath("/commandes-auto");
        return { ok: true };
    } catch (e) {
        console.error("[cadence] removeCadence error:", (e as Error).message);
        return { ok: false };
    }
}
