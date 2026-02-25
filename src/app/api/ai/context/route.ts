import { NextResponse } from "next/server";
import { db } from "@/db";
import { aiSupplierContext } from "@/db/schema";
import { eq } from "drizzle-orm";

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const codeFournisseur = searchParams.get("fournisseur");

    if (!codeFournisseur) {
        return NextResponse.json({ error: "Fournisseur manquant" }, { status: 400 });
    }

    try {
        const result = await db.select()
            .from(aiSupplierContext)
            .where(eq(aiSupplierContext.codeFournisseur, codeFournisseur))
            .limit(1);

        return NextResponse.json({ context: result[0]?.context || "" });
    } catch (error) {
        console.error("Error fetching AI context:", error);
        // Fallback en cas d'erreur de BDD ou si la table n'est pas encore créée
        return NextResponse.json({ context: "" });
    }
}

export async function POST(request: Request) {
    try {
        const body = await request.json();
        const { codeFournisseur, context } = body;

        if (!codeFournisseur) {
            return NextResponse.json({ error: "Fournisseur manquant" }, { status: 400 });
        }

        await db.insert(aiSupplierContext)
            .values({
                codeFournisseur,
                context: context || "",
                updatedAt: new Date()
            })
            .onConflictDoUpdate({
                target: aiSupplierContext.codeFournisseur,
                set: {
                    context: context || "",
                    updatedAt: new Date()
                }
            });

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error("Error saving AI context:", error);
        return NextResponse.json({ error: "Erreur lors de la sauvegarde" }, { status: 500 });
    }
}
