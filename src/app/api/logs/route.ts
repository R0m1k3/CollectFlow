/**
 * CollectFlow — Journaux serveur des jobs (liste + téléchargement).
 *
 * `GET /api/logs`              → liste des journaux disponibles (JSON)
 * `GET /api/logs?id=<jobId>`   → le journal complet en pièce jointe (text/plain)
 *
 * Réservé aux admins : un journal d'extraction contient les diagnostics internes
 * du modèle Qlik et les codes articles manipulés. Aucun secret n'y transite —
 * l'extracteur ne journalise que le NOM du cookie de session, jamais sa valeur,
 * et jamais le mot de passe Qlik.
 */

import { NextRequest, NextResponse } from "next/server";
import { adminOuReponse } from "@/lib/authz";
import { listCaptures, readCapture } from "@/lib/log-capture";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
    const refus = await adminOuReponse();
    if (refus instanceof Response) return refus;

    const id = req.nextUrl.searchParams.get("id");
    if (!id) {
        return NextResponse.json({ success: true, logs: await listCaptures() });
    }

    const contenu = await readCapture(id);
    if (contenu == null) {
        return NextResponse.json({ error: "Journal introuvable ou expiré" }, { status: 404 });
    }

    // Nom de fichier assaini : l'id vient d'un job interne, mais il finit dans
    // un en-tête HTTP.
    const nom = `${id.replace(/[^A-Za-z0-9_.-]/g, "_")}.log`;
    return new NextResponse(contenu, {
        status: 200,
        headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Content-Disposition": `attachment; filename="${nom}"`,
            "Cache-Control": "no-store",
        },
    });
}
