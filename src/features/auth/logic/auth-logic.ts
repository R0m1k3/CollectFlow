import { scryptSync, randomBytes, timingSafeEqual } from "crypto";
import fs from "fs";
import path from "path";

const USERS_JSON_PATH = path.join(process.cwd(), "data", "users.json");

export interface UserJson {
    id: string;
    username: string;
    passwordHash: string;
    role: string;
}

/**
 * Hashes a password using scrypt.
 * Format: salt:hash
 */
export function hashPassword(password: string): string {
    const salt = randomBytes(16).toString("hex");
    const hash = scryptSync(password, salt, 64).toString("hex");
    return `${salt}:${hash}`;
}

/**
 * Verifies a password against a stored salt:hash string.
 */
export function verifyPassword(password: string, storedHash: string): boolean {
    try {
        const [salt, hash] = storedHash.split(":");
        if (!salt || !hash) return false;

        const hashBuffer = scryptSync(password, salt, 64);
        const storedHashBuffer = Buffer.from(hash, "hex");

        return timingSafeEqual(hashBuffer, storedHashBuffer);
    } catch (e) {
        return false;
    }
}

/**
 * Reads users from local JSON fallback.
 */
export function getFallbackUsers(): UserJson[] {
    try {
        if (!fs.existsSync(USERS_JSON_PATH)) {
            // Initial seed if file doesn't exist
            const defaultAdmin: UserJson = {
                id: "0",
                username: "admin",
                passwordHash: hashPassword("admin"),
                role: "admin"
            };
            saveFallbackUsers([defaultAdmin]);
            return [defaultAdmin];
        }
        const data = fs.readFileSync(USERS_JSON_PATH, "utf-8");
        return JSON.parse(data);
    } catch (e) {
        console.error("[AUTH] Error reading users.json:", e);
        return [];
    }
}

/**
 * Saves users to local JSON fallback.
 */
export function saveFallbackUsers(users: UserJson[]) {
    try {
        const dir = path.dirname(USERS_JSON_PATH);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(USERS_JSON_PATH, JSON.stringify(users, null, 2));
    } catch (e) {
        console.error("[AUTH] Error writing users.json:", e);
    }
}
