"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Search, X } from "lucide-react";

/**
 * Champ de recherche produit.
 *
 * Soumission **explicite** (Entrée ou bouton) et non à la frappe : chaque
 * recherche déclenche deux allers-retours Qlik Sense (recherche des articles
 * puis extraction de leurs mesures sur 12 mois), soit plusieurs secondes.
 * Minimum 3 caractères.
 *
 * L'appelant passe `key={q}` pour que le champ se resynchronise sur l'URL
 * (retour arrière, lien partagé) par remontage, plutôt que par un effet qui
 * appellerait setState en cascade.
 */
export function ProduitSearchBar({ initialQuery }: { initialQuery: string }) {
    const router = useRouter();
    const [term, setTerm] = useState(initialQuery);

    const tooShort = term.trim().length > 0 && term.trim().length < 3;

    function submit() {
        const cleaned = term.trim();
        if (cleaned.length < 3) return;
        router.push(`/produits?q=${encodeURIComponent(cleaned)}`);
    }

    function clear() {
        setTerm("");
        router.push("/produits");
    }

    return (
        <div className="space-y-1.5">
            <div className="flex items-center gap-2">
                <div className="relative flex-1 max-w-xl">
                    <Search
                        className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 pointer-events-none"
                        style={{ color: "var(--text-muted)" }}
                    />
                    <input
                        type="text"
                        value={term}
                        onChange={(e) => setTerm(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
                        placeholder="Libellé produit ou code centrale…"
                        aria-label="Rechercher un produit par libellé ou code centrale"
                        className="apple-input h-10 text-[14px]"
                        style={{ paddingLeft: "38px", paddingRight: term ? "36px" : undefined }}
                    />
                    {term && (
                        <button
                            onClick={clear}
                            aria-label="Effacer la recherche"
                            className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-md p-1 transition-colors hover:bg-[var(--bg-elevated)]"
                            style={{ color: "var(--text-muted)" }}
                        >
                            <X className="w-3.5 h-3.5" />
                        </button>
                    )}
                </div>
                <button
                    onClick={submit}
                    disabled={term.trim().length < 3}
                    className="btn-action btn-action-primary disabled:opacity-50"
                >
                    Rechercher
                </button>
            </div>
            {tooShort && (
                <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>
                    Saisissez au moins 3 caractères.
                </p>
            )}
        </div>
    );
}
