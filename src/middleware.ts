import NextAuth from "next-auth";
import { authConfig } from "@/lib/auth.config";
import { NextResponse } from "next/server";

const { auth } = NextAuth(authConfig);

export default auth((req) => {
    const isLoggedIn = !!req.auth;
    const { nextUrl } = req;

    const isApiAuthRoute = nextUrl.pathname.startsWith("/api/auth");
    const isPublicRoute = nextUrl.pathname === "/login" || nextUrl.pathname.startsWith("/public");

    // 1. Laisser passer les requêtes d'auth API
    if (isApiAuthRoute) return NextResponse.next();

    // 2. Rediriger vers /login si non connecté et route non publique
    if (!isLoggedIn && !isPublicRoute) {
        return NextResponse.redirect(new URL("/login", nextUrl));
    }

    // 3. Rediriger vers le dashboard si déjà connecté et sur /login
    if (isLoggedIn && isPublicRoute) {
        return NextResponse.redirect(new URL("/dashboard", nextUrl));
    }

    // 4. Protection par rôle (Admin seulement pour les paramètres)
    const isAdminRoute = nextUrl.pathname.startsWith("/settings") || nextUrl.pathname.startsWith("/admin");
    const userRole = (req.auth?.user as any)?.role;

    if (isAdminRoute && userRole !== "admin") {
        return NextResponse.redirect(new URL("/dashboard", nextUrl));
    }

    return NextResponse.next();
});

export const config = {
    // Protège toutes les routes sauf fichiers statiques et assets
    matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.png$|.*\\.jpg$).*)"],
};
