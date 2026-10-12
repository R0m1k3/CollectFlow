/**
 * Cadencier des commandes fournisseurs — actions exécutées par le serveur
 * Rust : `POST /api/actions/{nom}`.
 */

import { callAction } from "@/lib/rpc";
import { refreshPage } from "@/lib/page-data";

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

/**
 * Les actions Next.js de modification appelaient `revalidatePath("/commandes-auto")`,
 * dont la réponse rafraîchissait la page : même effet ici après une réussite.
 */
function rafraichirSiOk<R extends { ok: boolean }>(resultat: R): R {
    if (resultat.ok) refreshPage();
    return resultat;
}

/** Liste des fournisseurs (référentiel) pour le sélecteur de cadence. */
export async function getFournisseursPourCadence(): Promise<{ code: string; nom: string }[]> {
    return callAction("getFournisseursPourCadence", []);
}

/**
 * Retourne toutes les cadences enrichies du calcul d'échéance à partir
 * de la dernière réception (FF Nancy).
 */
export async function listCadences(): Promise<CadenceView[]> {
    return callAction("listCadences", []);
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
    return rafraichirSiOk(await callAction<{ ok: boolean; error?: string }>("upsertCadence", [input]));
}

/** Active / désactive une cadence sans la supprimer. */
export async function toggleCadence(codefou: string, site: string, actif: boolean): Promise<{ ok: boolean; error?: string }> {
    return rafraichirSiOk(await callAction<{ ok: boolean; error?: string }>("toggleCadence", [codefou, site, actif]));
}

/** Supprime définitivement une cadence. */
export async function removeCadence(codefou: string, site: string): Promise<{ ok: boolean; error?: string }> {
    return rafraichirSiOk(await callAction<{ ok: boolean; error?: string }>("removeCadence", [codefou, site]));
}
