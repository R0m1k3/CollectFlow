import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { db } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { verifyPassword } from "@/features/auth/logic/auth-logic";
import { ensureAdminExists } from "@/features/auth/logic/seed-admin";
import { authConfig } from "./auth.config";

export const { handlers, auth, signIn, signOut } = NextAuth({
    ...authConfig,
    providers: [
        Credentials({
            name: "Credentials",
            credentials: {
                username: { label: "Utilisateur", type: "text" },
                password: { label: "Mot de passe", type: "password" }
            },
            async authorize(credentials) {
                await ensureAdminExists();

                if (!credentials?.username || !credentials?.password) return null;

                try {
                    console.log(`[AUTH] Checking user "${credentials.username}" in database...`);
                    const [user] = await db.select()
                        .from(users)
                        .where(eq(users.username, credentials.username as string));

                    console.log(`[AUTH] User found in DB: ${!!user}`);

                    if (!user) {
                        console.warn(`[AUTH] User "${credentials.username}" not found.`);
                        return null;
                    }

                    const isValid = verifyPassword(credentials.password as string, user.passwordHash);
                    console.log(`[AUTH] Password valid for "${credentials.username}": ${isValid}`);

                    if (!isValid) {
                        console.warn(`[AUTH] Invalid password for user "${credentials.username}".`);
                        return null;
                    }

                    return {
                        id: user.id.toString(),
                        username: user.username,
                        role: user.role,
                    };
                } catch (err: any) {
                    console.error("[AUTH] CRITICAL ERROR during authorize callback:", err.message || err);
                    // Propage l'erreur pour que Next-Auth la gère (mais authorize doit retourner null ou l'utilisateur)
                    return null;
                }
            }
        })
    ],
});
