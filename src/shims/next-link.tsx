/**
 * CollectFlow — Remplaçant de `next/link` pour la SPA (React Router).
 *
 * Mêmes props que celles utilisées de `next/link` : `href`, `prefetch`,
 * `replace`, `scroll`, plus tous les attributs d'un `<a>`.
 */

import type { AnchorHTMLAttributes, Ref } from "react";
import { Link as RouterLink } from "react-router";

export interface LinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> {
    href: string;
    /** Sans effet : la SPA a déjà tout le code des pages. */
    prefetch?: boolean | null;
    replace?: boolean;
    /** `false` : garder la position de défilement. */
    scroll?: boolean;
    ref?: Ref<HTMLAnchorElement>;
}

/** Adresse hors application (autre origine, mailto:, fichier à télécharger…). */
function estExterne(href: string): boolean {
    return /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//");
}

export default function Link({ href, prefetch: _prefetch, replace, scroll, ref, ...rest }: LinkProps) {
    void _prefetch;
    if (estExterne(href) || rest.download !== undefined) {
        return <a ref={ref} href={href} {...rest} />;
    }
    return <RouterLink ref={ref} to={href} replace={replace} preventScrollReset={scroll === false} {...rest} />;
}
