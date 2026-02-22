import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { db } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { verifyPassword } from "@/features/auth/logic/auth-logic";
import { ensureAdminExists } from "@/features/auth/logic/seed-admin";

export const { handlers, auth, signIn, signOut } = NextAuth({
    providers: [
        Credentials({
            name: "Credentials",
            credentials: {
                username: { label: "Utilisateur", type: "text" },
                password: { label: "Mot de passe", type: "password" }
            },
            async authorize(credentials) {
                // S'assure que le compte admin par défaut existe
                await ensureAdminExists();

                if (!credentials?.username || !credentials?.password) return null;

                try {
                    const [user] = await db.select()
                        .from(users)
                        .where(eq(users.username, credentials.username as string));

                    if (!user) return null;

                    const isValid = verifyPassword(credentials.password as string, user.passwordHash);
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
    callbacks: {
        async jwt({ token, user }) {
            if (user) {
                token.role = (user as any).role;
                token.id = user.id;
            }
            return token;
        },
        async session({ session, token }) {
            if (session.user) {
                (session.user as any).role = token.role as string;
                (session.user as any).id = token.id as string;
            }
            return session;
        },
    },
    pages: {
        signIn: "/login",
    }
});
