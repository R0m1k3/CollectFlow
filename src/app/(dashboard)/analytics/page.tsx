import type { Metadata } from "next";
import Link from "next/link";
import { CalendarRange, RotateCcw } from "lucide-react";
import { pgGetCaByFournisseur, pgGetCaByNomenclature } from "@/lib/pg-ff-client";
import { cachedFF } from "@/lib/ff-cache";
import { PageHeader } from "@/components/ui/page-header";
import { ErrorState } from "@/components/ui/states";
import { Button } from "@/components/ui/button";
import { AnalyticsClient, type AnalyticsRow, type ModeAnalytics, type OptionMois } from "./client";

export const metadata: Metadata = { title: "Ventes par mois" };

const NOMS_MOIS = [
    "janvier", "février", "mars", "avril", "mai", "juin",
    "juillet", "août", "septembre", "octobre", "novembre", "décembre",
];

/** « 2026-10 » → « octobre 2026 » (sans dépendre du fuseau horaire). */
function libelleMois(mois: string): string {
    const [year, month] = mois.split("-").map(Number);
    const nom = NOMS_MOIS[month - 1];
    return nom && Number.isFinite(year) ? `${nom} ${year}` : mois;
}

function formatMois(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

// Calcul du mois N-1 (même mois année précédente)
function getMoisN1(mois: string): string {
    const [year, month] = mois.split("-").map(Number);
    const d = new Date(year, month - 13); // -13 mois
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

// Helper pivot : transformer les lignes de requête en tableau pivotté par site
function pivotData(
    rows: Array<{ code: string; label: string; site: string; mois: string; ca_ttc: number }>,
    mois: string,
    moisN1: string,
    mode: string
): AnalyticsRow[] {
    const map = new Map<string, { code: string; label: string; data: Record<string, number> }>();

    for (const row of rows) {
        const key = `${row.code}|${row.label}`;
        if (!map.has(key)) {
            map.set(key, { code: row.code, label: row.label, data: {} });
        }
        const entry = map.get(key)!;
        entry.data[`${row.site}_${row.mois}`] = row.ca_ttc;
    }

    const result = Array.from(map.values()).map(({ code, label, data }) => {
        const ca292 = data[`292_${mois}`] ?? 0;
        const caN1_292 = data[`292_${moisN1}`] ?? 0;
        const ca579 = data[`579_${mois}`] ?? 0;
        const caN1_579 = data[`579_${moisN1}`] ?? 0;
        const caTotal = ca292 + ca579;
        const caN1Total = caN1_292 + caN1_579;
        const evolutionTotal =
            caN1Total > 0 ? ((caTotal - caN1Total) / caN1Total) * 100 : null;

        return {
            key: code,
            label,
            ca292,
            caN1_292,
            ca579,
            caN1_579,
            caTotal,
            caN1Total,
            evolutionTotal,
        };
    });

    if (mode === "nomenclature") {
        result.sort((a, b) => a.key.localeCompare(b.key));
    } else {
        result.sort((a, b) => a.label.localeCompare(b.label, "fr"));
    }
    return result;
}

export default async function AnalyticsPage(props: {
    searchParams: Promise<Record<string, string | string[]>>;
}) {
    const searchParams = await props.searchParams;
    // Toute autre valeur que « fournisseur » affichait déjà la vue par famille.
    const mode: ModeAnalytics = ((searchParams.mode as string) || "fournisseur") === "fournisseur" ? "fournisseur" : "nomenclature";
    const moisParam = (searchParams.mois as string) || "";

    // Mois par défaut = dernier mois complet (le mois précédent) : le mois en
    // cours, incomplet, se comparerait mal à un mois N-1 entier.
    const today = new Date();
    const currentMois = formatMois(today);
    const dernierMoisComplet = formatMois(new Date(today.getFullYear(), today.getMonth() - 1));
    const mois = moisParam || dernierMoisComplet;
    const moisN1 = getMoisN1(mois);

    // Liste des 24 derniers mois (calculée ici : même résultat côté serveur et navigateur).
    const moisDisponibles: OptionMois[] = [];
    for (let i = 0; i < 24; i++) {
        const value = formatMois(new Date(today.getFullYear(), today.getMonth() - i));
        moisDisponibles.push({ value, label: libelleMois(value) + (value === currentMois ? " (en cours)" : "") });
    }
    if (!moisDisponibles.some((m) => m.value === mois)) {
        moisDisponibles.push({ value: mois, label: libelleMois(mois) });
    }

    let pivotted: AnalyticsRow[] | null = null;
    let erreur: string | null = null;
    try {
        let rows: Array<{ code: string; label: string; site: string; mois: string; ca_ttc: number }> =
            [];

        if (mode === "fournisseur") {
            const result = await cachedFF(`ca-fournisseur:${mois}:${moisN1}`, () => pgGetCaByFournisseur(mois, moisN1));
            rows = result.map((r) => ({
                code: r.code,
                label: r.nom,
                site: r.site,
                mois: r.mois,
                ca_ttc: r.ca_ttc,
            }));
        } else {
            const result = await cachedFF(`ca-nomenclature:${mois}:${moisN1}`, () => pgGetCaByNomenclature(mois, moisN1));
            rows = result.map((r) => ({
                code: r.code,
                label: `${r.code} — ${r.libelle}`,
                site: r.site,
                mois: r.mois,
                ca_ttc: r.ca_ttc,
            }));
        }

        pivotted = pivotData(rows, mois, moisN1, mode);
    } catch (e) {
        console.error("[analytics] chargement impossible :", e);
        erreur = e instanceof Error ? e.message : String(e);
    }

    return (
        <div className="mx-auto w-full max-w-screen-2xl">
            <PageHeader
                icon={CalendarRange}
                title="Ventes par mois"
                description="Le chiffre d'affaires TTC d'un mois comparé au même mois de l'année précédente, par fournisseur ou par famille de produits, pour chacun de nos magasins."
            />
            {pivotted ? (
                <AnalyticsClient
                    mode={mode}
                    mois={mois}
                    libelleMois={libelleMois(mois)}
                    libelleMoisN1={libelleMois(moisN1)}
                    moisDisponibles={moisDisponibles}
                    pivotted={pivotted}
                />
            ) : (
                <ErrorState
                    title="Les ventes du mois n'ont pas pu être chargées"
                    detail={erreur ?? undefined}
                    action={
                        <Button asChild variant="outline">
                            <Link href={`/analytics?mode=${mode}&mois=${mois}`}><RotateCcw /> Réessayer</Link>
                        </Button>
                    }
                />
            )}
        </div>
    );
}
