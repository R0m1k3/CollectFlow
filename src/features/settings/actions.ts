"use server";

/**
 * Actions des Paramètres — réservées aux administrateurs.
 *
 * Aucun secret ne repart vers le navigateur : les mots de passe (base, Qlik) et
 * les clés d'IA restent dans `data/.db-config.json`. Un mot de passe laissé vide
 * dans le formulaire signifie « conserver celui qui est enregistré ».
 */

import { Pool } from "pg";
import { requireAdmin, verifierAdmin } from "@/lib/authz";
import { CONFIG_FILE, readConfig, writeConfig } from "./config-file";
import { diagnostiquerApiFf } from "./ff-api-diagnostic";

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

/** Décode un composant d'URL, ou le garde tel quel s'il n'est pas encodé proprement. */
function decoder(valeur: string): string {
    try {
        return decodeURIComponent(valeur);
    } catch {
        return valeur;
    }
}

/** Découpe l'URL `postgres://` enregistrée en champs du formulaire. */
function lireUrlPostgres(url: string) {
    try {
        const u = new URL(url);
        return {
            host: u.hostname,
            port: u.port || "5432",
            database: decoder(u.pathname.slice(1)),
            user: decoder(u.username),
            password: decoder(u.password),
            ssl: url.includes("sslmode=require"),
        };
    } catch (e) {
        console.error("[Settings] URL de base enregistrée illisible :", (e as Error).message);
        return null;
    }
}

function construireUrlPostgres(champs: ChampsBaseDeDonnees, motDePasse: string): string {
    const user = encodeURIComponent(champs.user.trim());
    const identifiants = motDePasse ? `${user}:${encodeURIComponent(motDePasse)}` : user;
    const port = champs.port.trim() || "5432";
    return `postgres://${identifiants}@${champs.host.trim()}:${port}/${champs.database.trim()}${champs.ssl ? "?sslmode=require" : ""}`;
}

/** Mot de passe saisi, sinon celui de l'URL enregistrée. */
async function motDePasseBase(champs: ChampsBaseDeDonnees): Promise<string> {
    if (champs.password) return champs.password;
    const { url } = await readConfig();
    return (url && lireUrlPostgres(url)?.password) || "";
}

/** Réglages enregistrés, sans aucun secret. */
export async function getParametresAffichables(): Promise<ParametresAffichables> {
    await requireAdmin();
    const config = await readConfig();
    const base = config.url ? lireUrlPostgres(config.url) : null;
    return {
        db: base
            ? {
                host: base.host,
                port: base.port,
                database: base.database,
                user: base.user,
                ssl: base.ssl,
                motDePasseEnregistre: base.password !== "",
            }
            : null,
        qlik: {
            host: config.qlikHost ?? "",
            user: config.qlikUser ?? "",
            // Même ordre de priorité que getQlikConfig() : réglage enregistré, puis variable d'environnement.
            motDePasseEnregistre: Boolean(config.qlikPassword || process.env.QLIK_PWD),
        },
        ffApiBaseUrl: config.ffApiBaseUrl ?? "",
    };
}

export async function testDatabaseConnection(champs: ChampsBaseDeDonnees) {
    const acces = await verifierAdmin();
    if (!acces.ok) return { success: false, error: acces.message };

    const url = construireUrlPostgres(champs, await motDePasseBase(champs));
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

export async function saveDatabaseSettings(champs: ChampsBaseDeDonnees) {
    const acces = await verifierAdmin();
    if (!acces.ok) return { success: false, error: acces.message };

    try {
        const url = construireUrlPostgres(champs, await motDePasseBase(champs));
        // Seule l'URL change : les clés d'IA et les réglages Qlik / API FF sont conservés.
        console.log(`[Settings] Saving config to ${CONFIG_FILE}`);
        await writeConfig({ url });
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

/** Mot de passe vide ou absent : celui qui est enregistré est conservé. */
export async function saveQlikSettings(qlikHost: string, qlikUser: string, qlikPassword?: string) {
    const acces = await verifierAdmin();
    if (!acces.ok) return { success: false, error: acces.message };

    try {
        await writeConfig({ qlikHost, qlikUser, ...(qlikPassword ? { qlikPassword } : {}) });
        console.log("[Settings] Qlik configuration saved.");
        return { success: true };
    } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error("[Settings] Failed to save Qlik config:", msg);
        return { success: false, error: msg };
    }
}

/** Mot de passe vide ou absent : on teste avec celui qui est enregistré. */
export async function testQlikConnection(qlikHost: string, qlikUser: string, qlikPassword?: string) {
    const acces = await verifierAdmin();
    if (!acces.ok) return { success: false, error: acces.message };

    try {
        const { getQlikConfig, qlikNtlmSession } = await import("@/lib/qlik-client");
        const enregistre = getQlikConfig();
        const cfg = { ...enregistre, user: qlikUser, password: qlikPassword || enregistre.password };
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
    const acces = await verifierAdmin();
    if (!acces.ok) return { success: false, error: acces.message };

    try {
        const cleaned = ffApiBaseUrl.trim().replace(/\/+$/, "");
        if (cleaned && !/^https?:\/\//i.test(cleaned)) {
            return { success: false, error: "L'URL doit commencer par http:// ou https://" };
        }
        await writeConfig({ ffApiBaseUrl: cleaned || undefined });
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

/** Teste l'API FF Nancy (voir `diagnostiquerApiFf`). */
export async function testFfApiConnection(ffApiBaseUrl?: string): Promise<Awaited<ReturnType<typeof diagnostiquerApiFf>>> {
    const acces = await verifierAdmin();
    if (!acces.ok) return { success: false, url: "", error: acces.message };
    return diagnostiquerApiFf(ffApiBaseUrl);
}
