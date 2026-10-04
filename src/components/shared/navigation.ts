import {
    CalendarClock,
    CalendarRange,
    History,
    House,
    LayoutGrid,
    Megaphone,
    PackageMinus,
    PackageSearch,
    Settings,
    ShoppingCart,
    Trophy,
    type LucideIcon,
} from "lucide-react";

export interface NavItem {
    label: string;
    href: string;
    icon: LucideIcon;
    /** Phrase d'aide affichée au survol du menu replié. */
    description: string;
    adminOnly?: boolean;
}

export interface NavGroup {
    title: string;
    items: NavItem[];
}

/**
 * Menu principal, regroupé par usage. Les libellés disent ce que fait la page,
 * en français (« Dashboard », « Analytics », « Snapshots » ont disparu).
 * Les adresses ne changent pas : favoris et liens existants restent valables.
 */
export const NAV_GROUPS: NavGroup[] = [
    {
        title: "Au quotidien",
        items: [
            { label: "Accueil", href: "/dashboard", icon: House, description: "Les ventes d'hier et les meilleurs produits" },
            { label: "Révision d'assortiment", href: "/grid", icon: LayoutGrid, description: "Choisir la gamme de chaque produit d'un fournisseur" },
            { label: "Recherche produit", href: "/produits", icon: PackageSearch, description: "Trouver un produit et voir ses ventes dans le réseau" },
            { label: "Stocks à surveiller", href: "/stock-negatif", icon: PackageMinus, description: "Stocks négatifs et produits qui ne se vendent pas" },
            { label: "Commandes fournisseurs", href: "/commandes-auto", icon: ShoppingCart, description: "Commandes automatiques et rythme de commande" },
        ],
    },
    {
        title: "Analyses",
        items: [
            { label: "Meilleures ventes", href: "/hit-parade", icon: Trophy, description: "Classement des produits les plus vendus sur une période" },
            { label: "Ventes par mois", href: "/analytics", icon: CalendarRange, description: "Chiffre d'affaires d'un mois comparé à l'an dernier" },
            { label: "Publicités", href: "/publicites", icon: Megaphone, description: "Résultats des opérations publicitaires" },
        ],
    },
    {
        title: "Suivi",
        items: [
            { label: "Historique", href: "/historique", icon: History, description: "Sessions de révision enregistrées et exports" },
        ],
    },
    {
        title: "Administration",
        items: [
            { label: "Synchronisation", href: "/admin/synchronisation", icon: CalendarClock, description: "Mise à jour nocturne des données", adminOnly: true },
            { label: "Paramètres", href: "/settings", icon: Settings, description: "Connexions, utilisateurs et clés d'accès", adminOnly: true },
        ],
    },
];

/** Entrée du menu correspondant à l'adresse courante (pour le titre de l'en-tête). */
export function pageCourante(pathname: string): NavItem | undefined {
    for (const g of NAV_GROUPS) {
        for (const item of g.items) {
            if (pathname === item.href || pathname.startsWith(`${item.href}/`)) return item;
        }
    }
    return undefined;
}
