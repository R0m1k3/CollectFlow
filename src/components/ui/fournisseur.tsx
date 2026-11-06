import { libelleFournisseur, nomFournisseur } from "@/lib/fournisseur";

/** Nom du fournisseur suivi de son code (en chasse fixe, atténué). */
export function Fournisseur({ nom, code, className }: { nom: string | null | undefined; code: string | null | undefined; className?: string }) {
    const c = (code ?? "").trim();
    if (!c) return <span className={className}>{(nom ?? "").trim() || "Sans fournisseur"}</span>;
    const n = nomFournisseur(nom, c);
    return (
        <span className={className} title={libelleFournisseur(nom, c)}>
            {n || <span className="italic text-[var(--text-muted)]">Nom introuvable</span>}{" "}
            <span className="font-mono text-[var(--text-muted)]">{c}</span>
        </span>
    );
}
