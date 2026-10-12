//! CollectFlow - Core Grid Types (port de `src/types/grid.ts`).
//!
//! `ProductRow` circule tel quel en JSON : vers la Grille, dans `grid_rows.payload`
//! (jsonb) et dans l'API `/api/v1`. Les attributs serde reproduisent
//! `JSON.stringify` : noms camelCase, champs facultatifs omis quand ils sont
//! `undefined`, `null` conservé pour les champs `| null`, entiers sans décimale.
//!
//! Lecture tolérante : un payload écrit par la version Node se relit sans perte —
//! champ manquant → valeur par défaut, `null` numérique → `NaN` (réécrit `null`),
//! champ inconnu conservé dans `extra` et réécrit à l'identique.

use super::js;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeMap;

/// A/B/C/Z status codes for product categories, but can be any string from DB (like 'Aucune')
pub type GammeCode = String;

/// Série mensuelle `{ "YYYYMM": valeur }` (ou `"YYYY-MM"` pour le réseau Qlik).
pub type Serie = BTreeMap<String, f64>;
/// Ventilation par magasin puis par mois.
pub type SerieParMagasin = BTreeMap<String, Serie>;

/// A product row with its 12-month sales history and computed KPIs.
///
/// Ordre des champs = ordre de construction dans `getProductRows` (donc celui du
/// JSON produit par le calcul en direct).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ProductRow {
    #[serde(deserialize_with = "js::string::deserialize")]
    pub codein: String,
    #[serde(deserialize_with = "js::string::deserialize")]
    pub code_fournisseur: String,
    #[serde(deserialize_with = "js::string::deserialize")]
    pub nom_fournisseur: String,
    /// Dernier fournisseur enregistré pour cet article (artfou1.no_id DESC). Peut différer du fournisseur consulté.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fournisseur_principal_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fournisseur_principal_nom: Option<String>,
    #[serde(deserialize_with = "js::string::deserialize")]
    pub libelle1: String,
    #[serde(deserialize_with = "js::string::deserialize")]
    pub gtin: String,
    #[serde(deserialize_with = "js::string::deserialize")]
    pub reference: String,
    /// Code centrale (clé jointure Qlik, format 10000XXXXXX)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code_centrale: Option<String>,
    #[serde(deserialize_with = "js::string::deserialize")]
    pub code1: String,
    #[serde(deserialize_with = "js::string::deserialize")]
    pub libelle_niveau1: String,
    #[serde(deserialize_with = "js::string::deserialize")]
    pub code2: String,
    #[serde(deserialize_with = "js::string::deserialize")]
    pub libelle_niveau2: String,
    #[serde(deserialize_with = "js::string::deserialize")]
    pub code3: String,
    #[serde(deserialize_with = "js::string::deserialize")]
    pub libelle3: String,
    pub code_gamme: Option<GammeCode>,
    pub code_gamme_init: Option<GammeCode>,
    /// Draft gamme value before saving
    pub code_gamme_draft: Option<GammeCode>,
    /// 12-month sales quantities, indexed by YYYYMM key
    #[serde(with = "js::map")]
    pub sales12m: Serie,
    /// End-of-month stock levels, indexed by YYYYMM key
    #[serde(with = "js::map")]
    pub stock12m: Serie,
    /// Monthly reception quantities, indexed by YYYYMM key
    #[serde(with = "js::map")]
    pub receptions12m: Serie,
    #[serde(with = "js::num")]
    pub total_quantite: f64,
    #[serde(with = "js::num")]
    pub total_ca: f64,
    #[serde(with = "js::num")]
    pub total_marge: f64,
    #[serde(with = "js::num")]
    pub taux_marge: f64,
    pub working_stores: Vec<String>,
    /// SQL Server internal ID — nécessaire pour /api/articles/:noid/mensuel
    #[serde(skip_serializing_if = "Option::is_none", with = "js::opt_num")]
    pub noid: Option<f64>,
    /// Conditionnement (pack size)
    #[serde(skip_serializing_if = "Option::is_none", with = "js::opt_num")]
    pub pcb: Option<f64>,
    /// Prix de vente pratiqué, en euros (le plus élevé quand les magasins divergent :
    /// `prixVenteByStore` porte le détail).
    #[serde(skip_serializing_if = "Option::is_none", with = "js::opt_num")]
    pub prix_vente: Option<f64>,
    /// Per-store breakdown (site → YYYYMM → qty) — always present even in TOTAL mode
    #[serde(skip_serializing_if = "Option::is_none", with = "js::opt_nested_map")]
    pub sales12m_by_store: Option<SerieParMagasin>,
    /// Per-store stock breakdown (site → YYYYMM → stock fin de mois)
    #[serde(skip_serializing_if = "Option::is_none", with = "js::opt_nested_map")]
    pub stock12m_by_store: Option<SerieParMagasin>,
    /// Per-store reception breakdown (site → YYYYMM → qté reçue)
    #[serde(skip_serializing_if = "Option::is_none", with = "js::opt_nested_map")]
    pub receptions12m_by_store: Option<SerieParMagasin>,
    /// Per-store CA totals
    #[serde(skip_serializing_if = "Option::is_none", with = "js::opt_map")]
    pub ca_by_store: Option<Serie>,
    /// Per-store quantity totals
    #[serde(skip_serializing_if = "Option::is_none", with = "js::opt_map")]
    pub quantite_by_store: Option<Serie>,
    /// Per-store margin totals
    #[serde(skip_serializing_if = "Option::is_none", with = "js::opt_map")]
    pub marge_by_store: Option<Serie>,
    /// Qté en commande fournisseur
    #[serde(skip_serializing_if = "Option::is_none", with = "js::opt_num")]
    pub commandes_en_cours: Option<f64>,
    /// Stock dispo agrégé tous sites
    #[serde(skip_serializing_if = "Option::is_none", with = "js::opt_num")]
    pub stock_actuel: Option<f64>,
    /// Qte en stock agrégé
    #[serde(skip_serializing_if = "Option::is_none", with = "js::opt_num")]
    pub stock_total: Option<f64>,
    /// Valeur stock agrégée
    #[serde(skip_serializing_if = "Option::is_none", with = "js::opt_num")]
    pub stock_valeur: Option<f64>,
    /// PRMP (alias prixAchat)
    #[serde(skip_serializing_if = "Option::is_none", with = "js::opt_num")]
    pub pa: Option<f64>,
    /// PA / PRMP
    #[serde(skip_serializing_if = "Option::is_none", with = "js::opt_num")]
    pub prix_achat: Option<f64>,
    /// ISO date de dernière vente
    #[serde(skip_serializing_if = "Option::is_none")]
    pub derniere_vente: Option<String>,
    /// ISO date de dernière réception
    #[serde(skip_serializing_if = "Option::is_none")]
    pub derniere_livraison: Option<String>,
    /// Per-store last delivery/reception date (site → ISO date string)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub derniere_livraison_by_store: Option<BTreeMap<String, String>>,
    /// Prix de vente par magasin (site → PV) — `cube_pv`.
    #[serde(skip_serializing_if = "Option::is_none", with = "js::opt_map")]
    pub prix_vente_by_store: Option<Serie>,
    /// Données réseau Qlik (~270 magasins)
    #[serde(skip_serializing_if = "Option::is_none", with = "js::opt_num")]
    pub ca_reseau: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none", with = "js::opt_num")]
    pub qte_reseau: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none", with = "js::opt_num")]
    pub nb_magasins_reseau: Option<f64>,
    /// CA moyen par magasin réseau (productivité normalisée présence)
    #[serde(skip_serializing_if = "Option::is_none", with = "js::opt_num")]
    pub ca_par_magasin_reseau: Option<f64>,
    /// Taux de marge réseau (ratio brut Qlik, ex 0.32 = 32%)
    #[serde(skip_serializing_if = "Option::is_none", with = "js::opt_num")]
    pub marge_pct_reseau: Option<f64>,
    /// Taux de présence réseau = nbMagasinsReseau / 270
    #[serde(skip_serializing_if = "Option::is_none", with = "js::opt_num")]
    pub taux_presence_reseau: Option<f64>,
    /// Quantité vendue réseau par mois : { "YYYY-MM": qté } (tendance / modal).
    /// `None` = absent, `Some(None)` = `null`.
    #[serde(skip_serializing_if = "Option::is_none", with = "js::opt_null_map")]
    pub qte_reseau_by_month: Option<Option<Serie>>,
    /// Nombre de magasins vendeurs par mois : { "YYYY-MM": nb } (deuxième courbe de
    /// la carte tendance). `None` = absent, `Some(None)` = `null`.
    #[serde(skip_serializing_if = "Option::is_none", with = "js::opt_null_map")]
    pub nb_mag_reseau_by_month: Option<Option<Serie>>,
    /// Fraîcheur des données réseau (ISO)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub network_fetched_at: Option<String>,
    /// Rotation normalisée : unités vendues / magasin / mois
    #[serde(skip_serializing_if = "Option::is_none", with = "js::opt_num")]
    pub units_per_store_per_month: Option<f64>,
    /// CA normalisé : € / magasin / an
    #[serde(skip_serializing_if = "Option::is_none", with = "js::opt_num")]
    pub ca_per_store_per_year: Option<f64>,
    /// Produit récent (≤ 3 mois de données)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_recent: Option<bool>,
    /// Seul produit du fournisseur dans le lot
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_last_product: Option<bool>,
    /// Top 30% CA du lot fournisseur
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_top30_supplier: Option<bool>,
    /// Moyennes de comparaison pour l'IA
    #[serde(skip_serializing_if = "Option::is_none", with = "js::opt_num")]
    pub avg_qty_fournisseur: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none", with = "js::opt_num")]
    pub avg_qty_rayon: Option<f64>,
    /// Poids relatifs (%) du produit chez le fournisseur
    #[serde(skip_serializing_if = "Option::is_none", with = "js::opt_num")]
    pub share_ca: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none", with = "js::opt_num")]
    pub share_marge: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none", with = "js::opt_num")]
    pub share_qty: Option<f64>,
    /// Référentiels globaux
    #[serde(skip_serializing_if = "Option::is_none", with = "js::opt_num")]
    pub total_fournisseur_ca: Option<f64>,
    /// Version du format de la ligne, posée à l'écriture dans `grid_rows`. Une
    /// ligne d'une version antérieure n'est pas servie telle quelle à la Grille
    /// (des champs récents lui manqueraient) : elle est recalculée.
    #[serde(skip_serializing_if = "Option::is_none", with = "js::opt_num")]
    pub payload_version: Option<f64>,
    /// Champs inconnus de ce type (payload écrit par une autre version) : conservés
    /// et réécrits tels quels.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// Summary bar totals for the currently visible/filtered rows
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct GridSummary {
    #[serde(with = "js::num")]
    pub total_products: f64,
    #[serde(with = "js::num")]
    pub total_rows: f64,
    #[serde(with = "js::num")]
    pub total_quantite: f64,
    #[serde(with = "js::num")]
    pub total_ca: f64,
    #[serde(with = "js::num")]
    pub total_marge: f64,
    #[serde(with = "js::num")]
    pub taux_marge_global: f64,
}

/// Filters applied to the grid
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct GridFilters {
    pub magasin: Option<String>,
    pub code_fournisseur: Option<String>,
    pub code1: Option<String>,
    pub code2: Option<String>,
    /// Nomenclatures retenues (codes `code3`).
    /// `None` = aucun filtre (tout s'affiche) ; `Some(vec![])` = rien de coché.
    pub code3: Option<Vec<String>>,
    pub code_gamme: Option<GammeCode>,
    pub search: String,
}

/// One row in the data grid, representing a product at a store for one period.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct VenteProduit {
    #[serde(with = "js::num")]
    pub id: f64,
    pub codein: String,
    pub code_fournisseur: Option<String>,
    pub nom_fournisseur: Option<String>,
    pub libelle1: Option<String>,
    pub gtin: Option<String>,
    pub reference: Option<String>,
    pub code_gamme: Option<GammeCode>,
    pub code_gamme_init: Option<GammeCode>,
    pub code3: Option<String>,
    pub libelle3: Option<String>,
    pub magasin: String,
    pub code_magasin: Option<String>,
    pub annee: Option<f64>,
    pub mois: Option<f64>,
    pub periode: String,
    pub quantite: Option<f64>,
    pub montant_mvt: Option<f64>,
    pub marge_mvt: Option<f64>,
}

// ---------------------------------------------------------------------------
// Complément par magasin (`src/features/grid/lib/store-patch.ts`)
// ---------------------------------------------------------------------------

/// Chiffres d'un article pour le magasin complété.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct StorePatchEntry {
    pub codein: String,
    /// Ventes par mois (« YYYYMM »).
    #[serde(with = "js::map")]
    pub sales: Serie,
    /// Stock de fin de mois, reporté sur les mois sans donnée.
    #[serde(with = "js::map")]
    pub stock: Serie,
    #[serde(with = "js::map")]
    pub receptions: Serie,
    #[serde(with = "js::num")]
    pub quantite: f64,
    #[serde(with = "js::num")]
    pub ca: f64,
    #[serde(with = "js::num")]
    pub marge: f64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct StorePatch {
    pub magasin: String,
    /// Fenêtre des 12 mois du calcul : un complément d'un autre mois est ignoré.
    pub periods: Vec<String>,
    pub entries: Vec<StorePatchEntry>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Ligne telle que l'écrit la version Node (ordre jsonb, null, champ inconnu).
    fn payload_node() -> Value {
        json!({
            "pa": 2.5, "pcb": 6, "gtin": "3700000000001", "noid": 4242,
            "code1": "32", "code2": "3202", "code3": "320211",
            "codein": "123456", "libelle1": "Bougie parfumée", "libelle3": "Bougies",
            "sales12m": { "202510": 3, "202511": 0 }, "stock12m": { "202510": 10, "202511": 10 },
            "totalCa": 37.5, "caByStore": { "292": 37.5 }, "codeGamme": "A",
            "reference": "REF-1", "tauxMarge": 41.2, "prixAchat": 2.5, "totalMarge": 15.45,
            "codeCentrale": "10000123456", "codeGammeInit": "B", "codeGammeDraft": null,
            "nomFournisseur": "FOURNISSEUR TEST", "receptions12m": { "202510": 0, "202511": 0 },
            "totalQuantite": 3, "workingStores": ["292"], "libelleNiveau1": "Déco", "libelleNiveau2": "Senteurs",
            "codeFournisseur": "F001", "payloadVersion": 1, "sales12mByStore": { "292": { "202510": 3 }, "579": {} },
            "qteReseauByMonth": null, "margePctReseau": null, "champFutur": { "x": [1, 2] },
            "derniereLivraisonByStore": { "292": "2025-10-03" }
        })
    }

    #[test]
    fn aller_retour_payload_node() {
        let brut = payload_node();
        let row: ProductRow = serde_json::from_value(brut.clone()).unwrap();
        assert_eq!(row.codein, "123456");
        assert_eq!(row.noid, Some(4242.0));
        assert_eq!(row.code_gamme_draft, None);
        assert_eq!(row.qte_reseau_by_month, Some(None));
        assert!(row.marge_pct_reseau.unwrap().is_nan());
        assert!(row.nb_mag_reseau_by_month.is_none());
        assert_eq!(row.extra.get("champFutur"), Some(&json!({ "x": [1, 2] })));
        // Même contenu JSON après relecture et réécriture.
        let reecrit = serde_json::to_value(&row).unwrap();
        assert_eq!(reecrit, brut);
    }

    #[test]
    fn champs_facultatifs_omis_et_entiers_sans_decimale() {
        let row = ProductRow { codein: "1".into(), total_quantite: 12.0, total_ca: 10.5, ..Default::default() };
        let s = serde_json::to_string(&row).unwrap();
        assert!(s.starts_with(r#"{"codein":"1","codeFournisseur":"","nomFournisseur":"","libelle1":"""#));
        assert!(s.contains(r#""codeGamme":null,"codeGammeInit":null,"codeGammeDraft":null"#));
        assert!(s.contains(r#""totalQuantite":12,"totalCa":10.5"#));
        assert!(!s.contains("noid"));
        assert!(!s.contains("payloadVersion"));
    }
}
