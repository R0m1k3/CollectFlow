import { NextRequest } from "next/server";
import { getProductRows } from "@/features/grid/api/get-product-rows";
import type { GridFilters } from "@/types/grid";

export const dynamic = "force-dynamic";

function writeNdjson(controller: ReadableStreamDefaultController<Uint8Array>, value: unknown) {
    controller.enqueue(new TextEncoder().encode(`${JSON.stringify(value)}\n`));
}

export async function GET(request: NextRequest) {
    const searchParams = request.nextUrl.searchParams;
    const codeFournisseur = searchParams.get("fournisseur");

    if (!codeFournisseur) {
        return Response.json({ error: "Missing fournisseur" }, { status: 400 });
    }

    const magasin = searchParams.get("magasin") ?? "TOTAL";
    const chunkSize = Math.max(50, Math.min(500, Number(searchParams.get("chunkSize") ?? 150)));
    const filters: Partial<GridFilters> = {
        code1: searchParams.get("code1"),
        code2: searchParams.get("code2"),
        code3: searchParams.get("code3"),
    };
    const forceRefresh = searchParams.get("refresh") === "1";

    const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
            try {
                writeNdjson(controller, { type: "start", loaded: 0, total: null });
                const rows = await getProductRows({ codeFournisseur, magasin, filters, forceRefresh });
                const total = rows.length;

                for (let start = 0; start < total; start += chunkSize) {
                    const chunk = rows.slice(start, start + chunkSize);
                    writeNdjson(controller, {
                        type: "chunk",
                        rows: chunk,
                        loaded: Math.min(start + chunk.length, total),
                        total,
                    });
                    await new Promise((resolve) => setTimeout(resolve, 0));
                }

                writeNdjson(controller, { type: "done", loaded: total, total });
            } catch (error) {
                writeNdjson(controller, {
                    type: "error",
                    error: error instanceof Error ? error.message : "Unknown error",
                });
            } finally {
                controller.close();
            }
        },
    });

    return new Response(stream, {
        headers: {
            "Content-Type": "application/x-ndjson; charset=utf-8",
            "Cache-Control": "no-store",
            "X-Accel-Buffering": "no",
        },
    });
}
