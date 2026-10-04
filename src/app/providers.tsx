"use client";

import { SessionProvider } from "next-auth/react";
import { ThemeProvider } from "@/components/shared/theme-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { FeedbackHost } from "@/components/ui/feedback";

export function Providers({ children }: { children: React.ReactNode }) {
    return (
        // La session n'est pas relue à chaque retour sur l'onglet : elle repartait
        // sur le réseau et redessinait toute la page (Grille comprise) à chaque fois.
        <SessionProvider refetchOnWindowFocus={false}>
            <ThemeProvider>
                <TooltipProvider>
                    {children}
                    <FeedbackHost />
                </TooltipProvider>
            </ThemeProvider>
        </SessionProvider>
    );
}
