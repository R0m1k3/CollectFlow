import { scryptSync, randomBytes, timingSafeEqual } from "crypto";

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
