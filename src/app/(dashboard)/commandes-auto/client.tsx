"use client";

import { useMemo } from "react";
import { ShoppingCart } from "lucide-react";
import type { PgCommandeAutoRow } from "./page";
import { Badge, type Ton } from "@/components/ui/badge";
import { DataTable, type DataColumn, type DataFilter } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/states";
import { Terme } from "@/components/ui/tooltip";
import { fmtEntier, fmtEur2 } from "@/lib/format";
import { MAGASINS, nomMagasin } from "@/lib/magasins";

type EtatFranco = "oui" | "non" | "inconnu";

/**
 * Franco atteint ? Sans montant de franco connu (0), on ne peut pas répondre,
 * quel que soit l'indicateur renvoyé par l'API.
 */
function etatFranco(r: PgCommandeAutoRow): EtatFranco {
    if (!(Number(r.franco) > 0)) return "inconnu";
    if (r.franco_atteint === true) return "oui";
    if (r.franco_atteint === false) return "non";
    return "inconnu";
}

const ETATS_FRANCO: Record<EtatFranco, { libelle: string; ton: Ton }> = {
    oui: { libelle: "Oui", ton: "succes" },
    non: { libelle: "Non", ton: "alerte" },
    inconnu: { libelle: "Inconnu", ton: "neutre" },
};

function explicationFranco(r: PgCommandeAutoRow): string {
    switch (etatFranco(r)) {
        case "oui":
            return "Le montant proposé atteint le franco : livraison sans frais de port.";
        case "non":
            return "Le montant proposé n'atteint pas le franco : des frais de port peuvent s'appliquer.";
        default:
            return Number(r.franco) > 0
                ? "Le franco est connu, mais FF n'indique pas s'il est atteint."
                : "Aucun montant de franco connu pour ce fournisseur.";
    }
}

/** Écart entre le montant proposé et le franco, toujours positif. */
function ecartFranco(r: PgCommandeAutoRow): number {
    return Math.abs(Number(r.ecart_franco)) || Math.abs(Number(r.franco) - Number(r.montant_cde)) || 0;
}

function EcartFranco({ r }: { r: PgCommandeAutoRow }) {
    const etat = etatFranco(r);
    const ecart = ecartFranco(r);
    if (etat === "non") {
        return <span className="font-semibold text-[var(--accent-warning)]">Il manque {fmtEur2(ecart)}</span>;
    }
    if (etat === "oui") {
        return <span className="text-[var(--accent-success)]">{ecart > 0 ? `Dépassé de ${fmtEur2(ecart)}` : "Atteint"}</span>;
    }
    return <span className="text-[var(--text-muted)]">—</span>;
}

const somme = (rows: readonly PgCommandeAutoRow[], valeur: (r: PgCommandeAutoRow) => number) =>
    rows.reduce((s, r) => s + (Number(valeur(r)) || 0), 0);

const COLONNES: DataColumn<PgCommandeAutoRow>[] = [
    {
        id: "fournisseur",
        header: "Fournisseur",
        sortValue: (r) => r.nomfou,
        cell: (r) => (
            <div className="min-w-[200px]">
                <div className="font-medium text-[var(--text-primary)]">{r.nomfou || "Fournisseur sans nom"}</div>
                {r.codefou && <div className="text-xs text-[var(--text-muted)]">Code {r.codefou}</div>}
            </div>
        ),
        footer: (rows) => `Total · ${fmtEntier(rows.length)} fournisseur${rows.length > 1 ? "s" : ""}`,
    },
    {
        id: "articles",
        header: "Nb articles",
        align: "right",
        sortValue: (r) => Number(r.nb_articles),
        cell: (r) => fmtEntier(Number(r.nb_articles)),
        footer: (rows) => fmtEntier(somme(rows, (r) => r.nb_articles)),
    },
    {
        id: "montant",
        header: "Montant proposé",
        hint: "Montant hors taxes de la commande automatique proposée par FF.",
        align: "right",
        sortValue: (r) => Number(r.montant_cde),
        cell: (r) => <span className="font-semibold">{fmtEur2(Number(r.montant_cde))}</span>,
        footer: (rows) => fmtEur2(somme(rows, (r) => r.montant_cde)),
    },
    {
        id: "franco",
        header: <Terme id="franco" />,
        align: "right",
        sortValue: (r) => (Number(r.franco) > 0 ? Number(r.franco) : null),
        cell: (r) =>
            Number(r.franco) > 0 ? (
                fmtEur2(Number(r.franco))
            ) : (
                <span className="text-[var(--text-muted)]" title="Aucun montant de franco connu pour ce fournisseur.">—</span>
            ),
    },
    {
        id: "atteint",
        header: "Franco atteint",
        align: "center",
        // Oui avant Non, inconnus toujours en fin de liste.
        sortValue: (r) => {
            const etat = etatFranco(r);
            return etat === "oui" ? 1 : etat === "non" ? 0 : null;
        },
        cell: (r) => {
            const { libelle, ton } = ETATS_FRANCO[etatFranco(r)];
            return <Badge ton={ton} title={explicationFranco(r)}>{libelle}</Badge>;
        },
    },
    {
        id: "ecart",
        header: "Écart au franco",
        hint: "Ce qu'il manque pour atteindre le franco, ou de combien il est dépassé.",
        align: "right",
        sortValue: (r) => {
            const etat = etatFranco(r);
            if (etat === "inconnu") return null;
            return etat === "oui" ? ecartFranco(r) : -ecartFranco(r);
        },
        cell: (r) => <EcartFranco r={r} />,
    },
];

const FILTRES: DataFilter<PgCommandeAutoRow>[] = [
    {
        id: "atteint",
        label: "Franco atteint",
        valueOf: (r) => ETATS_FRANCO[etatFranco(r)].libelle,
        allLabel: "Tous",
    },
];

function SectionMagasin({ nom, rows }: { nom: string; rows: PgCommandeAutoRow[] }) {
    const nbAtteint = rows.filter((r) => etatFranco(r) === "oui").length;
    const totalMontant = somme(rows, (r) => r.montant_cde);

    return (
        <section className="space-y-3" aria-label={`Propositions de commande — ${nom}`}>
            <div className="flex flex-wrap items-center gap-2">
                <h2 className="mr-1 text-lg font-semibold text-[var(--text-primary)]">{nom}</h2>
                <Badge>
                    {fmtEntier(rows.length)} fournisseur{rows.length > 1 ? "s" : ""}
                </Badge>
                {nbAtteint > 0 && (
                    <Badge ton="succes">
                        {fmtEntier(nbAtteint)} franco{nbAtteint > 1 ? "s" : ""} atteint{nbAtteint > 1 ? "s" : ""}
                    </Badge>
                )}
                <span className="text-[13px] text-[var(--text-secondary)]">
                    Montant total proposé :{" "}
                    <span className="font-semibold tabular-nums text-[var(--text-primary)]">{fmtEur2(totalMontant)}</span>
                </span>
            </div>
            <DataTable
                rows={rows}
                columns={COLONNES}
                rowKey={(r) => `${r.site}-${r.codefou}`}
                searchIn={(r) => [r.nomfou, r.codefou]}
                searchPlaceholder="Rechercher un fournisseur…"
                filters={FILTRES}
                pageSize={0}
                unite="fournisseurs"
                showFooter
                initialSort={{ id: "fournisseur", dir: "asc" }}
                emptyTitle="Aucune proposition pour ce magasin"
                emptyDescription="FF ne propose aucune commande automatique pour ce magasin en ce moment."
            />
        </section>
    );
}

export function CommandesAutoClient({ rows }: { rows: PgCommandeAutoRow[] }) {
    const parMagasin = useMemo(() => {
        const map = new Map<string, PgCommandeAutoRow[]>();
        for (const r of rows) {
            if (!map.has(r.site)) map.set(r.site, []);
            map.get(r.site)!.push(r);
        }
        return map;
    }, [rows]);

    if (rows.length === 0) {
        return (
            <EmptyState
                icon={ShoppingCart}
                title="Aucune proposition de commande"
                description="FF ne propose aucune commande automatique pour le moment. Si vous en attendiez, le serveur FF est peut-être momentanément indisponible : rechargez la page dans quelques minutes."
            />
        );
    }

    return (
        <div className="space-y-10">
            {MAGASINS.map((m) => (
                <SectionMagasin key={m.code} nom={nomMagasin(m.code)} rows={parMagasin.get(m.code) ?? []} />
            ))}
        </div>
    );
}
