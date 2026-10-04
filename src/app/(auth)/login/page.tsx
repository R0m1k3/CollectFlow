import type { Metadata } from "next";
import { LoginForm } from "@/features/auth/components/login-form";

export const metadata: Metadata = { title: "Connexion" };

export default function LoginPage() {
    return (
        <main className="flex min-h-screen items-center justify-center bg-[var(--bg-base)] p-6">
            <LoginForm />
        </main>
    );
}
