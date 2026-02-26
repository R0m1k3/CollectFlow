"use client";

import { LayoutGrid, Camera, FileDown, Settings, Package, BarChart3, LogOut, User as UserIcon, Loader2, Bot } from "lucide-react";
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

    useEffect(() => {
        setIsMounted(true);
    }, []);

    const userRole = (session?.user as any)?.role;
    const filteredItems = NAV_ITEMS.filter(item => !item.adminOnly || userRole === "admin");

    return (
        <aside
            className="w-16 flex-shrink-0 flex flex-col items-center h-screen fixed left-0 top-0 z-30 glass"
            style={{ borderRight: "1px solid var(--border)" }}
        >
            {/* Logo */}
            <div className="py-[18px] w-full flex justify-center" style={{ borderBottom: "1px solid var(--border)" }}>
                <div className="w-8 h-8 rounded-xl bg-[var(--accent)] flex items-center justify-center shadow-sm border border-white/10" title="CollectFlow">
                    <Package className="w-[18px] h-[18px] text-white" strokeWidth={2.2} />
                </div>
            </div>

            {/* Navigation */}
            <nav className="w-full flex-1 flex flex-col items-center py-4 space-y-2">
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
                            title={label}
                            style={{
                                color: isActive ? "var(--text-primary)" : "var(--text-secondary)",
                                background: isActive ? "var(--bg-elevated)" : "transparent",
                            }}
                            className={cn(
                                "flex items-center justify-center w-10 h-10 rounded-xl transition-all duration-150",
                                !isActive && "hover:bg-[var(--bg-elevated)]"
                            )}
                        >
                            <Icon className="w-[18px] h-[18px] shrink-0" strokeWidth={1.8} />
                        </Link>
                    );
                })}
            </nav>

            {/* User Profile & Logout */}
            <div className="w-full pb-4 flex flex-col items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-[var(--bg-elevated)] border border-[var(--border)] flex items-center justify-center shadow-sm" title={session?.user?.name || "Profil"}>
                    <UserIcon className="w-5 h-5 text-[var(--accent)]" />
                </div>

                <button
                    onClick={async () => {
                        await signOut({ redirect: false });
                        window.location.href = "/login";
                    }}
                    title="Déconnexion"
                    className="w-10 h-10 flex items-center justify-center rounded-xl text-[var(--accent-error)] hover:bg-[var(--accent-error-bg)] transition-colors"
                >
                    <LogOut className="w-[18px] h-[18px]" strokeWidth={1.8} />
                </button>
            </div>
        </aside>
    );
}
