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
                    const [user] = await db.select()
                        .from(users)
                        .where(eq(users.username, credentials.username as string));

                    console.log(`BMAD: Auth attempt for "${credentials.username}". User found: ${!!user}`);

                    if (!user) return null;

                    const isValid = verifyPassword(credentials.password as string, user.passwordHash);
                    console.log(`BMAD: Password valid for "${credentials.username}": ${isValid}`);

                    if (!isValid) return null;

                    return {
                        id: user.id.toString(),
                        name: user.username,
                        role: user.role,
                    };
                } catch (err) {
                    console.error("Auth Error:", err);
                    return null;
                }
            }
        })
    ],
});
