import Link from "next/link";
import { PackageSearch, Wifi, WifiOff } from "lucide-react";
import type { PgProduitSearchRow } from "@/lib/pg-ff-client";

function fmtQte(v: number): string {
    return new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 }).format(v);
}

/** Liste des résultats de recherche. */
export function ProduitResults({ rows, query }: { rows: PgProduitSearchRow[]; query: string }) {
    if (!query) {
        return (
            <div
                className="rounded-xl p-10 text-center"
                style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)" }}
            >
                <PackageSearch className="w-8 h-8 mx-auto mb-3" style={{ color: "var(--text-muted)" }} strokeWidth={1.5} />
                <p className="text-[14px] font-medium" style={{ color: "var(--text-secondary)" }}>
                    Recherchez un produit
                </p>
                <p className="text-[12px] mt-1" style={{ color: "var(--text-muted)" }}>
                    Saisissez un libellé (ex. « poêle 28 ») ou un code centrale (ex. « 10000167303 »).
                </p>
            </div>
        );
    }

    if (rows.length === 0) {
        return (
            <div
                className="rounded-xl p-8 text-center text-[13px]"
                style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)", color: "var(--text-muted)" }}
            >
                Aucun produit ne correspond à « {query} ».
            </div>
        );
    }

    return (
        <div className="space-y-2">
            <p className="text-[12px]" style={{ color: "var(--text-muted)" }}>
                {rows.length} produit{rows.length > 1 ? "s" : ""} trouvé{rows.length > 1 ? "s" : ""}
                {rows.length >= 50 && " (50 premiers — affinez la recherche)"}
            </p>

            <div className="overflow-x-auto rounded-xl" style={{ border: "1px solid var(--border)" }}>
                <table className="w-full text-[13px] border-collapse">
                    <thead>
                        <tr style={{ background: "var(--bg-elevated)" }}>
                            <Th>Libellé</Th>
                            <Th>Fournisseur</Th>
                            <Th>Code article</Th>
                            <Th>Code centrale</Th>
                            <Th>Famille</Th>
                            <Th align="right">Stock</Th>
                            <Th align="right">Qté réseau</Th>
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map((r) => (
                            <tr
                                key={r.codein}
                                className="transition-colors hover:bg-[var(--bg-elevated)]"
                                style={{ borderTop: "1px solid var(--border)" }}
                            >
                                <td className="px-3 py-2">
                                    <Link
                                        href={`/produits?codein=${encodeURIComponent(r.codein)}&q=${encodeURIComponent(query)}`}
                                        className="font-medium hover:underline"
                                        style={{ color: "var(--accent)" }}
                                    >
                                        {r.libelle1 || "—"}
                                    </Link>
                                </td>
                                <td className="px-3 py-2" style={{ color: "var(--text-secondary)" }}>
                                    {r.fournisseur || "—"}
                                </td>
                                <td className="px-3 py-2 font-mono text-[12px]" style={{ color: "var(--text-muted)" }}>
                                    {r.codein}
                                </td>
                                <td className="px-3 py-2 font-mono text-[12px]" style={{ color: "var(--text-muted)" }}>
                                    {r.code_centrale || "—"}
                                </td>
                                <td className="px-3 py-2 text-[12px]" style={{ color: "var(--text-secondary)" }}>
                                    {r.nomenclature || "—"}
                                </td>
                                <td className="px-3 py-2 text-right tabular-nums" style={{ color: "var(--text-secondary)" }}>
                                    {fmtQte(r.stock_total)}
                                </td>
                                <td className="px-3 py-2 text-right tabular-nums">
                                    {r.has_reseau ? (
                                        <span className="inline-flex items-center gap-1.5" style={{ color: "var(--text-secondary)" }}>
                                            <Wifi className="w-3 h-3" style={{ color: "var(--accent-success)" }} />
                                            {fmtQte(r.qte_reseau)}
                                            <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>
                                                / {r.nb_magasins_reseau} mag.
                                            </span>
                                        </span>
                                    ) : (
                                        <span
                                            className="inline-flex items-center gap-1.5 text-[11px]"
                                            style={{ color: "var(--text-muted)" }}
                                            title="Données réseau Qlik non synchronisées pour ce produit"
                                        >
                                            <WifiOff className="w-3 h-3" />
                                            non synchro
                                        </span>
                                    )}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}

function Th({ children, align = "left" }: { children: React.ReactNode; align?: "left" | "right" }) {
    return (
        <th
            // Classes littérales : Tailwind ne génère pas les classes construites dynamiquement.
            className={`px-3 py-2.5 ${align === "right" ? "text-right" : "text-left"} text-[11px] font-semibold uppercase tracking-wide whitespace-nowrap`}
            style={{ color: "var(--text-muted)" }}
        >
            {children}
        </th>
    );
}
