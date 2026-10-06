"use client";

import { useMemo, useTransition } from "react";
import { useRouter } from "next/navigation";
import { History, Info, Megaphone, RotateCcw } from "lucide-react";
import type { Publicite, PubliciteHistorique } from "./page";
import { Badge, StoreBadge, type Ton } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable, type DataColumn, type DataFilter } from "@/components/ui/data-table";
import { Select, type SelectOption } from "@/components/ui/form-controls";
import { Pagination } from "@/components/ui/pagination";
import { ErrorState } from "@/components/ui/states";
import { Tabs, useUrlTab } from "@/components/ui/tabs";
import { Terme, InfoBulle } from "@/components/ui/tooltip";
import { fmtDecimal1, fmtEntier, fmtEur2 } from "@/lib/format";
import { nomMagasin } from "@/lib/magasins";
import { cn } from "@/lib/utils";

type Vue = "publicites" | "historique";

const STATUTS: Record<string, { libelle: string; ton: Ton }> = {
    en_cours: { libelle: "En cours", ton: "succes" },
    passee: { libelle: "Passée", ton: "neutre" },
    // Le filtre envoie `passees` à l'API : la même valeur peut revenir sur les lignes.
    passees: { libelle: "Passée", ton: "neutre" },
    a_venir: { libelle: "À venir", ton: "accent" },
};

const OPTIONS_STATUT: SelectOption[] = [
    { value: "toutes", label: "Toutes" },
    { value: "en_cours", label: "En cours" },
    { value: "passees", label: "Passées" },
    { value: "a_venir", label: "À venir" },
];

/** Pourquoi la liste est vide, selon le statut choisi. */
const VIDE_PAR_STATUT: Record<string, string> = {
    toutes: "Aucune opération publicitaire n'est enregistrée pour le moment.",
    en_cours: "Aucune opération publicitaire n'est en cours en ce moment.",
    passees: "Aucune opération publicitaire passée n'a été trouvée.",
    a_venir: "Aucune opération publicitaire à venir n'est encore enregistrée.",
};

const EXPLICATION_CA_PUB =
    "Chiffre d'affaires réalisé sur les produits de l'opération pendant sa durée (du premier au dernier jour de la publicité).";

function fmtDate(iso: string | null | undefined): string {
    if (!iso) return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric" });
}

/** Les montants de l'API arrivent parfois en texte : valeur absente ou illisible = 0. */
function nombre(v: number | string | null | undefined): number {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
}

function somme<T>(rows: readonly T[], valeur: (r: T) => number | string | null | undefined): number {
    return rows.reduce((s, r) => s + nombre(valeur(r)), 0);
}

const libelleStatut = (statut?: string) => STATUTS[statut ?? ""]?.libelle ?? statut ?? "";
/** `passee` et `passees` désignent le même statut. */
const cleStatut = (statut?: string) => (statut === "passees" ? "passee" : statut || null);

/** Libellé suivi d'un « i » : explication libre au survol (hors glossaire). */

function StatutBadge({ statut }: { statut?: string }) {
    const s = STATUTS[statut ?? ""];
    if (s) return <Badge ton={s.ton}>{s.libelle}</Badge>;
    return statut ? <Badge>{statut}</Badge> : <span className="text-[var(--text-muted)]">—</span>;
}

/** Intitulé d'abord, code de l'opération en petit dessous. */
function Operation({ intitule, code }: { intitule: string; code: string }) {
    return (
        <div className="min-w-[140px] sm:min-w-[220px]">
            <div className="font-medium text-[var(--text-primary)]">{intitule || "Opération sans intitulé"}</div>
            {code && <div className="text-xs text-[var(--text-muted)]">Code {code}</div>}
        </div>
    );
}

/** Part du CA total : mise en avant à partir de 10 %, puis de 20 %. */
function PartCa({ pct }: { pct: number }) {
    return (
        <span
            className={cn(
                pct >= 20 ? "font-semibold text-[var(--accent)]" : pct >= 10 ? "font-semibold" : "text-[var(--text-secondary)]",
            )}
        >
            {fmtDecimal1(pct)} %
        </span>
    );
}

/** Pied de la colonne « Part du CA total » : somme du CA pub / somme du CA total. */
function PartCaTotal({ rows }: { rows: readonly Publicite[] }) {
    const caPub = somme(rows, (r) => r.ca_pub_periode_pub);
    const caTotal = somme(rows, (r) => r.ca_total_periode_pub);
    if (caTotal <= 0) {
        return <span className="text-[var(--text-muted)]" title="Chiffre d'affaires total inconnu : la part ne peut pas être calculée.">—</span>;
    }
    return (
        <InfoBulle explication="Somme du CA pub période des lignes affichées, divisée par la somme de leur CA total sur les mêmes périodes.">
            {fmtDecimal1((caPub / caTotal) * 100)} %
        </InfoBulle>
    );
}

interface Props {
    vueInitiale: Vue;
    statut: string;
    page: number;
    pageSize: number;
    publicites: Publicite[];
    total: number;
    pages: number;
    erreurPublicites?: string;
    historique: PubliciteHistorique[];
    erreurHistorique?: string;
}

export function PublicitesClient({
    vueInitiale,
    statut,
    page,
    pageSize,
    publicites,
    total,
    pages,
    erreurPublicites,
    historique,
    erreurHistorique,
}: Props) {
    const router = useRouter();
    const [chargement, startTransition] = useTransition();
    const [vue, setVue] = useUrlTab<Vue>("vue", vueInitiale);

    function naviguer(changements: { statut?: string; page?: number }) {
        const sp = new URLSearchParams({ vue, statut, page: String(page) });
        if (changements.statut !== undefined) sp.set("statut", changements.statut);
        if (changements.page !== undefined) sp.set("page", String(changements.page));
        startTransition(() => router.push(`/publicites?${sp}`));
    }

    const reessayer = (
        <Button variant="outline" onClick={() => startTransition(() => router.refresh())} disabled={chargement}>
            <RotateCcw /> Réessayer
        </Button>
    );

    const validPublicites = useMemo(() => publicites.filter((p) => p.site !== "000"), [publicites]);
    const plusieursSites = useMemo(() => new Set(validPublicites.map((p) => p.site).filter(Boolean)).size > 1, [validPublicites]);
    const paginee = pages > 1;

    const filtresPublicites = useMemo<DataFilter<Publicite>[]>(
        () =>
            plusieursSites
                ? [{ id: "site", label: "Magasin", valueOf: (p) => p.site || null, optionLabel: (code) => nomMagasin(code), allLabel: "Tous les magasins" }]
                : [],
        [plusieursSites],
    );

    const colonnesPublicites = useMemo<DataColumn<Publicite>[]>(
        () => [
            {
                id: "operation",
                header: "Opération",
                sortValue: (p) => p.intitule,
                cell: (p) => <Operation intitule={p.intitule} code={p.tcr_code} />,
                sticky: true,
                grow: true,
                footer: (rows) =>
                    `Total${paginee ? " de la page" : ""} · ${fmtEntier(rows.length)} publicité${rows.length > 1 ? "s" : ""}`,
            },
            {
                id: "statut",
                header: "Statut",
                sortValue: (p) => libelleStatut(p.statut),
                cell: (p) => <StatutBadge statut={p.statut} />,
            },
            {
                id: "site",
                header: "Magasin",
                sortValue: (p) => (p.site ? nomMagasin(p.site) : null),
                cell: (p) => (p.site ? <StoreBadge code={p.site} /> : <span className="text-[var(--text-muted)]">—</span>),
            },
            {
                id: "debut",
                header: "Début",
                sortValue: (p) => p.date_debut,
                cell: (p) => fmtDate(p.date_debut),
                className: "whitespace-nowrap tabular-nums",
            },
            {
                id: "fin",
                header: "Fin",
                sortValue: (p) => p.date_fin,
                cell: (p) => fmtDate(p.date_fin),
                className: "whitespace-nowrap tabular-nums",
            },
            {
                id: "caPub",
                header: <InfoBulle explication={EXPLICATION_CA_PUB}>CA pub période</InfoBulle>,
                align: "right",
                sortValue: (p) => nombre(p.ca_pub_periode_pub),
                cell: (p) => <span className="font-semibold">{fmtEur2(nombre(p.ca_pub_periode_pub))}</span>,
                footer: (rows) => fmtEur2(somme(rows, (r) => r.ca_pub_periode_pub)),
            },
            {
                id: "partCa",
                header: <Terme id="partCaTotal" />,
                align: "right",
                sortValue: (p) => nombre(p.pourc_capub_catotal),
                cell: (p) => <PartCa pct={nombre(p.pourc_capub_catotal)} />,
                footer: (rows) => <PartCaTotal rows={rows} />,
            },
            {
                id: "quantite",
                header: "Quantité vendue",
                align: "right",
                sortValue: (p) => nombre(p.qte_vendue_pub),
                cell: (p) => fmtEntier(nombre(p.qte_vendue_pub)),
                footer: (rows) => fmtEntier(somme(rows, (r) => r.qte_vendue_pub)),
            },
            {
                id: "clients",
                header: "Clients",
                align: "right",
                sortValue: (p) => nombre(p.client_pub_periode),
                cell: (p) => fmtEntier(nombre(p.client_pub_periode)),
            },
            {
                id: "tauxSortie",
                header: <Terme id="tauxSortie" />,
                align: "right",
                sortValue: (p) => nombre(p.taux_sortie),
                cell: (p) => `${fmtDecimal1(nombre(p.taux_sortie))} %`,
            },
            {
                id: "articles",
                header: "Nb articles",
                align: "right",
                sortValue: (p) => nombre(p.nb_articles),
                cell: (p) => fmtEntier(nombre(p.nb_articles)),
            },
        ],
        [paginee],
    );

    const filtresHistorique = useMemo<DataFilter<PubliciteHistorique>[]>(
        () => [{ id: "statut", label: "Statut", valueOf: (h) => cleStatut(h.statut), optionLabel: (s) => libelleStatut(s), allLabel: "Tous" }],
        [],
    );

    const colonnesHistorique = useMemo<DataColumn<PubliciteHistorique>[]>(
        () => [
            {
                id: "operation",
                header: "Opération",
                sortValue: (h) => h.intitule,
                cell: (h) => <Operation intitule={h.intitule} code={h.tcr_code} />,
                sticky: true,
                grow: true,
                footer: (rows) => `Total · ${fmtEntier(rows.length)} opération${rows.length > 1 ? "s" : ""}`,
            },
            {
                id: "statut",
                header: "Statut",
                sortValue: (h) => libelleStatut(h.statut),
                cell: (h) => <StatutBadge statut={h.statut} />,
            },
            {
                id: "debut",
                header: "Début",
                sortValue: (h) => h.date_debut,
                cell: (h) => fmtDate(h.date_debut),
                className: "whitespace-nowrap tabular-nums",
            },
            {
                id: "fin",
                header: "Fin",
                sortValue: (h) => h.date_fin,
                cell: (h) => fmtDate(h.date_fin),
                className: "whitespace-nowrap tabular-nums",
            },
            {
                id: "magasins",
                header: "Magasins",
                hint: "Nombre de magasins concernés par l'opération.",
                align: "right",
                sortValue: (h) => nombre(h.nb_sites),
                cell: (h) => fmtEntier(nombre(h.nb_sites)),
            },
            {
                id: "ca",
                header: "CA total",
                hint: "Chiffre d'affaires de l'opération, tous magasins confondus.",
                align: "right",
                sortValue: (h) => nombre(h.ca_total),
                cell: (h) => <span className="font-semibold">{fmtEur2(nombre(h.ca_total))}</span>,
                footer: (rows) => fmtEur2(somme(rows, (r) => r.ca_total)),
            },
            {
                id: "quantite",
                header: "Quantité vendue",
                align: "right",
                sortValue: (h) => nombre(h.qte_totale),
                cell: (h) => fmtEntier(nombre(h.qte_totale)),
                footer: (rows) => fmtEntier(somme(rows, (r) => r.qte_totale)),
            },
        ],
        [],
    );

    const onglets = [
        { value: "publicites", label: "Publicités", icon: Megaphone, count: erreurPublicites ? undefined : total },
        { value: "historique", label: "Historique", icon: History, count: erreurHistorique ? undefined : historique.length },
    ] as const;

    const selectStatut = (
        <Select
            id="publicites-statut"
            label="Statut"
            value={statut}
            options={OPTIONS_STATUT}
            onChange={(v) => naviguer({ statut: v, page: 1 })}
            disabled={chargement}
        />
    );

    const descriptionVide =
        page > 1 && total > 0 ? (
            <>
                Cette page ne contient aucune publicité.{" "}
                <button
                    type="button"
                    onClick={() => naviguer({ page: 1 })}
                    className="font-medium text-[var(--accent)] underline underline-offset-2"
                >
                    Revenir à la première page
                </button>
            </>
        ) : (
            <>
                {VIDE_PAR_STATUT[statut] ?? VIDE_PAR_STATUT.toutes}
                {statut !== "toutes" && " Choisissez « Toutes » dans le filtre Statut pour voir les autres opérations."}
            </>
        );

    return (
        <div className="space-y-5">
            <Tabs items={onglets} value={vue} onChange={setVue} />

            <div aria-busy={chargement} className={cn("transition-opacity", chargement && "pointer-events-none opacity-60")}>
                {vue === "publicites" ? (
                    erreurPublicites ? (
                        <ErrorState
                            title="Les publicités n'ont pas pu être chargées"
                            description="Le serveur des publicités n'a pas répondu correctement. Réessayez dans un instant ; si le problème persiste, prévenez un administrateur."
                            detail={erreurPublicites}
                            action={reessayer}
                        />
                    ) : (
                        <div className="space-y-3">
                            {paginee && (
                                <p className="flex items-start gap-2 text-[13px] text-[var(--text-secondary)]">
                                    <Info className="mt-0.5 h-4 w-4 shrink-0 text-[var(--text-muted)]" aria-hidden />
                                    <span>
                                        <span className="font-semibold text-[var(--text-primary)]">
                                            Tri et filtre magasin appliqués à cette page.
                                        </span>{" "}
                                        Les publicités sont chargées par pages de {fmtEntier(pageSize)} (page {fmtEntier(page)} sur{" "}
                                        {fmtEntier(pages)}) : la ligne Total ne porte, elle aussi, que sur la page affichée.
                                    </span>
                                </p>
                            )}
                            <DataTable
                                rows={validPublicites}
                                columns={colonnesPublicites}
                                rowKey={(p, i) => `${p.tcr_code}-${p.site}-${i}`}
                                filters={filtresPublicites}
                                toolbar={selectStatut}
                                pageSize={0}
                                unite="publicités"
                                showFooter
                                initialSort={{ id: "operation", dir: "asc" }}
                                emptyTitle="Aucune publicité à afficher"
                                emptyDescription={descriptionVide}
                            />
                            <Pagination
                                page={page}
                                totalPages={pages}
                                total={total}
                                pageSize={pageSize}
                                onChange={(p) => naviguer({ page: p })}
                                unite="publicités"
                            />
                        </div>
                    )
                ) : erreurHistorique ? (
                    <ErrorState
                        title="L'historique n'a pas pu être chargé"
                        description="Le serveur des publicités n'a pas répondu correctement. Réessayez dans un instant ; si le problème persiste, prévenez un administrateur."
                        detail={erreurHistorique}
                        action={reessayer}
                    />
                ) : (
                    <DataTable
                        rows={historique}
                        columns={colonnesHistorique}
                        rowKey={(h, i) => `${h.tcr_code}-${i}`}
                        searchIn={(h) => [h.intitule, h.tcr_code]}
                        searchPlaceholder="Rechercher une opération ou un code…"
                        filters={filtresHistorique}
                        unite="opérations"
                        showFooter
                        emptyTitle="Aucune opération dans l'historique"
                        emptyDescription="L'historique des opérations publicitaires est vide pour le moment."
                    />
                )}
            </div>
        </div>
    );
}
