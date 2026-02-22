import { LoginForm } from "@/features/auth/components/login-form";

export default function LoginPage() {
    return (
        <main className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-slate-950 p-6 relative overflow-hidden">
            {/* Éléments de design en arrière-plan pour l'effet "Apple Premium" */}
            <div className="absolute top-0 left-0 w-full h-full overflow-hidden pointer-events-none z-0">
                <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-indigo-500/10 dark:bg-indigo-500/5 blur-[120px] rounded-full" />
                <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-emerald-500/10 dark:bg-emerald-500/5 blur-[120px] rounded-full" />
            </div>

            <div className="relative z-10 w-full flex justify-center">
                <LoginForm />
            </div>
        </main>
    );
}
