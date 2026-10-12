/**
 * Actions des Paramètres — réservées aux administrateurs, exécutées par le
 * serveur Rust : `POST /api/actions/{nom}`.
 *
 * Aucun secret ne repart vers le navigateur : les mots de passe (base, Qlik) et
 * les clés d'IA restent dans `data/.db-config.json`. Un mot de passe laissé vide
 * dans le formulaire signifie « conserver celui qui est enregistré ».
 */

import { callAction } from "@/lib/rpc";
import type { FfSyncStatus } from "@/types/ff";

export interface ChampsBaseDeDonnees {
    host: string;
    port: string;
    database: string;
    user: string;
    /** Vide ou absent : le mot de passe enregistré est conservé. */
    password?: string;
    ssl: boolean;
}

/** Ce que le formulaire peut afficher : jamais de mot de passe ni de clé. */
export interface ParametresAffichables {
    db: {
        host: string;
        port: string;
        database: string;
        user: string;
        ssl: boolean;
        motDePasseEnregistre: boolean;
    } | null;
    qlik: { host: string; user: string; motDePasseEnregistre: boolean };
    ffApiBaseUrl: string;
}

export interface ResultatAction {
    success: boolean;
    error?: string;
}

/** Diagnostic de l'API FF Nancy (bouton « Tester »). */
export type DiagnosticApiFf =
    | { success: true; url: string; ms: number; status: FfSyncStatus }
    | { success: false; url: string; error: string };

/** Réglages enregistrés, sans aucun secret. */
export async function getParametresAffichables(): Promise<ParametresAffichables> {
    return callAction("getParametresAffichables", []);
}

export async function testDatabaseConnection(champs: ChampsBaseDeDonnees): Promise<ResultatAction> {
    return callAction("testDatabaseConnection", [champs]);
}

export async function saveDatabaseSettings(champs: ChampsBaseDeDonnees): Promise<ResultatAction> {
    return callAction("saveDatabaseSettings", [champs]);
}

/** Mot de passe vide ou absent : celui qui est enregistré est conservé. */
export async function saveQlikSettings(qlikHost: string, qlikUser: string, qlikPassword?: string): Promise<ResultatAction> {
    return callAction("saveQlikSettings", [qlikHost, qlikUser, qlikPassword]);
}

/** Mot de passe vide ou absent : on teste avec celui qui est enregistré. */
export async function testQlikConnection(qlikHost: string, qlikUser: string, qlikPassword?: string): Promise<ResultatAction> {
    return callAction("testQlikConnection", [qlikHost, qlikUser, qlikPassword]);
}

/** Enregistre l'URL de l'API FF Nancy. Chaîne vide = revenir au défaut. */
export async function saveFfApiSettings(ffApiBaseUrl: string): Promise<ResultatAction> {
    return callAction("saveFfApiSettings", [ffApiBaseUrl]);
}

/** Teste l'API FF Nancy (diagnostic détaillé : DNS, refus, délai, code HTTP). */
export async function testFfApiConnection(ffApiBaseUrl?: string): Promise<DiagnosticApiFf> {
    return callAction("testFfApiConnection", [ffApiBaseUrl]);
}
