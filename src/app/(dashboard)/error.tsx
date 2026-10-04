"use client";

import { useEffect } from "react";
import { RotateCcw } from "lucide-react";
import { ErrorState } from "@/components/ui/states";
import { Button } from "@/components/ui/button";

/**
 * Erreur inattendue dans une page : message compréhensible et bouton pour
 * réessayer, au lieu de l'écran d'erreur générique de Next.js. Le menu et
 * l'en-tête restent utilisables.
 */
export default function DashboardError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
    useEffect(() => {
        console.error("[page] erreur non rattrapée :", error);
    }, [error]);

    return (
        <div className="mx-auto w-full max-w-3xl py-10">
            <ErrorState
                title="Cette page n'a pas pu s'afficher"
                description="Un problème est survenu pendant le chargement des données. Réessayez ; si l'erreur revient, prévenez un administrateur."
                detail={error.digest ? `${error.message}\nRéférence : ${error.digest}` : error.message}
                action={<Button onClick={reset}><RotateCcw /> Réessayer</Button>}
            />
        </div>
    );
}
