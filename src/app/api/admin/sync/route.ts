import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { readSyncSettings, saveSyncSettings } from "@/features/admin/api/sync-settings";
import {
    getSyncSchedulerState,
    lancerRound,
    demanderArret,
    debutFenetre,
    seedSyncFournisseurs,
} from "@/features/admin/api/sync-scheduler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Un lancement manuel peut enchaîner plusieurs fournisseurs.
export const maxDuration = 300;

async function requireAdmin(): Promise<NextResponse | null> {
    const session = await auth();
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if ((session.user as { role?: string } | undefined)?.role !== "admin") {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    return null;
}

/** GET — réglages, état courant, et prochaine ouverture de fenêtre. */
export async function GET() {
    const denied = await requireAdmin();
    if (denied) return denied;

    const settings = await readSyncSettings();
    const maintenant = new Date();
    const debut = debutFenetre(settings, maintenant);

    return NextResponse.json({
        success: true,
        settings,
        state: getSyncSchedulerState(),
        /** true = on est actuellement dans la fenêtre nocturne. */
        dansLaFenetre: debut !== null,
        fenetreDebutAt: debut?.toISOString() ?? null,
        maintenant: maintenant.toISOString(),
    });
}

const settingsSchema = z.object({
    actif: z.boolean().optional(),
    heureDebut: z.coerce.number().int().min(0).max(23).optional(),
    heureFin: z.coerce.number().int().min(0).max(23).optional(),
    qlikParNuit: z.coerce.number().int().min(0).max(200).optional(),
    sqlParQlik: z.coerce.number().int().min(1).max(500).optional(),
    qlikMinJours: z.coerce.number().int().min(0).max(365).optional(),
});

/** PATCH — met à jour les réglages. */
export async function PATCH(req: NextRequest) {
    const denied = await requireAdmin();
    if (denied) return denied;

    let body: unknown;
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: "Corps JSON invalide" }, { status: 400 });
    }
    const parsed = settingsSchema.safeParse(body);
    if (!parsed.success) {
        return NextResponse.json(
            { error: "Paramètres invalides", details: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) },
            { status: 400 },
        );
    }

    const settings = await saveSyncSettings(parsed.data);
    return NextResponse.json({ success: true, settings });
}

const actionSchema = z.object({
    action: z.enum(["start", "stop", "seed"]),
    /**
     * Lancement manuel hors de la fenêtre nocturne. Réservé à l'admin qui sait
     * ce qu'il fait : en pleine journée, la charge est visible par les magasins.
     */
    forcer: z.boolean().optional(),
});

/** POST — démarre un round manuellement, l'arrête, ou resynchronise la liste. */
export async function POST(req: NextRequest) {
    const denied = await requireAdmin();
    if (denied) return denied;

    let body: unknown;
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: "Corps JSON invalide" }, { status: 400 });
    }
    const parsed = actionSchema.safeParse(body);
    if (!parsed.success) {
        return NextResponse.json({ error: "Action inconnue (start, stop ou seed)" }, { status: 400 });
    }

    if (parsed.data.action === "seed") {
        const n = await seedSyncFournisseurs();
        return NextResponse.json({ success: true, fournisseurs: n });
    }

    if (parsed.data.action === "stop") {
        demanderArret();
        return NextResponse.json({ success: true, state: getSyncSchedulerState() });
    }

    const etat = getSyncSchedulerState();
    if (etat.enCours) {
        return NextResponse.json({ error: "Un round est déjà en cours.", state: etat }, { status: 409 });
    }

    // Fire-and-forget : le round dure des minutes, le client suit via GET.
    void lancerRound("manuel", parsed.data.forcer === true).catch((e) => {
        console.error("[api/admin/sync] round manuel en échec :", e instanceof Error ? e.message : String(e));
    });

    return NextResponse.json({ success: true, state: getSyncSchedulerState() });
}
