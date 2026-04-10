import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import fs from "fs/promises";
import path from "path";

export async function GET() {
    const session = await auth();
    if (!session || (session.user as any)?.role !== "admin") {
        return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
    }

    try {
        const configFile = path.join(process.cwd(), "data", ".db-config.json");
        const data = await fs.readFile(configFile, "utf-8");
        const config = JSON.parse(data);
        return NextResponse.json({
            provider: config.aiProvider ?? "openrouter",
            openRouterModel: config.openRouterModel,
            googleAiModel: config.googleAiModel,
        });
    } catch {
        return NextResponse.json({ provider: "openrouter" });
    }
}
