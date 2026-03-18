import { NextResponse } from "next/server";
import { getSyncStatus } from "@/lib/api-ff-client";

export async function GET() {
    const status = await getSyncStatus();
    if (!status) {
        return NextResponse.json({ error: "API FF Nancy non disponible" }, { status: 503 });
    }
    return NextResponse.json(status);
}
