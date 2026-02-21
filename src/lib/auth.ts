import NextAuth from "next-auth";
import GitHub from "next-auth/providers/github"; // Example provider

export const { handlers, auth, signIn, signOut } = NextAuth({
    providers: [GitHub],
});
