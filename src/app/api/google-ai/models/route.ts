import { NextRequest, NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";

async function getSavedGoogleKey(): Promise<string | null> {
    try {
        const configFile = path.join(process.cwd(), "data", ".db-config.json");
        const data = await fs.readFile(configFile, "utf-8");
        const config = JSON.parse(data);
        return config.googleAiKey ?? null;
    } catch {
        return null;
    }
}

export async function GET(req: NextRequest) {
    const apiKey = req.headers.get("x-google-ai-key")
        || process.env.GOOGLE_AI_KEY
        || await getSavedGoogleKey();

    if (!apiKey) {
        return NextResponse.json({ error: "No Google AI key provided" }, { status: 401 });
    }

    try {
        const res = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}&pageSize=100`,
            { cache: "no-store" }
        );

        if (!res.ok) {
            const err = await res.text();
            return NextResponse.json({ error: err }, { status: res.status });
        }

        const data = await res.json();

        // Keep only generative models that support generateContent
        const models = (data.models as Array<{
            name: string;
            displayName: string;
            supportedGenerationMethods?: string[];
            description?: string;
        }>)
            .filter(m =>
                m.supportedGenerationMethods?.includes("generateContent") &&
                !m.name.includes("embedding") &&
                !m.name.includes("aqa")
            )
            .map(m => ({
                id: m.name.replace("models/", ""),
                name: m.displayName,
            }))
            .sort((a, b) => a.name.localeCompare(b.name, "fr"));

        return NextResponse.json({ models });
    } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        return NextResponse.json({ error: msg }, { status: 500 });
    }
}
