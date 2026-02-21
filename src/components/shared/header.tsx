"use client";

import { Search, X, Sun, Moon } from "lucide-react";
import { useTheme } from "next-themes";
import { useGridStore } from "@/features/grid/store/use-grid-store";

export function Header() {
    const { resolvedTheme, setTheme } = useTheme();
    const setFilter = useGridStore((s) => s.setFilter);
    const search = useGridStore((s) => s.filters.search);
    const isDark = resolvedTheme === "dark";

    return (
        <header
            className="h-12 flex items-center justify-between px-5 sticky top-0 z-20 glass"
            style={{ borderBottom: "1px solid var(--border)" }}
        >
            {/* Search */}
            <div className="relative w-72">
                <Search
                    className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5"
                    style={{ color: "var(--text-muted)" }}
                    strokeWidth={2}
                />
                <input
                    type="search"
                    placeholder="Rechercher…"
                    value={search}
                    onChange={(e) => setFilter("search", e.target.value)}
                    className="apple-input pr-8 h-8 text-[13px]"
                    style={{ paddingLeft: "32px" }}
                />
                {search && (
                    <button
                        onClick={() => setFilter("search", "")}
                        className="absolute right-2.5 top-1/2 -translate-y-1/2"
                    >
                        <X className="w-3 h-3" style={{ color: "var(--text-muted)" }} />
                    </button>
                )}
            </div>

            {/* Right controls */}
            <div className="flex items-center gap-2">
                {/* Theme toggle */}
                <button
                    onClick={() => setTheme(isDark ? "light" : "dark")}
                    title={isDark ? "Mode clair" : "Mode sombre"}
                    className="w-8 h-8 rounded-[8px] flex items-center justify-center transition-all duration-150"
                    style={{ color: "var(--text-secondary)" }}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "var(--bg-elevated)"; }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
                >
                    {isDark
                        ? <Sun className="w-[15px] h-[15px]" strokeWidth={1.8} />
                        : <Moon className="w-[15px] h-[15px]" strokeWidth={1.8} />}
                </button>

                {/* Divider */}
                <div className="w-px h-5 mx-1" style={{ background: "var(--border)" }} />

                {/* User */}
                <div className="flex items-center gap-2">
                    <div className="w-[26px] h-[26px] rounded-full bg-emerald-500 dark:bg-emerald-600 flex items-center justify-center text-[11px] font-bold text-white shadow-sm border border-white/20">
                        M
                    </div>
                    <span className="text-[13px] font-medium" style={{ color: "var(--text-secondary)" }}>
                        Michael
                    </span>
                </div>
            </div>
        </header>
    );
}
