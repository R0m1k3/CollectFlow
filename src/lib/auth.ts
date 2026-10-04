import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { db } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { verifyPassword, getFallbackUsers } from "@/features/auth/logic/auth-logic";
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
                    console.log(`[AUTH] Checking user "${credentials.username}"...`);
                    
                    let user: { id: number | string; username: string; passwordHash: string; role: string } | undefined;

                    // Try DB first
                    try {
                        const [dbUser] = await db.select()
                            .from(users)
                            .where(eq(users.username, credentials.username as string));
                        user = dbUser;
                        console.log(`[AUTH] DB check: User found: ${!!user}`);
                    } catch {
                        // Base injoignable uniquement : un compte absent de la base ne doit
                        // pas pouvoir se connecter avec le fichier de secours (admin/admin).
                        console.warn("[AUTH] DB unreachable, falling back to JSON.");
                        const fallbackUsers = getFallbackUsers();
                        user = fallbackUsers.find(u => u.username === credentials.username);
                        console.log(`[AUTH] JSON check: User found: ${!!user}`);
                    }

                    if (!user) {
                        console.warn(`[AUTH] User "${credentials.username}" not found anywhere.`);
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
                        // `name` est repris dans la session : sans lui, l'en-tête ne
                        // pouvait pas afficher qui est connecté.
                        name: user.username,
                        username: user.username,
                        role: user.role,
                    };
                } catch (err: any) {
                    console.error("[AUTH] CRITICAL ERROR during authorize callback:", err.message || err);
                    return null;
                }
            }
        })
    ],
});
