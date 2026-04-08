import { pgGetCommandesAuto, type PgCommandeAutoRow } from "@/lib/pg-ff-client";
import { CommandesAutoClient } from "./client";

export type { PgCommandeAutoRow };

export default async function CommandesAutoPage() {
    const rows = await pgGetCommandesAuto();
    return (
        <div className="min-h-screen bg-gray-50 p-6">
            <div className="mx-auto max-w-screen-2xl">
                <h1 className="mb-6 text-3xl font-bold text-gray-900">Commandes automatiques</h1>
                <CommandesAutoClient rows={rows} />
            </div>
        </div>
    );
}
