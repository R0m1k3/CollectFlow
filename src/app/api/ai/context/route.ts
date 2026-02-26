import { NextResponse } from "next/server";
import { db } from "@/db";
import { aiSupplierContext } from "@/db/schema";
import { eq } from "drizzle-orm";
import fs from "fs";
import path from "path";

// File system fallback for environments without PostgreSQL
const DATA_DIR = path.join(process.cwd(), "data");
const FALLBACK_FILE_PATH = path.join(DATA_DIR, "ai-context.json");

function ensureFallbackFileExists() {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (!fs.existsSync(FALLBACK_FILE_PATH)) {
        fs.writeFileSync(FALLBACK_FILE_PATH, JSON.stringify({}), "utf-8");
    }
}

function getFallbackContext(codeFournisseur: string): string {
    ensureFallbackFileExists();
    try {
        const data = JSON.parse(fs.readFileSync(FALLBACK_FILE_PATH, "utf-8"));
        return data[codeFournisseur] || "";
    } catch {
        return "";
    }
}

function saveFallbackContext(codeFournisseur: string, contextText: string) {
    ensureFallbackFileExists();
    try {
        const data = JSON.parse(fs.readFileSync(FALLBACK_FILE_PATH, "utf-8"));
        data[codeFournisseur] = contextText;
        fs.writeFileSync(FALLBACK_FILE_PATH, JSON.stringify(data, null, 2), "utf-8");
    } catch (err) {
        console.error("Error saving fallback context:", err);
    }
}

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
        console.warn("DB fetch failed, using fallback JSON for AI context.");
        return NextResponse.json({ context: getFallbackContext(codeFournisseur) });
    }
}

export async function POST(request: Request) {
    try {
        const body = await request.json();
        const { codeFournisseur, context } = body;

        if (!codeFournisseur) {
            return NextResponse.json({ error: "Fournisseur manquant" }, { status: 400 });
        }

        try {
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
        } catch (dbError) {
            console.warn("DB insert failed, saving to fallback JSON.", dbError);
            saveFallbackContext(codeFournisseur, context || "");
        }

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error("Error in AI context API:", error);
        return NextResponse.json({ error: "Erreur lors de la sauvegarde" }, { status: 500 });
    }
}
