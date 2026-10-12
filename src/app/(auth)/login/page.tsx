import { Navigate } from "react-router";
import { useSession } from "next-auth/react";
import { LoginForm } from "@/features/auth/components/login-form";

export default function LoginPage() {
    // Déjà connecté : l'accueil (le serveur fait de même pour un accès direct).
    const { status } = useSession();
    if (status === "authenticated") return <Navigate to="/dashboard" replace />;

    return (
        <main className="flex min-h-screen items-center justify-center bg-[var(--bg-base)] p-6">
            <LoginForm />
        </main>
    );
}
