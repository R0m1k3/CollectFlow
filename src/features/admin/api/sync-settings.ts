"use server";

/**
 * CollectFlow — Réglages de la synchronisation nocturne.
 *
 * Rangés dans `data/.db-config.json`, comme les autres réglages de
 * l'application (base, Qlik, API FF), pour qu'il n'y ait qu'un seul endroit à
 * sauvegarder et à monter dans le conteneur.
 */

import fs from "fs/promises";
import path from "path";

const DATA_DIR = path.join(process.cwd(), "data");
const CONFIG_FILE = path.join(DATA_DIR, ".db-config.json");

export interface SyncSettings {
    /**
     * Désactivé par défaut : un déploiement ne doit pas se mettre à solliciter
     * Qlik et la base la nuit suivante sans que personne l'ait décidé.
     */
    actif: boolean;
    /** Heure d'ouverture de la fenêtre (0-23). */
    heureDebut: number;
    /** Heure de fermeture. Aucun fournisseur n'est **démarré** après. */
    heureFin: number;
    /**
     * Nombre maximum d'extractions Qlik par nuit. Chacune peut prendre 8 minutes
     * et le serveur abandonne quand il est trop sollicité : ce plafond est la
     * principale protection contre une nuit entièrement passée sur Qlik.
     */
    qlikParNuit: number;
    /** Une extraction Qlik est intercalée tous les N fournisseurs SQL. */
    sqlParQlik: number;
    /**
     * Âge minimal des données Qlik avant de les refaire. Ce sont des agrégats
     * mensuels : les rafraîchir toutes les nuits coûterait cher pour rien.
     */
    qlikMinJours: number;
}

export const SYNC_SETTINGS_DEFAUT: SyncSettings = {
    actif: false,
    heureDebut: 0,
    heureFin: 5,
    qlikParNuit: 6,
    sqlParQlik: 20,
    qlikMinJours: 7,
};

function borne(v: unknown, min: number, max: number, defaut: number): number {
    const n = Number(v);
    if (!Number.isFinite(n)) return defaut;
    return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** Normalise ce qui vient du fichier : il est éditable à la main. */
function normaliser(brut: Partial<SyncSettings> | undefined): SyncSettings {
    const d = SYNC_SETTINGS_DEFAUT;
    const s: SyncSettings = {
        actif: Boolean(brut?.actif),
        heureDebut: borne(brut?.heureDebut, 0, 23, d.heureDebut),
        heureFin: borne(brut?.heureFin, 0, 23, d.heureFin),
        qlikParNuit: borne(brut?.qlikParNuit, 0, 200, d.qlikParNuit),
        sqlParQlik: borne(brut?.sqlParQlik, 1, 500, d.sqlParQlik),
        qlikMinJours: borne(brut?.qlikMinJours, 0, 365, d.qlikMinJours),
    };
    // Une fenêtre de durée nulle ne s'ouvrirait jamais : on revient au défaut
    // plutôt que de laisser le planificateur muet sans explication.
    if (s.heureDebut === s.heureFin) {
        s.heureDebut = d.heureDebut;
        s.heureFin = d.heureFin;
    }
    return s;
}

export async function readSyncSettings(): Promise<SyncSettings> {
    try {
        const raw = await fs.readFile(CONFIG_FILE, "utf-8");
        const cfg = JSON.parse(raw) as { syncNuit?: Partial<SyncSettings> };
        return normaliser(cfg?.syncNuit);
    } catch {
        return { ...SYNC_SETTINGS_DEFAUT };
    }
}

export async function saveSyncSettings(patch: Partial<SyncSettings>): Promise<SyncSettings> {
    let existant: Record<string, unknown> = {};
    try {
        existant = JSON.parse(await fs.readFile(CONFIG_FILE, "utf-8"));
    } catch {
        // Pas encore de fichier : on le crée avec les seuls réglages de synchro.
    }
    const courant = normaliser((existant.syncNuit as Partial<SyncSettings>) ?? undefined);
    const suivant = normaliser({ ...courant, ...patch });

    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(CONFIG_FILE, JSON.stringify({ ...existant, syncNuit: suivant }, null, 2));
    console.log(`[sync-nuit] réglages enregistrés : ${JSON.stringify(suivant)}`);
    return suivant;
}
