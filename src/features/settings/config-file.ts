/**
 * CollectFlow — Fichier de configuration `data/.db-config.json`.
 *
 * Module **serveur**, pas fichier d'actions : ses fonctions ne doivent pas être
 * appelables depuis le navigateur (le fichier contient des mots de passe et des
 * clés d'API). Les actions de `./actions.ts` les utilisent après contrôle du rôle.
 */

import "server-only";

import fs from "fs/promises";
import path from "path";

export const DATA_DIR = path.join(process.cwd(), "data");
export const CONFIG_FILE = path.join(DATA_DIR, ".db-config.json");

export interface DbConfig {
    url: string;
    openRouterKey?: string;
    openRouterModel?: string;
    aiProvider?: "openrouter" | "google";
    googleAiKey?: string;
    googleAiModel?: string;
    /** Qlik Sense — données réseau */
    qlikHost?: string;
    qlikUser?: string;
    qlikPassword?: string;
    /**
     * API REST FF Nancy (ex. https://api.ffnancy.fr). Sert au panneau de statut et
     * au rattrapage des ventes par magasin dans la Grille. Configurable ici pour
     * ne pas dépendre d'une variable d'environnement qu'on ne peut pas changer
     * sans redéployer.
     */
    ffApiBaseUrl?: string;
}

/** Lit la config existante (ou {} si absente). */
export async function readConfig(): Promise<Partial<DbConfig>> {
    try {
        const data = await fs.readFile(CONFIG_FILE, "utf-8");
        return JSON.parse(data);
    } catch {
        return {};
    }
}

/**
 * Fusionne `patch` dans la config enregistrée : les clés absentes du patch sont
 * conservées telles quelles (une clé passée à `undefined` est retirée).
 */
export async function writeConfig(patch: Partial<DbConfig>): Promise<void> {
    const existing = await readConfig();
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(CONFIG_FILE, JSON.stringify({ ...existing, ...patch }, null, 2));
}
