import { NextRequest, NextResponse } from "next/server";
import { getProductRows } from "@/features/grid/api/get-product-rows";
import { auth } from "@/lib/auth";

export async function GET(request: NextRequest) {
    const session = await auth();
    if (!session) {
        return NextResponse.json({ error: "Non autorisé" }, { status: 401 });
    }

    const { searchParams } = request.nextUrl;
    const codeFournisseur = searchParams.get("fournisseur");

    if (!codeFournisseur) {
        return NextResponse.json({ error: "Paramètre 'fournisseur' requis" }, { status: 400 });
    }

    const page     = parseInt(searchParams.get("page")     ?? "0",   10);
    const pageSize = parseInt(searchParams.get("pageSize") ?? "200", 10);
    const search   = searchParams.get("search")  ?? undefined;
    const gamme    = searchParams.get("gamme")   ?? undefined;
    const code3    = searchParams.get("code3")   ?? undefined;

    try {
        const result = await getProductRows({
            codeFournisseur,
            page:     isNaN(page)     ? 0   : page,
            pageSize: isNaN(pageSize) ? 200 : pageSize,
            search,
            gamme:    gamme  || null,
            code3:    code3  || null,
        });

        return NextResponse.json(result, {
            status: 200,
            headers: {
                "Cache-Control": "private, max-age=30, stale-while-revalidate=60",
            },
        });
    } catch (error) {
        console.error("[GET /api/grid/rows] Error:", error);
        return NextResponse.json({ error: "Erreur lors de la récupération des données" }, { status: 500 });
    }
}
