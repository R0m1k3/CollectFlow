"use client";

import { useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useGridStore } from "@/features/grid/store/use-grid-store";
import type { ProductRow } from "@/types/grid";
import { PackageX } from "lucide-react";

function getNoSalesIn6Months(rows: ProductRow[]): ProductRow[] {
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

    return rows.filter(row => {
        if (row.derniereVente) {
            return new Date(row.derniereVente) < sixMonthsAgo;
        }
        // Fallback : calcul depuis sales12m
        const salesMonths = Object.entries(row.sales12m || {})
            .filter(([, qty]) => qty > 0)
            .map(([m]) => m)
            .sort();
        if (salesMonths.length === 0) return true;
        const last = salesMonths[salesMonths.length - 1];
        const lastDate = new Date(parseInt(last.slice(0, 4)), parseInt(last.slice(4, 6)) - 1, 1);
        return lastDate < sixMonthsAgo;
    });
}

function formatDate(iso?: string): string {
    if (!iso) return "—";
    return new Date(iso).toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function daysSince(iso?: string): number | null {
    if (!iso) return null;
    return Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
}

function formatCa(ca: number): string {
    return ca.toLocaleString("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
}

const GAMME_COLORS: Record<string, string> = {
    A: "bg-emerald-500/15 text-emerald-700",
    B: "bg-blue-500/15 text-blue-700",
    C: "bg-amber-500/15 text-amber-700",
    Y: "bg-purple-500/15 text-purple-700",
    Z: "bg-red-500/15 text-red-700",
};

export function NoSalesTab() {
    const rows = useGridStore(s => s.rows);
    const scrollRef = useRef<HTMLDivElement>(null);

    const filtered = useMemo(() => {
        const result = getNoSalesIn6Months(rows);
        // Tri : produits les plus anciens en premier, puis par stock décroissant
        return result.sort((a, b) => {
            const da = a.derniereVente ? new Date(a.derniereVente).getTime() : 0;
            const db = b.derniereVente ? new Date(b.derniereVente).getTime() : 0;
            if (da !== db) return da - db;
            return (b.stockActuel ?? 0) - (a.stockActuel ?? 0);
        });
    }, [rows]);

    // eslint-disable-next-line react-hooks/incompatible-library
    const rowVirtualizer = useVirtualizer({
        count: filtered.length,
        getScrollElement: () => scrollRef.current,
        estimateSize: () => 36,
        overscan: 12,
    });

    if (rows.length === 0) {
        return (
            <div className="flex-1 flex items-center justify-center text-sm italic" style={{ color: "var(--text-muted)" }}>
                Chargement des données en cours…
            </div>
        );
    }

    if (filtered.length === 0) {
        return (
            <div className="flex-1 flex flex-col items-center justify-center gap-3" style={{ color: "var(--text-muted)" }}>
                <PackageX className="w-10 h-10 opacity-30" />
                <p className="text-sm italic">Aucun produit sans vente depuis 6 mois.</p>
            </div>
        );
    }

    return (
        <div className="flex flex-col flex-1 min-h-0 gap-3">
            {/* Résumé */}
            <div className="shrink-0 px-3 py-2 rounded-lg text-sm font-medium flex items-center gap-2"
                style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)", color: "var(--text-secondary)" }}
            >
                <PackageX className="w-4 h-4 shrink-0" style={{ color: "var(--accent)" }} />
                <span>
                    <span className="font-bold" style={{ color: "var(--text-primary)" }}>
                        {filtered.length.toLocaleString("fr-FR")}
                    </span>
                    {" "}produit{filtered.length > 1 ? "s" : ""} sans vente depuis plus de 6 mois
                    {" "}({rows.length.toLocaleString("fr-FR")} références au total)
                </span>
            </div>

            {/* Tableau */}
            <div ref={scrollRef} className="flex-1 min-h-0 overflow-auto rounded-xl" style={{ border: "1px solid var(--border)" }}>
                <div className="min-w-[900px] text-[12px]">
                    <div className="sticky top-0 z-10 grid grid-cols-[90px_minmax(220px,1fr)_120px_76px_130px_70px_90px_110px_70px]"
                        style={{ background: "var(--bg-elevated)", borderBottom: "1px solid var(--border)" }}
                    >
                        {["Code", "Libellé", "Réf.", "Gamme", "Dernière vente", "Jours", "Stock", "CA 12m", "Mag."].map(col => (
                            <div key={col}
                                className="px-3 py-2 text-left font-semibold whitespace-nowrap"
                                style={{ color: "var(--text-muted)" }}
                            >
                                {col}
                            </div>
                        ))}
                    </div>
                    <div style={{ height: rowVirtualizer.getTotalSize(), position: "relative" }}>
                        {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                            const row = filtered[virtualRow.index];
                            const i = virtualRow.index;
                            const days = daysSince(row.derniereVente);
                            const gamme = row.codeGamme?.trim().toUpperCase() ?? "—";
                            const gammeClass = GAMME_COLORS[gamme] ?? "bg-zinc-500/15 text-zinc-600";
                            return (
                                <div
                                    key={row.codein}
                                    className="absolute left-0 right-0 grid grid-cols-[90px_minmax(220px,1fr)_120px_76px_130px_70px_90px_110px_70px] items-center transition-colors hover:bg-white/5"
                                    style={{
                                        height: `${virtualRow.size}px`,
                                        transform: `translateY(${virtualRow.start}px)`,
                                        borderBottom: i < filtered.length - 1 ? "1px solid var(--border)" : undefined,
                                        background: i % 2 === 0 ? "transparent" : "var(--bg-subtle, rgba(0,0,0,0.02))",
                                    }}
                                >
                                    <div className="px-3 py-1.5 font-mono" style={{ color: "var(--text-muted)" }}>{row.codein}</div>
                                    <div className="px-3 py-1.5 truncate" style={{ color: "var(--text-primary)" }} title={row.libelle1}>{row.libelle1}</div>
                                    <div className="px-3 py-1.5 font-mono text-[11px]" style={{ color: "var(--text-muted)" }}>{row.reference || "—"}</div>
                                    <div className="px-3 py-1.5">
                                        <span className={`inline-block px-1.5 py-0.5 rounded text-[11px] font-bold ${gammeClass}`}>
                                            {gamme}
                                        </span>
                                    </div>
                                    <div className="px-3 py-1.5 whitespace-nowrap" style={{ color: row.derniereVente ? "var(--text-secondary)" : "var(--text-muted)" }}>
                                        {formatDate(row.derniereVente)}
                                    </div>
                                    <div className="px-3 py-1.5 text-right font-medium tabular-nums"
                                        style={{ color: days && days > 365 ? "var(--color-red, #ef4444)" : "var(--text-secondary)" }}>
                                        {days != null ? days.toLocaleString("fr-FR") : "—"}
                                    </div>
                                    <div className="px-3 py-1.5 text-right tabular-nums" style={{ color: "var(--text-secondary)" }}>
                                        {row.stockActuel != null ? row.stockActuel.toLocaleString("fr-FR") : "—"}
                                    </div>
                                    <div className="px-3 py-1.5 text-right tabular-nums" style={{ color: "var(--text-secondary)" }}>
                                        {row.totalCa > 0 ? formatCa(row.totalCa) : "—"}
                                    </div>
                                    <div className="px-3 py-1.5 text-right tabular-nums font-semibold"
                                        style={{ color: "var(--text-secondary)" }}>
                                        {row.nbMagasinsReseau != null ? row.nbMagasinsReseau : "—"}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>
            </div>
        </div>
    );
}

/** Compte les produits sans vente depuis 6 mois — utilisé pour le badge dans le switcher */
export function countNoSalesIn6Months(rows: ProductRow[]): number {
    return getNoSalesIn6Months(rows).length;
}
