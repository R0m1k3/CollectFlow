"use client";

import { ChevronLeft, ChevronRight, Package } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { cn } from "@/lib/utils";
import { useGridStore } from "@/features/grid/store/use-grid-store";
import { NAV_GROUPS } from "@/components/shared/navigation";
import { Tooltip } from "@/components/ui/tooltip";

const CLE_STOCKAGE = "sidebar_expanded";

/**
 * Menu principal : groupé par usage, déplié par défaut (libellés visibles).
 * Le compte utilisateur et la déconnexion sont dans l'en-tête.
 */
export function Sidebar() {
    const pathname = usePathname();
    const { data: session } = useSession();
    const activeGridQuery = useGridStore((s) => s.activeGridQuery);
    const [isMounted, setIsMounted] = useState(false);
    const [isExpanded, setIsExpanded] = useState(true);

    useEffect(() => {
        // `isMounted` évite un écart d'hydratation (préférence lue dans le navigateur).
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setIsMounted(true);
        try {
            // Seul un repli explicite est mémorisé : par défaut, le menu est déplié.
            if (localStorage.getItem(CLE_STOCKAGE) === "false") setIsExpanded(false);
        } catch {
            /* stockage indisponible : on garde le menu déplié */
        }
    }, []);

    const toggleSidebar = () => {
        const next = !isExpanded;
        setIsExpanded(next);
        try {
            localStorage.setItem(CLE_STOCKAGE, String(next));
        } catch {
            /* préférence non mémorisée, sans conséquence */
        }
    };

    const isAdmin = (session?.user as { role?: string } | undefined)?.role === "admin";
    const groupes = NAV_GROUPS
        .map((g) => ({ ...g, items: g.items.filter((i) => !i.adminOnly || isAdmin) }))
        .filter((g) => g.items.length > 0);

    return (
        <aside
            className={cn(
                "flex-shrink-0 flex flex-col h-screen z-30 glass transition-[width] duration-200 relative border-r border-[var(--border)]",
                isExpanded ? "w-[272px]" : "w-16",
            )}
            aria-label="Menu principal"
        >
            <button
                onClick={toggleSidebar}
                aria-label={isExpanded ? "Replier le menu" : "Déplier le menu"}
                title={isExpanded ? "Replier le menu" : "Déplier le menu"}
                className="absolute -right-3 top-5 z-40 flex h-6 w-6 items-center justify-center rounded-full border shadow-sm bg-[var(--bg-surface)] border-[var(--border-strong)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            >
                {isExpanded ? <ChevronLeft className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            </button>

            {/* Logo */}
            <div className={cn("flex h-14 items-center border-b border-[var(--border)]", isExpanded ? "px-5" : "justify-center")}>
                <Link href="/dashboard" className="flex items-center gap-2.5" title="CollectFlow — accueil">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-[var(--accent)] shadow-sm">
                        <Package className="h-[18px] w-[18px] text-white" strokeWidth={2.2} />
                    </div>
                    {isExpanded && <span className="text-base font-semibold text-[var(--text-primary)]">CollectFlow</span>}
                </Link>
            </div>

            {/* Navigation */}
            <nav className={cn("flex-1 overflow-y-auto py-3", isExpanded ? "px-3" : "px-2")}>
                {groupes.map((groupe, gi) => (
                    <div key={groupe.title} className={cn(gi > 0 && "mt-4")}>
                        {isExpanded ? (
                            <p className="mb-1 px-3 text-xs font-semibold text-[var(--text-muted)]">{groupe.title}</p>
                        ) : (
                            gi > 0 && <div className="mx-2 mb-3 border-t border-[var(--border)]" aria-hidden />
                        )}
                        <ul className="space-y-0.5">
                            {groupe.items.map(({ icon: Icon, label, href, description }) => {
                                const isActive = pathname === href || pathname.startsWith(`${href}/`);
                                // Retour à la Grille : on rouvre le dernier fournisseur consulté.
                                const resolvedHref = href === "/grid" && isMounted && activeGridQuery
                                    ? `/grid${activeGridQuery}`
                                    : href;
                                const lien = (
                                    <Link
                                        href={resolvedHref}
                                        aria-current={isActive ? "page" : undefined}
                                        className={cn(
                                            "flex items-center rounded-lg transition-colors",
                                            isExpanded ? "gap-3 px-3 py-2" : "h-10 w-10 justify-center mx-auto",
                                            isActive
                                                ? "bg-[var(--accent-bg)] text-[var(--text-primary)] font-semibold"
                                                : "text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)]",
                                        )}
                                    >
                                        <Icon
                                            className={cn("h-[18px] w-[18px] shrink-0", isActive && "text-[var(--accent)]")}
                                            strokeWidth={1.9}
                                            aria-hidden
                                        />
                                        {isExpanded ? (
                                            <span className="truncate text-sm">{label}</span>
                                        ) : (
                                            <span className="sr-only">{label}</span>
                                        )}
                                    </Link>
                                );
                                return (
                                    <li key={href}>
                                        {isExpanded ? lien : (
                                            <Tooltip
                                                side="right"
                                                content={<><span className="font-semibold">{label}</span><span className="block text-[var(--text-secondary)]">{description}</span></>}
                                            >
                                                {lien}
                                            </Tooltip>
                                        )}
                                    </li>
                                );
                            })}
                        </ul>
                    </div>
                ))}
            </nav>
        </aside>
    );
}
