"use server";

import { Pool } from "pg";
import fs from "fs/promises";
import path from "path";
import { requireAdmin } from "@/lib/auth";

const DATA_DIR = path.join(process.cwd(), "data");
const CONFIG_FILE = path.join(DATA_DIR, ".db-config.json");

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

/**
 * Ce que la page Paramètres reçoit : jamais de secret, seulement leur présence.
 * Le mot de passe est retiré de `url` ; le mot de passe Qlik et les clés IA sont omis.
 */
export type PublicDbConfig = Omit<DbConfig, "qlikPassword" | "openRouterKey" | "googleAiKey"> & {
    hasDbPassword: boolean;
    hasQlikPassword: boolean;
    hasOpenRouterKey: boolean;
    hasGoogleAiKey: boolean;
};

/** Lit la config existante (ou {} si absente). */
async function readConfig(): Promise<Partial<DbConfig>> {
    try {
        const data = await fs.readFile(CONFIG_FILE, "utf-8");
        return JSON.parse(data);
    } catch {
        return {};
    }
}

function parseDbUrl(url: string): URL | null {
    try {
        return new URL(url);
    } catch {
        return null;
    }
}

/**
 * Complète une URL saisie sans mot de passe avec celui déjà enregistré : le champ
 * est vide dans le navigateur, puisque le secret n'y est plus envoyé.
 *
 * Seulement pour le même hôte, port et utilisateur — sinon le mot de passe masqué
 * pourrait être envoyé à un serveur arbitraire par simple test de connexion.
 */
async function withSavedDbPassword(url: string): Promise<string> {
    const next = parseDbUrl(url);
    if (!next || next.password) return url;
    const savedUrl = (await readConfig()).url;
    const saved = savedUrl ? parseDbUrl(savedUrl) : null;
    if (!saved?.password) return url;
    const sameTarget =
        saved.hostname.toLowerCase() === next.hostname.toLowerCase() &&
        (saved.port || "5432") === (next.port || "5432") &&
        saved.username === next.username;
    if (!sameTarget) return url;
    next.password = saved.password;
    return next.toString();
}

/** Même règle pour Qlik : un mot de passe vide ne réutilise l'enregistré que pour la même cible. */
function isSameQlikTarget(cfg: Partial<DbConfig>, qlikHost: string, qlikUser: string): boolean {
    return (
        (cfg.qlikHost ?? "").trim().toLowerCase() === qlikHost.trim().toLowerCase() &&
        (cfg.qlikUser ?? "").trim().toLowerCase() === qlikUser.trim().toLowerCase()
    );
}

export async function testDatabaseConnection(rawUrl: string) {
    await requireAdmin();
    const url = await withSavedDbPassword(rawUrl);
    console.log("Testing connection to:", url.replace(/:([^@]+)@/, ":****@"));
    const pool = new Pool({
        connectionString: url,
        connectionTimeoutMillis: 5000,
    });

    try {
        const client = await pool.connect();
        await client.query("SELECT 1");
        client.release();
        return { success: true };
    } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error("Database connection test failed:", errorMessage);
        return { success: false, error: errorMessage };
    } finally {
        await pool.end();
    }
}

export async function saveDatabaseSettings(
    url: string,
    openRouterKey?: string,
    openRouterModel?: string,
    aiProvider?: "openrouter" | "google",
    googleAiKey?: string,
    googleAiModel?: string,
) {
    await requireAdmin();
    try {
        // Merge avec l'existant pour préserver les autres réglages (ex: Qlik, IA).
        // Un champ absent ou un secret vide laisse la valeur enregistrée intacte :
        // la page n'envoie que l'URL, et jamais les clés qu'elle ne reçoit plus.
        const existing = await readConfig();
        const config: DbConfig = { ...existing, url: await withSavedDbPassword(url) };
        if (openRouterKey) config.openRouterKey = openRouterKey;
        if (openRouterModel !== undefined) config.openRouterModel = openRouterModel;
        if (aiProvider !== undefined) config.aiProvider = aiProvider;
        if (googleAiKey) config.googleAiKey = googleAiKey;
        if (googleAiModel !== undefined) config.googleAiModel = googleAiModel;

        // S'assurer que le dossier data existe
        await fs.mkdir(DATA_DIR, { recursive: true });

        console.log(`[Settings] Saving config to ${CONFIG_FILE}`);
        await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2));
        console.log("[Settings] Database configuration saved successfully.");

        // Refresh the shared DB instance immediately
        const { refreshDb } = await import("@/db");
        refreshDb();

        return { success: true };
    } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error("Failed to save database configuration:", errorMessage);
        return { success: false, error: errorMessage };
    }
}

export async function saveQlikSettings(qlikHost: string, qlikUser: string, qlikPassword: string) {
    await requireAdmin();
    try {
        const existing = await readConfig();
        // Mot de passe vide = conserver l'enregistré (le champ n'est plus prérempli).
        const password = qlikPassword || (isSameQlikTarget(existing, qlikHost, qlikUser) ? existing.qlikPassword : undefined);
        const config = { ...existing, qlikHost, qlikUser, qlikPassword: password } as DbConfig;
        await fs.mkdir(DATA_DIR, { recursive: true });
        await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2));
        console.log("[Settings] Qlik configuration saved.");
        return { success: true };
    } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error("[Settings] Failed to save Qlik config:", msg);
        return { success: false, error: msg };
    }
}

export async function testQlikConnection(qlikHost: string, qlikUser: string, qlikPassword: string) {
    await requireAdmin();
    try {
        let password = qlikPassword;
        if (!password) {
            const existing = await readConfig();
            if (isSameQlikTarget(existing, qlikHost, qlikUser)) password = existing.qlikPassword ?? "";
        }
        const { getQlikConfig, qlikNtlmSession } = await import("@/lib/qlik-client");
        const cfg = { ...getQlikConfig(), user: qlikUser, password };
        if (qlikHost) cfg.host = qlikHost;
        await qlikNtlmSession(cfg);
        return { success: true };
    } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return { success: false, error: msg };
    }
}

/** Enregistre l'URL de l'API FF Nancy. Chaîne vide = revenir au défaut. */
export async function saveFfApiSettings(ffApiBaseUrl: string) {
    await requireAdmin();
    try {
        const cleaned = ffApiBaseUrl.trim().replace(/\/+$/, "");
        if (cleaned && !/^https?:\/\//i.test(cleaned)) {
            return { success: false, error: "L'URL doit commencer par http:// ou https://" };
        }
        const existing = await readConfig();
        const config = { ...existing, ffApiBaseUrl: cleaned || undefined } as DbConfig;
        await fs.mkdir(DATA_DIR, { recursive: true });
        await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2));
        // Sans cela, l'ancienne URL resterait servie jusqu'à 30 s après la sauvegarde.
        const { resetFfApiBaseCache } = await import("@/lib/api-ff-client");
        resetFfApiBaseCache();
        console.log(`[Settings] FF API base URL saved: ${cleaned || "(défaut)"}`);
        return { success: true };
    } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error("[Settings] Failed to save FF API config:", msg);
        return { success: false, error: msg };
    }
}

/**
 * Teste l'API FF Nancy (URL saisie, ou à défaut celle enregistrée) — voir
 * `diagnoseFfApi`. Réservé aux administrateurs : sans cette garde, n'importe quel
 * client connecté pourrait faire appeler une URL arbitraire par le serveur.
 */
export async function testFfApiConnection(ffApiBaseUrl?: string) {
    await requireAdmin();
    const { diagnoseFfApi } = await import("@/lib/api-ff-client");
    return diagnoseFfApi(ffApiBaseUrl);
}

/** Config enregistrée, secrets masqués (voir `PublicDbConfig`). */
export async function getSavedDatabaseConfig(): Promise<PublicDbConfig | null> {
    await requireAdmin();
    try {
        if (!(await fs.stat(CONFIG_FILE).catch(() => null))) {
            console.log(`[Settings] Config file not found at ${CONFIG_FILE}`);
            return null;
        }
        const data = await fs.readFile(CONFIG_FILE, "utf-8");
        const config = JSON.parse(data) as DbConfig;
        console.log(`[Settings] Config read from ${CONFIG_FILE}. Key present: ${!!config.openRouterKey}, Model: ${config.openRouterModel || "default"}`);
        const { qlikPassword, openRouterKey, googleAiKey, ...rest } = config;
        const parsedUrl = config.url ? parseDbUrl(config.url) : null;
        const hasDbPassword = !!parsedUrl?.password;
        if (parsedUrl) parsedUrl.password = "";
        return {
            ...rest,
            // URL illisible : on n'en renvoie rien plutôt que de risquer d'exposer le mot de passe.
            url: parsedUrl ? parsedUrl.toString() : "",
            hasDbPassword,
            hasQlikPassword: !!qlikPassword,
            hasOpenRouterKey: !!openRouterKey,
            hasGoogleAiKey: !!googleAiKey,
        };
    } catch (error) {
        console.error(`[Settings] Error reading config from ${CONFIG_FILE}:`, error);
        return null;
    }
}
