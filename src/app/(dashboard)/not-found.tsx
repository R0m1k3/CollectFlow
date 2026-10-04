import Link from "next/link";
import { SearchX } from "lucide-react";
import { EmptyState } from "@/components/ui/states";
import { Button } from "@/components/ui/button";

export default function NotFound() {
    return (
        <div className="mx-auto w-full max-w-3xl py-10">
            <EmptyState
                icon={SearchX}
                title="Page introuvable"
                description="L'adresse demandée n'existe pas ou n'existe plus. Utilisez le menu à gauche pour retrouver votre page."
                action={<Button asChild><Link href="/dashboard">Retour à l&apos;accueil</Link></Button>}
            />
        </div>
    );
}
