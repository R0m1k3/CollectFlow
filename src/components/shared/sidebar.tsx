"use client";

import { LayoutGrid, Camera, FileDown, Settings, Package, BarChart3, LogOut, User as UserIcon, Loader2, Bot, ChevronRight, ChevronLeft } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { useGridStore } from "@/features/grid/store/use-grid-store";
import { useEffect, useState } from "react";
import { useSession, signOut } from "next-auth/react";

const NAV_ITEMS = [
    { icon: LayoutGrid, label: "Grille", href: "/grid" },
    { icon: Camera, label: "Snapshots", href: "/snapshots" },
    { icon: FileDown, label: "Exports", href: "/exports" },
    { icon: BarChart3, label: "Score", href: "/score" },
    { icon: Bot, label: "Aide IA", href: "/docs/ai-analysis" },
    { icon: Settings, label: "Paramètres", href: "/settings", adminOnly: true },
];

export function Sidebar() {
    const pathname = usePathname();
    const { data: session } = useSession();
    const activeGridQuery = useGridStore((s) => s.activeGridQuery);
    const [isMounted, setIsMounted] = useState(false);
    const [isExpanded, setIsExpanded] = useState(false);

    useEffect(() => {
        setIsMounted(true);
        // Load expanded state from local storage
        const stored = localStorage.getItem("sidebar_expanded");
        if (stored === "true") setIsExpanded(true);
    }, []);

    const toggleSidebar = () => {
        const next = !isExpanded;
        setIsExpanded(next);
        localStorage.setItem("sidebar_expanded", String(next));
    };

    const userRole = (session?.user as any)?.role;
    const filteredItems = NAV_ITEMS.filter(item => !item.adminOnly || userRole === "admin");

    return (
        <aside
            className={cn(
                "flex-shrink-0 flex flex-col h-screen z-30 glass transition-all duration-300 relative",
                isExpanded ? "w-60" : "w-16 items-center"
            )}
            style={{ borderRight: "1px solid var(--border)" }}
        >
            {/* Toggle Button */}
            <button
                onClick={toggleSidebar}
                className="absolute -right-3 top-6 w-6 h-6 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-full flex items-center justify-center shadow-sm text-slate-500 hover:text-slate-800 dark:hover:text-slate-300 transition-colors z-40"
            >
                {isExpanded ? <ChevronLeft className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
            </button>

            {/* Logo */}
            <div className={cn("py-[18px] w-full flex", isExpanded ? "px-5" : "justify-center")} style={{ borderBottom: "1px solid var(--border)" }}>
                <div className="flex items-center gap-2.5">
                    <div className="w-8 h-8 rounded-xl bg-[var(--accent)] flex items-center justify-center shrink-0 shadow-sm border border-white/10" title="CollectFlow">
                        <Package className="w-[18px] h-[18px] text-white" strokeWidth={2.2} />
                    </div>
                    {isExpanded && (
                        <span className="text-[15px] font-semibold tracking-[-0.3px] text-[var(--text-primary)] whitespace-nowrap overflow-hidden">
                            CollectFlow
                        </span>
                    )}
                </div>
            </div>

            {/* Navigation */}
            <nav className={cn("w-full flex-1 flex flex-col py-4 space-y-2", isExpanded ? "px-2" : "items-center px-0")}>
                {filteredItems.map(({ icon: Icon, label, href }) => {
                    const isActive = pathname.startsWith(href);

                    let resolvedHref = href;
                    if (href === "/grid" && isMounted && activeGridQuery) {
                        resolvedHref = `/grid${activeGridQuery}`;
                    }

                    return (
                        <Link
                            key={href}
                            href={resolvedHref}
                            title={!isExpanded ? label : undefined}
                            style={{
                                color: isActive ? "var(--text-primary)" : "var(--text-secondary)",
                                background: isActive ? "var(--bg-elevated)" : "transparent",
                            }}
                            className={cn(
                                "flex items-center rounded-xl transition-all duration-150 overflow-hidden",
                                isExpanded ? "px-3 py-[7px] gap-2.5 w-full" : "justify-center w-10 h-10",
                                !isActive && "hover:bg-[var(--bg-elevated)]"
                            )}
                        >
                            <Icon className={cn("shrink-0", isExpanded ? "w-[15px] h-[15px]" : "w-[18px] h-[18px]")} strokeWidth={1.8} />
                            {isExpanded && <span className="text-[13px] font-medium whitespace-nowrap">{label}</span>}
                        </Link>
                    );
                })}
            </nav>

            {/* User Profile & Logout */}
            <div className={cn("w-full pb-4 flex flex-col gap-3", isExpanded ? "px-3" : "items-center")}>
                <div className={cn(
                    "rounded-xl bg-[var(--bg-elevated)] border border-[var(--border)] flex items-center shadow-sm overflow-hidden",
                    isExpanded ? "px-3 py-3 gap-3 w-full" : "justify-center w-10 h-10"
                )}
                    title={!isExpanded ? (session?.user?.name || "Profil") : undefined}
                >
                    <div className={cn(
                        "rounded-lg bg-[var(--accent-bg)] flex items-center justify-center border border-[var(--accent-border)] shrink-0",
                        isExpanded ? "w-8 h-8" : "w-6 h-6 border-transparent bg-transparent"
                    )}>
                        <UserIcon className={cn("text-[var(--accent)]", isExpanded ? "w-4 h-4" : "w-5 h-5")} />
                    </div>
                    {isExpanded && (
                        <div className="flex-1 min-w-0">
                            {session?.user ? (
                                <>
                                    <p className="text-[12px] font-bold text-[var(--text-primary)] truncate">{session.user.name}</p>
                                    <p className="text-[10px] uppercase font-black text-[var(--text-muted)] tracking-wider">
                                        {userRole === "admin" ? "Administrateur" : "Utilisateur"}
                                    </p>
                                </>
                            ) : (
                                <div className="flex items-center gap-2">
                                    <Loader2 className="w-3 h-3 animate-spin text-[var(--accent)]" />
                                    <p className="text-[10px] text-[var(--text-muted)] animate-pulse">Session...</p>
                                </div>
                            )}
                        </div>
                    )}
                </div>

                <button
                    onClick={async () => {
                        await signOut({ redirect: false });
                        window.location.href = "/login";
                    }}
                    title={!isExpanded ? "Déconnexion" : undefined}
                    className={cn(
                        "flex items-center text-[var(--accent-error)] hover:bg-[var(--accent-error-bg)] transition-colors rounded-xl overflow-hidden",
                        isExpanded ? "w-full gap-2.5 px-3 py-2 text-[13px] font-medium" : "justify-center w-10 h-10"
                    )}
                >
                    <LogOut className={cn("shrink-0", isExpanded ? "w-[15px] h-[15px]" : "w-[18px] h-[18px]")} strokeWidth={1.8} />
                    {isExpanded && "Déconnexion"}
                </button>
            </div>
        </aside>
    );
}
