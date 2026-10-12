/**
 * CollectFlow — Table des routes de la SPA.
 *
 * Reprend une à une les pages de l'ancien routeur Next.js (`src/app/**`) :
 * même adresse, même titre d'onglet, même silhouette de chargement
 * (`loading.tsx`), même mise en page du groupe `(dashboard)` (menu + en-tête)
 * et même page d'erreur (`error.tsx`) ou « introuvable » (`not-found.tsx`).
 *
 * Le serveur Rust garde les accès : non connecté → /login, connecté sur / ou
 * /login → /dashboard, /settings et /admin/* réservés aux administrateurs.
 */

import { Suspense, useEffect, type ComponentType } from "react";
import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation } from "react-router";
import { isNotFoundError } from "next/navigation";
import { useSession } from "next-auth/react";
import { Providers } from "@/app/providers";
import { RouteErrorBoundary } from "@/components/shared/route-error-boundary";

import HomePage from "@/app/page";
import NotFound from "@/app/not-found";
import LoginPage from "@/app/(auth)/login/page";
import DashboardLayout from "@/app/(dashboard)/layout";
import DashboardError from "@/app/(dashboard)/error";
import DashboardNotFound from "@/app/(dashboard)/not-found";
import AdminSynchronisationPage from "@/app/(dashboard)/admin/synchronisation/page";
import AnalyticsPage from "@/app/(dashboard)/analytics/page";
import AnalyticsLoading from "@/app/(dashboard)/analytics/loading";
import CommandesAutoPage from "@/app/(dashboard)/commandes-auto/page";
import CommandesAutoLoading from "@/app/(dashboard)/commandes-auto/loading";
import DashboardPage from "@/app/(dashboard)/dashboard/page";
import DashboardLoading from "@/app/(dashboard)/dashboard/loading";
import ExportsPage from "@/app/(dashboard)/exports/page";
import GridPage from "@/app/(dashboard)/grid/page";
import GridLoading from "@/app/(dashboard)/grid/loading";
import HistoriquePage from "@/app/(dashboard)/historique/page";
import HitParadePage from "@/app/(dashboard)/hit-parade/page";
import HitParadeLoading from "@/app/(dashboard)/hit-parade/loading";
import ProduitsPage from "@/app/(dashboard)/produits/page";
import ProduitsLoading from "@/app/(dashboard)/produits/loading";
import PublicitesPage from "@/app/(dashboard)/publicites/page";
import PublicitesLoading from "@/app/(dashboard)/publicites/loading";
import SettingsPage from "@/app/(dashboard)/settings/page";
import SettingsLoading from "@/app/(dashboard)/settings/loading";
import SnapshotsPage from "@/app/(dashboard)/snapshots/page";
import StockNegatifPage from "@/app/(dashboard)/stock-negatif/page";
import StockNegatifLoading from "@/app/(dashboard)/stock-negatif/loading";

interface PageRoute {
    path: string;
    /** Titre de l'onglet (« <titre> · CollectFlow ») ; absent : « CollectFlow ». */
    title?: string;
    Page: ComponentType;
    /** Silhouette affichée pendant le premier chargement des données (`loading.tsx`). */
    Loading?: ComponentType;
}

/** Pages du groupe `(dashboard)` : menu latéral et en-tête autour. */
const PAGES_TABLEAU_DE_BORD: PageRoute[] = [
    { path: "/dashboard", title: "Accueil", Page: DashboardPage, Loading: DashboardLoading },
    { path: "/grid", title: "Révision d'assortiment", Page: GridPage, Loading: GridLoading },
    { path: "/produits", title: "Recherche produit", Page: ProduitsPage, Loading: ProduitsLoading },
    { path: "/analytics", title: "Ventes par mois", Page: AnalyticsPage, Loading: AnalyticsLoading },
    { path: "/hit-parade", title: "Meilleures ventes", Page: HitParadePage, Loading: HitParadeLoading },
    { path: "/stock-negatif", title: "Stocks à surveiller", Page: StockNegatifPage, Loading: StockNegatifLoading },
    { path: "/commandes-auto", title: "Commandes fournisseurs", Page: CommandesAutoPage, Loading: CommandesAutoLoading },
    { path: "/publicites", title: "Publicités", Page: PublicitesPage, Loading: PublicitesLoading },
    { path: "/historique", title: "Historique", Page: HistoriquePage },
    { path: "/settings", title: "Paramètres", Page: SettingsPage, Loading: SettingsLoading },
    { path: "/admin/synchronisation", title: "Synchronisation", Page: AdminSynchronisationPage },
    // Anciennes adresses, conservées pour les favoris.
    { path: "/snapshots", Page: SnapshotsPage },
    { path: "/exports", Page: ExportsPage },
];

/** Titre de l'onglet du navigateur pour la page affichée. */
function useDocumentTitle(title: string | undefined): void {
    useEffect(() => {
        document.title = title ? `${title} · CollectFlow` : "CollectFlow";
    }, [title]);
}

/** Une page : son titre, et sa silhouette de chargement tant que ses données manquent. */
function RoutePage({ title, Page, Loading }: Omit<PageRoute, "path">) {
    useDocumentTitle(title);
    return (
        <Suspense fallback={Loading ? <Loading /> : null}>
            <Page />
        </Suspense>
    );
}

/**
 * Mise en page `(dashboard)` : menu et en-tête, puis la frontière d'erreur de
 * la page (`error.tsx`, ou `not-found.tsx` après `notFound()`), remise à zéro à
 * chaque changement de page.
 */
function DashboardShell() {
    const { pathname } = useLocation();
    const { status } = useSession();
    // Session absente ou expirée : la connexion, comme le faisait le middleware.
    if (status === "unauthenticated") return <Navigate to="/login" replace />;
    return (
        <DashboardLayout>
            <RouteErrorBoundary
                key={pathname}
                fallback={(error, reset) =>
                    isNotFoundError(error) ? <DashboardNotFound /> : <DashboardError error={error} reset={reset} />
                }
            >
                <Outlet />
            </RouteErrorBoundary>
        </DashboardLayout>
    );
}

export function AppRouter() {
    return (
        <BrowserRouter>
            <Providers>
                <Routes>
                    <Route path="/" element={<HomePage />} />
                    <Route path="/login" element={<RoutePage key="/login" title="Connexion" Page={LoginPage} />} />
                    <Route element={<DashboardShell />}>
                        {PAGES_TABLEAU_DE_BORD.map(({ path, ...page }) => (
                            <Route key={path} path={path} element={<RoutePage key={path} {...page} />} />
                        ))}
                    </Route>
                    <Route path="*" element={<RoutePage key="*" Page={NotFound} />} />
                </Routes>
            </Providers>
        </BrowserRouter>
    );
}
