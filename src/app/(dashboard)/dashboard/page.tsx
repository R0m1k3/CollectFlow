import type { Metadata } from "next";
import Link from "next/link";
import { unstable_cache } from "next/cache";
import { BarChart3, Euro, House, Receipt, ShoppingBasket, ShoppingCart, Store } from "lucide-react";
import { pgGetDashboardData, type DashboardSiteStats, type DashboardSiteTop10, type DashboardTopItem } from "@/lib/pg-ff-client";
import { PageHeader } from "@/components/ui/page-header";
import { StatCard } from "@/components/ui/stat-card";
import { Card, CardHeader } from "@/components/ui/card";
import { Badge, DeltaBadge } from "@/components/ui/badge";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { Terme } from "@/components/ui/tooltip";
import { LIBELLE_TOUS_MAGASINS, nomMagasin } from "@/lib/magasins";
import { fmtDecimal1, fmtEntier, fmtEur0, fmtEur2 } from "@/lib/format";
import { couleurMarge } from "@/lib/marge";

export const metadata: Metadata = { title: "Accueil" };

const getCachedDashboardData = unstable_cache(
    pgGetDashboardData,
    ["dashboard-data"],
    { revalidate: 600 } // 10 minutes
);

// ---------------------------------------------------------------------------
// Calculs
// ---------------------------------------------------------------------------

/** Évolution en % ; `null` quand il n'y a pas de base de comparaison. */
function evolution(actuel: number, precedent: number): number | null {
    if (!precedent) return null;
    return ((actuel - precedent) / Math.abs(precedent)) * 100;
}

function panierMoyen(ca: number, tickets: number): number | null {
    return tickets > 0 ? ca / tickets : null;
}

/** « 2026-10-02 » → « vendredi 2 octobre 2026 ». */
function dateLongue(iso: string): string {
    const d = new Date(`${iso}T12:00:00`);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}

// ---------------------------------------------------------------------------
// Blocs
// ---------------------------------------------------------------------------

function Indicateur({ label, valeur, valeurN1, delta }: {
    label: string;
    valeur: string;
    valeurN1: string | null;
    delta: number | null;
}) {
    return (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-base)] p-3">
            <div className="text-[13px] text-[var(--text-secondary)]">{label}</div>
            <div className="mt-1 text-xl font-bold tabular-nums text-[var(--text-primary)]">{valeur}</div>
            <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-[var(--text-muted)]">
                <DeltaBadge pct={delta} />
                {valeurN1 && <span>N-1 : {valeurN1}</span>}
            </div>
        </div>
    );
}

function CarteMagasin({ site }: { site: DashboardSiteStats }) {
    const panier = panierMoyen(site.ca_hier, site.tickets_hier);
    const panierN1 = panierMoyen(site.ca_n1, site.tickets_n1);
    return (
        <Card>
            <CardHeader
                title={<span className="inline-flex items-center gap-2"><Store className="h-4 w-4 text-[var(--accent)]" />{nomMagasin(site.site)}</span>}
            />
            <div className="grid gap-3 p-4 sm:grid-cols-3">
                <Indicateur
                    label="Chiffre d'affaires"
                    valeur={fmtEur0(site.ca_hier)}
                    valeurN1={site.ca_n1 > 0 ? fmtEur0(site.ca_n1) : null}
                    delta={evolution(site.ca_hier, site.ca_n1)}
                />
                <Indicateur
                    label="Tickets de caisse"
                    valeur={fmtEntier(site.tickets_hier)}
                    valeurN1={site.tickets_n1 > 0 ? fmtEntier(site.tickets_n1) : null}
                    delta={evolution(site.tickets_hier, site.tickets_n1)}
                />
                <Indicateur
                    label="Panier moyen"
                    valeur={panier != null ? fmtEur2(panier) : "—"}
                    valeurN1={panierN1 != null ? fmtEur2(panierN1) : null}
                    delta={panier != null && panierN1 != null ? evolution(panier, panierN1) : null}
                />
            </div>
        </Card>
    );
}

type Critere = "ca" | "qte" | "marge";

const CRITERES: Record<Critere, { titre: string; icone: typeof Euro }> = {
    ca: { titre: "Meilleur chiffre d'affaires", icone: Euro },
    qte: { titre: "Plus grandes quantités", icone: ShoppingCart },
    marge: { titre: "Meilleure marge", icone: BarChart3 },
};

function valeurPrincipale(item: DashboardTopItem, critere: Critere): string {
    if (critere === "qte") return `${fmtEntier(item.qte)} vendus`;
    if (critere === "marge") return fmtEur0(item.marge);
    return fmtEur0(item.ca);
}

function ListeTop10({ items, critere }: { items: DashboardTopItem[]; critere: Critere }) {
    const { titre, icone: Icone } = CRITERES[critere];
    return (
        <Card className="min-w-0">
            <div className="flex items-center gap-2 border-b border-[var(--border)] px-4 py-3">
                <Icone className="h-4 w-4 text-[var(--accent)]" aria-hidden />
                <h3 className="text-sm font-semibold text-[var(--text-primary)]">{titre}</h3>
            </div>
            {items.length === 0 ? (
                <p className="px-4 py-8 text-center text-sm text-[var(--text-muted)]">Aucune vente enregistrée.</p>
            ) : (
                <ol>
                    {items.map((item, i) => {
                        const taux = item.ca > 0 ? (item.marge / item.ca) * 100 : null;
                        return (
                            <li key={item.codein} className="flex items-start gap-3 border-b border-[var(--border)] px-4 py-2.5 last:border-b-0">
                                <span
                                    className={
                                        "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold " +
                                        (i < 3 ? "bg-[var(--accent)] text-white" : "bg-[var(--bg-elevated)] text-[var(--text-secondary)]")
                                    }
                                >
                                    {i + 1}
                                </span>
                                <div className="min-w-0 flex-1">
                                    <div className="flex items-baseline justify-between gap-2">
                                        <Link
                                            href={`/produits?codein=${encodeURIComponent(item.codein)}`}
                                            title={`Voir la fiche de ${item.libelle1 ?? item.codein}`}
                                            className="truncate text-sm font-medium text-[var(--text-primary)] hover:text-[var(--accent)] hover:underline"
                                        >
                                            {item.libelle1 ?? item.codein}
                                        </Link>
                                        <span className="shrink-0 text-sm font-semibold tabular-nums text-[var(--text-primary)]">
                                            {valeurPrincipale(item, critere)}
                                        </span>
                                    </div>
                                    <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--text-muted)]">
                                        <span className="truncate">{item.fournisseur}</span>
                                        {critere !== "ca" && <span>CA {fmtEur0(item.ca)}</span>}
                                        {critere !== "qte" && <span>{fmtEntier(item.qte)} vendus</span>}
                                        <span
                                            style={{ color: item.stock <= 0 ? "var(--accent-error)" : undefined }}
                                            title="Stock actuel du magasin"
                                        >
                                            Stock {fmtEntier(item.stock)}
                                        </span>
                                        {taux != null && (
                                            <span className="ml-auto font-semibold" style={{ color: couleurMarge(taux) }} title="Taux de marge">
                                                Marge {fmtDecimal1(taux)} %
                                            </span>
                                        )}
                                    </div>
                                </div>
                            </li>
                        );
                    })}
                </ol>
            )}
        </Card>
    );
}

function Top10Magasin({ siteData }: { siteData: DashboardSiteTop10 }) {
    return (
        <section className="space-y-3">
            <h3 className="flex items-center gap-2 text-base font-semibold text-[var(--text-primary)]">
                <Store className="h-4 w-4 text-[var(--accent)]" aria-hidden />
                {nomMagasin(siteData.site)}
            </h3>
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
                <ListeTop10 items={siteData.ca} critere="ca" />
                <ListeTop10 items={siteData.qte} critere="qte" />
                <ListeTop10 items={siteData.marge} critere="marge" />
            </div>
        </section>
    );
}

function TitreSection({ titre, description }: { titre: string; description?: React.ReactNode }) {
    return (
        <div className="mb-3">
            <h2 className="text-lg font-semibold text-[var(--text-primary)]">{titre}</h2>
            {description && <p className="text-sm text-[var(--text-secondary)]">{description}</p>}
        </div>
    );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function DashboardPage() {
    let data;
    try {
        data = await getCachedDashboardData();
    } catch (e) {
        console.error("[Dashboard] pgGetDashboardData failed:", e);
        return (
            <div className="mx-auto w-full max-w-3xl">
                <PageHeader icon={House} title="Accueil" />
                <ErrorState
                    title="Les ventes d'hier n'ont pas pu être chargées"
                    description="Le serveur de données FF ne répond pas pour le moment. Réessayez dans quelques minutes."
                    detail={e instanceof Error ? e.message.slice(0, 500) : String(e)}
                />
            </div>
        );
    }

    const { dateHier, dateN1, sites, top10BySite } = data;

    const totalCa = sites.reduce((s, r) => s + r.ca_hier, 0);
    const totalCaN1 = sites.reduce((s, r) => s + r.ca_n1, 0);
    const totalTickets = sites.reduce((s, r) => s + r.tickets_hier, 0);
    const totalTicketsN1 = sites.reduce((s, r) => s + r.tickets_n1, 0);
    const panier = panierMoyen(totalCa, totalTickets);
    const panierN1 = panierMoyen(totalCaN1, totalTicketsN1);

    return (
        <div className="mx-auto w-full max-w-screen-2xl pb-12">
            <PageHeader
                icon={House}
                title="Accueil"
                description={
                    <>
                        Les ventes de <strong className="text-[var(--text-primary)]">{dateLongue(dateHier)}</strong>
                        {dateN1 && <>, comparées au même jour de la semaine l&apos;an dernier ({dateLongue(dateN1)})</>}.
                    </>
                }
                actions={<Badge ton="accent">Données mises à jour chaque nuit</Badge>}
            />

            {sites.length === 0 ? (
                <EmptyState
                    title="Aucune vente enregistrée hier"
                    description="Les données de la veille ne sont pas encore disponibles. Elles arrivent après la mise à jour de la nuit."
                />
            ) : (
                <div className="space-y-10">
                    <section>
                        <TitreSection
                            titre={`${LIBELLE_TOUS_MAGASINS} — hier`}
                            description={<>Total de nos magasins, évolution par rapport à <Terme id="n1" />.</>}
                        />
                        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                            <StatCard
                                label="Chiffre d'affaires"
                                value={fmtEur0(totalCa)}
                                delta={evolution(totalCa, totalCaN1)}
                                hint={totalCaN1 > 0 ? `N-1 : ${fmtEur0(totalCaN1)}` : undefined}
                                icon={Euro}
                            />
                            <StatCard
                                label="Tickets de caisse"
                                value={fmtEntier(totalTickets)}
                                delta={evolution(totalTickets, totalTicketsN1)}
                                hint={totalTicketsN1 > 0 ? `N-1 : ${fmtEntier(totalTicketsN1)}` : undefined}
                                icon={Receipt}
                            />
                            <StatCard
                                label="Panier moyen"
                                value={panier != null ? fmtEur2(panier) : "—"}
                                delta={panier != null && panierN1 != null ? evolution(panier, panierN1) : null}
                                hint={panierN1 != null ? `N-1 : ${fmtEur2(panierN1)}` : undefined}
                                icon={ShoppingBasket}
                            />
                        </div>
                    </section>

                    <section>
                        <TitreSection titre="Par magasin" />
                        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                            {sites.map((s) => <CarteMagasin key={s.site} site={s} />)}
                        </div>
                    </section>

                    {top10BySite.length > 0 && (
                        <section>
                            <TitreSection
                                titre="Top 10 des produits d'hier"
                                description="Les produits qui ont le plus rapporté, le plus vendu et le plus margé, par magasin. Cliquez sur un produit pour ouvrir sa fiche."
                            />
                            <div className="space-y-8">
                                {top10BySite.map((s) => <Top10Magasin key={s.site} siteData={s} />)}
                            </div>
                        </section>
                    )}
                </div>
            )}
        </div>
    );
}
