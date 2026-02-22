"use client";

import { LayoutGrid, Camera, FileDown, Settings, Package, BarChart3, LogOut, User as UserIcon, Loader2 } from "lucide-react";
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
            className="w-60 flex-shrink-0 flex flex-col h-screen fixed left-0 top-0 z-30 glass"
            style={{ borderRight: "1px solid var(--border)" }}
        >
            {/* Logo */}
            <div className="px-5 py-[18px]" style={{ borderBottom: "1px solid var(--border)" }}>
                <div className="flex items-center gap-2.5">
                    <div className="w-7 h-7 rounded-[8px] bg-[var(--accent)] flex items-center justify-center shadow-sm border border-white/10">
                        <Package className="w-[15px] h-[15px] text-white" strokeWidth={2.2} />
                    </div>
                    <span className="text-[15px] font-semibold tracking-[-0.3px] text-[var(--text-primary)]">
                        CollectFlow
                    </span>
                </div>
            </div>

            {/* Navigation */}
            <nav className="px-2 pt-2.5 space-y-0.5 flex-1">
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
                            style={{
                                color: isActive ? "var(--text-primary)" : "var(--text-secondary)",
                                background: isActive ? "var(--bg-elevated)" : "transparent",
                            }}
                            className={cn(
                                "flex items-center gap-2.5 px-3 py-[7px] rounded-[8px] text-[13px] font-medium transition-all duration-150",
                                !isActive && "hover:bg-[var(--bg-elevated)]"
                            )}
                        >
                            <Icon className="w-[15px] h-[15px] shrink-0" strokeWidth={1.8} />
                            {label}
                        </Link>
                    );
                })}
            </nav>

            {/* User Profile & Logout */}
            <div className="px-3 pb-3 space-y-2">
                <div className="flex items-center gap-3 px-3 py-3 rounded-xl bg-[var(--bg-elevated)] border border-[var(--border)]">
                    <div className="w-8 h-8 rounded-lg bg-[var(--accent-bg)] flex items-center justify-center border border-[var(--accent-border)]">
                        <UserIcon className="w-4 h-4 text-[var(--accent)]" />
                    </div>
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
                </div>

                <button
                    onClick={async () => {
                        await signOut({ redirect: false });
                        window.location.href = "/login";
                    }}
                    className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-[13px] font-medium text-[var(--accent-error)] hover:bg-[var(--accent-error-bg)] transition-colors"
                >
                    <LogOut className="w-[15px] h-[15px]" strokeWidth={1.8} />
                    Déconnexion
                </button>
            </div>

            {/* Footer */}
            <div className="px-4 py-3" style={{ borderTop: "1px solid var(--border)" }}>
                <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>v1.0.0-beta</p>
            </div>
        </aside>
    );
}
