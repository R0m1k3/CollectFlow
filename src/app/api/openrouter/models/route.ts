import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
    const apiKey = req.headers.get("x-openrouter-key") || process.env.OPENROUTER_API_KEY;

    if (!apiKey) {
        return NextResponse.json({ error: "No API key provided" }, { status: 401 });
    }

    try {
        const res = await fetch("https://openrouter.ai/api/v1/models", {
            headers: {
                Authorization: `Bearer ${apiKey}`,
                "Content-Type": "application/json",
            },
            next: { revalidate: 3600 }, // Cache 1h
        });

        if (!res.ok) {
            return NextResponse.json({ error: "OpenRouter error", status: res.status }, { status: res.status });
        }

        const data = await res.json();

        // Return simplified list sorted by name
        const models = (data.data as Array<{ id: string; name: string; pricing?: { prompt: string } }>)
            .map((m) => ({
                id: m.id,
                name: m.name,
                free: parseFloat(m.pricing?.prompt ?? "1") === 0,
            }))
            .sort((a, b) => {
                // Free models first, then alphabetical
                if (a.free && !b.free) return -1;
                if (!a.free && b.free) return 1;
                return a.name.localeCompare(b.name, "fr");
            });

        return NextResponse.json({ models });
    } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        return NextResponse.json({ error: msg }, { status: 500 });
    }
}
