import { pgGetCommandesAuto, type PgCommandeAutoRow } from "@/lib/pg-ff-client";
import { listCadences, getFournisseursPourCadence } from "@/features/commandes-auto/actions";
import { CommandesAutoTabs } from "./tabs";

export type { PgCommandeAutoRow };

export default async function CommandesAutoPage() {
    const [rows, cadences, fournisseurs] = await Promise.all([
        pgGetCommandesAuto(),
        listCadences(),
        getFournisseursPourCadence(),
    ]);

    return (
        <div className="min-h-screen bg-gray-50 p-6">
            <div className="mx-auto max-w-screen-2xl">
                <h1 className="mb-6 text-3xl font-bold text-gray-900">Commandes automatiques</h1>
                <CommandesAutoTabs rows={rows} cadences={cadences} fournisseurs={fournisseurs} />
            </div>
        </div>
    );
}
