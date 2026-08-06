/**
 * CollectFlow — Enveloppe de réponse de l'API publique `/api/v1`.
 *
 * Une forme unique pour tout : `{ data, pagination?, meta }` en succès,
 * `{ error: { code, message } }` en échec, avec de vrais statuts HTTP.
 * Les consommateurs (scripts, IA, outils externes) peuvent ainsi traiter
 * toutes les réponses de la même manière.
 */

import { NextResponse } from "next/server";

export type ApiErrorCode =
    | "unauthorized"
    | "forbidden"
    | "bad_request"
    | "not_found"
    | "not_ready"
    | "internal_error";

const STATUS_BY_CODE: Record<ApiErrorCode, number> = {
    unauthorized: 401,
    forbidden: 403,
    bad_request: 400,
    not_found: 404,
    not_ready: 202,
    internal_error: 500,
};

export interface Pagination {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    /** `true` s'il reste des pages à lire — évite d'avoir à comparer page et totalPages. */
    hasMore: boolean;
}

export function buildPagination(page: number, limit: number, total: number): Pagination {
    const totalPages = Math.max(1, Math.ceil(total / limit));
    // `hasMore` explicite : un agent qui doit comparer page et totalPages oublie
    // souvent de le faire et conclut à tort qu'il a tout récupéré.
    return { page, limit, total, totalPages, hasMore: page < totalPages };
}

/** Réponse de succès. `meta` porte la fraîcheur de la donnée (`computedAt`). */
export function ok<T>(
    data: T,
    opts: { pagination?: Pagination; meta?: Record<string, unknown> } = {},
): NextResponse {
    return NextResponse.json({
        data,
        ...(opts.pagination ? { pagination: opts.pagination } : {}),
        meta: { ...(opts.meta ?? {}) },
    });
}

/**
 * Réponse d'erreur. `details` sert notamment aux erreurs de validation zod.
 *
 * Note : `not_ready` renvoie un 202 — ce n'est pas un échec mais une donnée pas
 * encore calculée (voir /api/v1/grid sur un fournisseur jamais ouvert).
 */
export function fail(
    code: ApiErrorCode,
    message: string,
    details?: unknown,
): NextResponse {
    return NextResponse.json(
        { error: { code, message, ...(details !== undefined ? { details } : {}) } },
        { status: STATUS_BY_CODE[code] },
    );
}
