"use client";

import { ChevronDown, LogOut, Moon, Rows3, Sun, User as UserIcon } from "lucide-react";
import { usePathname } from "next/navigation";
import { useTheme } from "next-themes";
import { signOut, useSession } from "next-auth/react";
import { useEffect, useState } from "react";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useGridStore } from "@/features/grid/store/use-grid-store";
import { pageCourante } from "@/components/shared/navigation";

type Densite = "compact" | "normal" | "comfortable";

/**
 * En-tête : nom de la page en cours, choix du thème et menu du compte.
 *
 * La recherche qui s'y trouvait ne filtrait que la Grille (même depuis les autres
 * pages, et en silence) : elle est retirée, la Grille garde la sienne. Le nom
 * affiché est celui de l'utilisateur connecté (il était écrit en dur).
 */
export function Header() {
    const pathname = usePathname();
    const { resolvedTheme, setTheme } = useTheme();
    const { data: session } = useSession();
    const displayDensity = useGridStore((s) => s.displayDensity);
    const setDisplayDensity = useGridStore((s) => s.setDisplayDensity);
    const [isMounted, setIsMounted] = useState(false);

    useEffect(() => {
        // Le thème n'est connu qu'au montage (lu dans le navigateur).
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setIsMounted(true);
    }, []);

    const isDark = isMounted && resolvedTheme === "dark";
    const page = pageCourante(pathname);
    const nom = session?.user?.name ?? "";
    const role = (session?.user as { role?: string } | undefined)?.role === "admin" ? "Administrateur" : "Utilisateur";
    const initiale = nom.trim().charAt(0).toUpperCase() || "?";

    return (
        <header className="h-14 shrink-0 flex items-center justify-between gap-4 px-6 glass border-b border-[var(--border)]">
            <div className="min-w-0">
                {page && (
                    <p className="truncate text-sm font-semibold text-[var(--text-primary)]" title={page.description}>
                        {page.label}
                    </p>
                )}
            </div>

            <div className="flex items-center gap-2">
                <button
                    onClick={() => setTheme(isDark ? "light" : "dark")}
                    className="flex h-9 items-center gap-2 rounded-lg px-3 text-[13px] font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)]"
                    title={isDark ? "Passer en mode clair" : "Passer en mode sombre"}
                >
                    {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
                    <span className="hidden md:inline">{isDark ? "Mode clair" : "Mode sombre"}</span>
                </button>

                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <button
                            className="flex h-9 items-center gap-2 rounded-lg pl-1.5 pr-2 hover:bg-[var(--bg-elevated)]"
                            aria-label="Menu du compte"
                        >
                            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-[var(--accent)] text-xs font-bold text-white">
                                {session ? initiale : <UserIcon className="h-4 w-4" />}
                            </span>
                            <span className="hidden sm:block max-w-[160px] truncate text-[13px] font-medium text-[var(--text-primary)]">
                                {nom}
                            </span>
                            <ChevronDown className="h-4 w-4 text-[var(--text-muted)]" />
                        </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-64">
                        <DropdownMenuLabel>
                            <span className="block text-sm font-semibold text-[var(--text-primary)]">{nom || "Compte"}</span>
                            <span className="block text-xs font-normal text-[var(--text-muted)]">{role}</span>
                        </DropdownMenuLabel>
                        <DropdownMenuSeparator />
                        <DropdownMenuLabel className="flex items-center gap-2 text-xs font-medium text-[var(--text-secondary)]">
                            <Rows3 className="h-3.5 w-3.5" /> Hauteur des lignes de la Grille
                        </DropdownMenuLabel>
                        <DropdownMenuRadioGroup
                            value={displayDensity}
                            onValueChange={(v) => setDisplayDensity(v as Densite)}
                        >
                            <DropdownMenuRadioItem value="compact">Compacte</DropdownMenuRadioItem>
                            <DropdownMenuRadioItem value="normal">Normale</DropdownMenuRadioItem>
                            <DropdownMenuRadioItem value="comfortable">Aérée</DropdownMenuRadioItem>
                        </DropdownMenuRadioGroup>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                            variant="destructive"
                            onSelect={async () => {
                                await signOut({ redirect: false });
                                window.location.href = "/login";
                            }}
                        >
                            <LogOut /> Se déconnecter
                        </DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
            </div>
        </header>
    );
}
