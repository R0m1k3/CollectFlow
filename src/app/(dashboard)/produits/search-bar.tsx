"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/form-controls";

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
            <label htmlFor="recherche-produit" className="block text-sm font-medium text-[var(--text-primary)]">
                Nom du produit ou code centrale
            </label>
            <div className="flex flex-wrap items-center gap-2">
                <div className="relative w-full max-w-xl flex-1">
                    <Search
                        className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]"
                        aria-hidden
                    />
                    <Input
                        id="recherche-produit"
                        type="text"
                        value={term}
                        onChange={(e) => setTerm(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
                        placeholder="Ex. « poêle 28 » ou « 10000167303 »"
                        aria-describedby={tooShort ? "recherche-produit-aide" : undefined}
                        className="h-10 w-full pl-9 pr-9"
                    />
                    {term && (
                        <button
                            type="button"
                            onClick={clear}
                            aria-label="Effacer la recherche"
                            className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)]"
                        >
                            <X className="h-4 w-4" />
                        </button>
                    )}
                </div>
                <Button onClick={submit} disabled={term.trim().length < 3} className="h-10">
                    <Search /> Rechercher
                </Button>
            </div>
            {tooShort && (
                <p id="recherche-produit-aide" className="text-[13px] text-[var(--text-secondary)]">
                    Saisissez au moins 3 caractères.
                </p>
            )}
        </div>
    );
}
