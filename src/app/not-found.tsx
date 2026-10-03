import Link from "next/link";
import { SearchX } from "lucide-react";
import { EmptyState } from "@/components/ui/states";
import { Button } from "@/components/ui/button";

/** Adresse inconnue (hors des pages de l'application). */
export default function NotFound() {
    return (
        <main className="flex min-h-screen items-center justify-center p-6 bg-[var(--bg-base)]">
            <EmptyState
                icon={SearchX}
                title="Page introuvable"
                description="L'adresse demandée n'existe pas ou n'existe plus."
                action={<Button asChild><Link href="/dashboard">Retour à l&apos;accueil</Link></Button>}
                className="max-w-lg"
            />
        </main>
    );
}
