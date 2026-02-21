"use client";

import { LayoutGrid, Camera, FileDown, Settings, Package, BarChart3 } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { useGridStore } from "@/features/grid/store/use-grid-store";
import { useEffect, useState } from "react";

const NAV_ITEMS = [
    { icon: LayoutGrid, label: "Grille", href: "/grid" },
    { icon: Camera, label: "Snapshots", href: "/snapshots" },
    { icon: FileDown, label: "Exports", href: "/exports" },
    { icon: BarChart3, label: "Score", href: "/score" },
    { icon: Settings, label: "Paramètres", href: "/settings" },
];

export function Sidebar() {
    const pathname = usePathname();
    const activeGridQuery = useGridStore((s) => s.activeGridQuery);
    const [isMounted, setIsMounted] = useState(false);

    useEffect(() => {
        setIsMounted(true);
    }, []);

    return (
        <aside
            className="w-60 flex-shrink-0 flex flex-col h-screen fixed left-0 top-0 z-30 glass"
            style={{ borderRight: "1px solid var(--border)" }}
        >
            {/* Logo */}
            <div className="px-5 py-[18px]" style={{ borderBottom: "1px solid var(--border)" }}>
                <div className="flex items-center gap-2.5">
                    <div className="w-7 h-7 rounded-[8px] bg-emerald-500 dark:bg-emerald-600 flex items-center justify-center shadow-sm border border-white/10">
                        <Package className="w-[15px] h-[15px] text-white" strokeWidth={2.2} />
                    </div>
                    <span className="text-[15px] font-semibold tracking-[-0.3px]" style={{ color: "var(--text-primary)" }}>
                        CollectFlow
                    </span>
                </div>
            </div>

            {/* Navigation */}
            <nav className="px-2 pt-2.5 space-y-0.5">
                {NAV_ITEMS.map(({ icon: Icon, label, href }) => {
                    const isActive = pathname.startsWith(href);

                    // Restore grid context if navigating back to the grid
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
                            onMouseEnter={(e) => {
                                if (!isActive) (e.currentTarget as HTMLElement).style.background = "var(--bg-elevated)";
                            }}
                            onMouseLeave={(e) => {
                                if (!isActive) (e.currentTarget as HTMLElement).style.background = "transparent";
                            }}
                        >
                            <Icon className="w-[15px] h-[15px] shrink-0" strokeWidth={1.8} />
                            {label}
                        </Link>
                    );
                })}
            </nav>

            {/* Footer */}
            <div className="mt-auto px-4 py-3" style={{ borderTop: "1px solid var(--border)" }}>
                <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>v1.0.0-beta</p>
            </div>
        </aside>
    );
}
