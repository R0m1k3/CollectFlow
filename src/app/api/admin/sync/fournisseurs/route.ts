import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { asc, eq, inArray, sql } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/db";
import { syncFournisseurs } from "@/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function requireAdmin(): Promise<NextResponse | null> {
    const session = await auth();
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if ((session.user as { role?: string } | undefined)?.role !== "admin") {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    return null;
}

/**
 * GET — la liste complète des fournisseurs paramétrés, avec l'état de leur
 * dernière synchronisation.
 *
 * Pas de pagination : quelques centaines de lignes tout au plus, et l'admin a
 * besoin de la vue d'ensemble pour décider qui cadencer.
 */
export async function GET() {
    const denied = await requireAdmin();
    if (denied) return denied;

    const rows = await db
        .select()
        .from(syncFournisseurs)
        .orderBy(asc(sql`coalesce(${syncFournisseurs.nomFournisseur}, ${syncFournisseurs.codeFournisseur})`));

    return NextResponse.json({
        success: true,
        fournisseurs: rows,
        resume: {
            total: rows.length,
            actifsSql: rows.filter((r) => r.actifSql).length,
            actifsQlik: rows.filter((r) => r.actifQlik).length,
            desactivesAuto: rows.filter((r) => r.desactiveMotif).length,
            enEchecSql: rows.filter((r) => r.dernierSqlStatut === "echec").length,
            enEchecQlik: rows.filter((r) => r.dernierQlikStatut === "echec").length,
            jamaisSql: rows.filter((r) => !r.dernierSqlAt).length,
        },
    });
}

const patchSchema = z.object({
    /** Codes visés. Permet d'activer ou désactiver en masse depuis la page. */
    codes: z.array(z.string().min(1)).min(1).max(2000),
    actifSql: z.boolean().optional(),
    actifQlik: z.boolean().optional(),
}).refine((v) => v.actifSql !== undefined || v.actifQlik !== undefined, {
    message: "Préciser au moins actifSql ou actifQlik",
});

/**
 * PATCH — active ou désactive des fournisseurs, pour l'une ou l'autre source.
 *
 * Réactiver lève le motif de désactivation automatique : sans cela, un
 * fournisseur remis en service par l'admin garderait un « aucun article »
 * trompeur, alors même qu'il vient d'être rouvert volontairement.
 */
export async function PATCH(req: NextRequest) {
    const denied = await requireAdmin();
    if (denied) return denied;

    let body: unknown;
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: "Corps JSON invalide" }, { status: 400 });
    }
    const parsed = patchSchema.safeParse(body);
    if (!parsed.success) {
        return NextResponse.json(
            { error: "Paramètres invalides", details: parsed.error.issues.map((i) => i.message) },
            { status: 400 },
        );
    }
    const { codes, actifSql, actifQlik } = parsed.data;

    const reactivation = actifSql === true || actifQlik === true;
    const rows = await db
        .update(syncFournisseurs)
        .set({
            ...(actifSql !== undefined ? { actifSql } : {}),
            ...(actifQlik !== undefined ? { actifQlik } : {}),
            ...(reactivation ? { desactiveMotif: null } : {}),
            updatedAt: new Date(),
        })
        .where(codes.length === 1 ? eq(syncFournisseurs.codeFournisseur, codes[0]) : inArray(syncFournisseurs.codeFournisseur, codes))
        .returning({ code: syncFournisseurs.codeFournisseur });

    console.log(`[api/admin/sync] ${rows.length} fournisseur(s) mis à jour (sql=${actifSql} qlik=${actifQlik})`);
    return NextResponse.json({ success: true, misAJour: rows.length });
}
