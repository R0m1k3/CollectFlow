//! Test d'intégration contre une vraie base PostgreSQL : `grid_rows`,
//! `session_snapshots`, `gammes_a_valider`.
//!
//! Désactivé par défaut. Pour le lancer :
//!
//! ```sh
//! GRID_TEST_DATABASE_URL=postgres://postgres:postgres@localhost/collectflow cargo test grid::tests_db
//! ```
//!
//! Les données de test portent des codes fournisseur `TSTGRID…`, supprimés avant
//! et après le passage.

use super::api_schemas::query_map;
use super::enregistrer::{enregistrer_brouillon, enregistrer_gammes, ChangementGamme, EnregistrementGammes};
use super::gammes_a_valider::*;
use super::rows_cache;
use super::snapshots::{enregistrer_snapshot, lister_snapshots, supprimer_snapshot};
use super::store::*;
use super::types::ProductRow;
use serde_json::{json, Value};
use std::time::Duration;

const F1: &str = "TSTGRID1";
const F2: &str = "TSTGRID2";

fn ligne(codein: &str, noid: f64, libelle: &str, code3: &str, ca: f64) -> ProductRow {
    let mut r: ProductRow = serde_json::from_value(json!({
        "codein": codein, "codeFournisseur": F1, "nomFournisseur": "FOURNISSEUR TEST",
        "libelle1": libelle, "gtin": format!("370{codein}"), "reference": format!("REF-{codein}"),
        "codeCentrale": format!("10000{codein}"),
        "code1": &code3[..2], "libelleNiveau1": "Univers", "code2": &code3[..4], "libelleNiveau2": "Famille",
        "code3": code3, "libelle3": format!("Sous-famille {code3}"),
        "codeGamme": "B", "codeGammeInit": "B", "codeGammeDraft": null,
        "sales12m": { "202509": 1, "202510": 2 }, "stock12m": { "202509": 5, "202510": 4 },
        "receptions12m": { "202509": 0, "202510": 0 },
        "totalQuantite": 3, "totalCa": ca, "totalMarge": ca / 4.0, "tauxMarge": 25,
        "workingStores": ["292"], "noid": noid, "stockActuel": 4.5, "nbMagasinsReseau": 120,
        "qteReseauByMonth": null, "champInconnu": { "garde": true }
    }))
    .unwrap();
    r.libelle1 = libelle.to_string();
    r
}

async fn nettoyer(pool: &sqlx::PgPool) {
    for t in ["grid_rows", "session_snapshots", "gammes_a_valider"] {
        sqlx::query(&format!("delete from {t} where code_fournisseur like 'TSTGRID%'")).execute(pool).await.unwrap();
    }
}

#[tokio::test]
async fn grid_rows_snapshots_gammes_a_valider() {
    let Ok(url) = std::env::var("GRID_TEST_DATABASE_URL") else {
        eprintln!("GRID_TEST_DATABASE_URL absent : test d'intégration ignoré.");
        return;
    };
    let _verrou = rows_cache::TEST_LOCK.lock();
    // La configuration lue par `db::pool()` : pas de fichier de réglages, l'URL de test.
    let dir = std::env::temp_dir().join(format!("grid-tests-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    std::env::set_var("DATA_DIR", &dir);
    std::env::set_var("DATABASE_URL", &url);
    let pool = crate::db::pool().unwrap();
    sqlx::raw_sql(include_str!("../../sql/init.sql")).execute(&pool).await.unwrap();
    nettoyer(&pool).await;

    // ── upsert / lecture de l'instantané ────────────────────────────────────
    let rows = vec![
        ligne("900002", 20.0, "Vase en verre", "320212", 50.0),
        ligne("900001", 10.0, "Bougie parfumée", "320211", 150.0),
        ProductRow { codein: String::new(), ..Default::default() },
        ligne("900003", 5.0, "Cadre photo", "330101", 0.125),
    ];
    assert_eq!(upsert_grid_rows(F1, &rows).await.unwrap(), 3);
    assert_eq!(upsert_grid_rows("", &rows).await.unwrap(), 0);

    let snap = read_grid_snapshot(F1).await.unwrap().expect("instantané");
    let codes: Vec<&str> = snap.rows.iter().map(|r| r.codein.as_str()).collect();
    assert_eq!(codes, vec!["900003", "900001", "900002"], "tri par noid");
    assert_eq!(snap.rows[1].payload_version, Some(GRID_PAYLOAD_VERSION));
    let mut relu = serde_json::to_value(&snap.rows[1]).unwrap();
    relu.as_object_mut().unwrap().remove("payloadVersion");
    assert_eq!(relu, serde_json::to_value(&rows[1]).unwrap(), "aller-retour du payload");
    assert!(read_grid_snapshot("TSTGRID-ABSENT").await.unwrap().is_none());

    // Colonnes scalaires (numeric arrondi par PostgreSQL).
    let (ca, nb): (f64, Option<i32>) =
        sqlx::query_as("select total_ca::float8, nb_magasins_reseau from grid_rows where code_fournisseur = $1 and codein = '900003'")
            .bind(F1)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!((ca, nb), (0.13, Some(120)));

    // Une ligne d'un ancien format n'est pas servie à la Grille.
    sqlx::query("update grid_rows set payload = payload - 'payloadVersion' where code_fournisseur = $1 and codein = '900002'")
        .bind(F1)
        .execute(&pool)
        .await
        .unwrap();
    assert!(read_grid_snapshot(F1).await.unwrap().is_none());
    assert_eq!(upsert_grid_rows(F1, &rows).await.unwrap(), 3);

    // ── requêtes filtrées / triées / paginées ──────────────────────────────
    let tout = query_grid_rows(&GridQuery { code_fournisseur: Some(F1.into()), ..Default::default() }).await.unwrap();
    assert_eq!(tout.total, 3);
    assert_eq!(tout.rows.iter().map(|r| r.codein.as_str()).collect::<Vec<_>>(), vec!["900001", "900002", "900003"]);
    assert!(tout.rows.iter().all(|r| r.payload_version.is_none()));
    assert_eq!(tout.rows[0].extra.get("champInconnu"), Some(&json!({ "garde": true })));
    assert!(tout.computed_at.as_deref().unwrap().ends_with('Z'));

    let page2 = query_grid_rows(&GridQuery {
        code_fournisseur: Some(F1.into()),
        sort: Some(GridSortKey::Codein),
        order: Some(SortOrder::Asc),
        page: Some(2),
        limit: Some(1),
        ..Default::default()
    })
    .await
    .unwrap();
    assert_eq!((page2.total, page2.rows.len(), page2.rows[0].codein.as_str()), (3, 1, "900002"));

    let recherche =
        query_grid_rows(&GridQuery { search: Some("  BOUGIE ".into()), code_fournisseur: Some(F1.into()), ..Default::default() })
            .await
            .unwrap();
    assert_eq!(recherche.total, 1);
    let par_centrale = query_grid_rows(&GridQuery { search: Some("10000900003".into()), ..Default::default() }).await.unwrap();
    assert_eq!(par_centrale.rows[0].codein, "900003");
    let nomenclature =
        query_grid_rows(&GridQuery { code_fournisseur: Some(F1.into()), nomenclature: Some("3202".into()), ..Default::default() })
            .await
            .unwrap();
    assert_eq!(nomenclature.total, 2);
    // Une valeur hostile reste une valeur liée.
    let hostile = query_grid_rows(&GridQuery { code_fournisseur: Some("x' or '1'='1".into()), ..Default::default() }).await.unwrap();
    assert_eq!(hostile.total, 0);

    // ── gammes, fiches, fournisseurs, fraîcheur, nomenclatures ─────────────
    update_grid_rows_gamme(F1, [("900001", "A"), ("900002", "Z"), ("900003", "A")]).await.unwrap();
    let gammes = get_grid_rows_gammes(F1, &["900001".into(), "900002".into(), "inconnu".into()]).await.unwrap();
    assert_eq!(gammes.len(), 2);
    assert_eq!(gammes["900001"].code_gamme.as_deref(), Some("A"));
    assert_eq!(gammes["900001"].code_gamme_init.as_deref(), Some("B"));
    let fiche = get_grid_row_by_codein("900002", Some(F1)).await.unwrap().unwrap();
    assert_eq!(fiche.row.code_gamme.as_deref(), Some("Z"), "payload mis à jour");
    assert!(get_grid_row_by_codein("900002", Some("TSTGRID-ABSENT")).await.unwrap().is_none());

    let mut chez_f2 = ligne("900001", 1.0, "Bougie parfumée", "320211", 1.0);
    chez_f2.code_fournisseur = F2.into();
    upsert_grid_rows(F2, &[chez_f2]).await.unwrap();
    let fournisseurs: Vec<String> =
        list_grid_suppliers_for_codein("900001").await.unwrap().into_iter().map(|f| f.code_fournisseur).collect();
    assert!(fournisseurs.contains(&F1.to_string()) && fournisseurs.contains(&F2.to_string()));
    let tous = list_grid_suppliers().await.unwrap();
    let f1 = tous.iter().find(|s| s.code_fournisseur == F1).unwrap();
    assert_eq!((f1.row_count, f1.nom_fournisseur.as_deref()), (3, Some("FOURNISSEUR TEST")));

    let fraicheur = get_grid_freshness(F1).await.unwrap().unwrap();
    assert_eq!(fraicheur.row_count, 3);
    assert!(get_grid_freshness("TSTGRID-ABSENT").await.unwrap().is_none());

    let n1 = list_grid_nomenclatures(F1, 1, None).await.unwrap();
    assert_eq!(n1.iter().map(|n| (n.code.as_str(), n.nb_articles)).collect::<Vec<_>>(), vec![("32", 2), ("33", 1)]);
    assert_eq!(n1[0].libelle.as_deref(), Some("Univers"));
    assert_eq!(n1[0].total_ca, 200.0);
    let n3 = list_grid_nomenclatures(F1, 3, Some("3202")).await.unwrap();
    assert_eq!(n3.iter().map(|n| n.code.as_str()).collect::<Vec<_>>(), vec!["320211", "320212"]);
    assert_eq!(n3[0].libelle.as_deref(), Some("Sous-famille 320211"));

    // Purge : un nouveau calcul sans l'article 900003 le retire.
    tokio::time::sleep(Duration::from_millis(5)).await;
    assert_eq!(upsert_grid_rows(F1, &rows[..2]).await.unwrap(), 2);
    assert_eq!(get_grid_freshness(F1).await.unwrap().unwrap().row_count, 2);

    // ── snapshots (actions) ────────────────────────────────────────────────
    let brut = json!({ "codeFournisseur": F1, "magasin": "TOTAL", "changes": { "900001": { "before": "B", "after": "A" } } });
    let anonyme = enregistrer_snapshot("0", &brut).await;
    assert_eq!(anonyme["success"], true, "{anonyme}");
    let id_anonyme = anonyme["snapshotId"].as_i64().unwrap();
    let a_moi = enregistrer_snapshot("987654", &json!({ "codeFournisseur": F1, "magasin": "292", "type": "export", "label": "Mon export", "changes": {}, "summary": { "totalRows": 1, "totalCa": 2.5, "totalMarge": 1, "tauxMargeGlobal": 40 } })).await;
    assert_eq!(a_moi["success"], true, "{a_moi}");
    let id_a_moi = a_moi["snapshotId"].as_i64().unwrap();

    let ids = |v: Vec<super::snapshots::SessionSnapshot>| -> Vec<i64> {
        v.into_iter().filter(|s| s.code_fournisseur == F1).map(|s| s.id as i64).collect()
    };
    assert_eq!(ids(lister_snapshots("0", None).await.unwrap()), vec![id_anonyme]);
    assert_eq!(ids(lister_snapshots("abc", None).await.unwrap()), vec![id_anonyme], "identifiant non numérique = anonyme");
    assert_eq!(ids(lister_snapshots("987654", Some("export")).await.unwrap()), vec![id_a_moi]);
    assert!(ids(lister_snapshots("987654", Some("snapshot")).await.unwrap()).is_empty());
    let detail = lister_snapshots("987654", None).await.unwrap().into_iter().find(|s| s.id as i64 == id_a_moi).unwrap();
    let detail = serde_json::to_value(detail).unwrap();
    assert_eq!(detail["label"], "Mon export");
    assert_eq!(detail["userId"], 987654);
    assert_eq!(detail["summaryJson"], json!({ "totalRows": 1, "totalCa": 2.5, "totalMarge": 1, "tauxMargeGlobal": 40 }));
    assert!(detail["createdAt"].as_str().unwrap().ends_with('Z'));
    assert!(lister_snapshots("99999999999", None).await.is_err(), "hors bornes integer : erreur SQL comme en TS");

    let label_defaut: (String,) =
        sqlx::query_as("select label from session_snapshots where id = $1").bind(id_anonyme as i32).fetch_one(&pool).await.unwrap();
    assert!(label_defaut.0.starts_with("Snapshot — "));

    let invalide = enregistrer_snapshot("0", &json!({ "codeFournisseur": F1 })).await;
    assert_eq!(
        invalide,
        json!({ "success": false, "error": "Validation failed: Invalid input: expected string, received undefined, Invalid input: expected record, received undefined" })
    );
    let trop_grand = enregistrer_snapshot("99999999999", &brut).await;
    assert_eq!(trop_grand, json!({ "success": false, "error": "erreur technique sur le serveur" }));

    assert_eq!(
        supprimer_snapshot("0", &json!(id_a_moi)).await,
        json!({ "success": false, "error": "Snapshot non trouvé ou non autorisé" })
    );
    assert_eq!(supprimer_snapshot("987654", &json!(id_a_moi)).await, json!({ "success": true }));
    assert_eq!(supprimer_snapshot("0", &json!("abc")).await, json!({ "success": false, "error": "erreur technique sur le serveur" }));

    // ── enregistrerGammes / saveDraftChanges ───────────────────────────────
    rows_cache::invalidate_grid_rows_cache(None);
    let en_cache = rows_cache::GridRows::new(rows[..2].to_vec());
    rows_cache::cache_grid_rows(&rows_cache::grid_rows_cache_key(F1, None), en_cache.clone());
    let n = enregistrer_gammes(&EnregistrementGammes {
        code_fournisseur: F1.into(),
        nom_fournisseur: Some("FOURNISSEUR TEST".into()),
        magasin: "TOTAL".into(),
        changes: vec![ChangementGamme { codein: "900002".into(), code_gamme_before: Some("B".into()), code_gamme: "C".into() }],
        user_id: None,
        label: None,
    })
    .await
    .unwrap();
    assert_eq!(n, 1);
    let dernier: (Value, Option<String>) =
        sqlx::query_as("select changes, label from session_snapshots where code_fournisseur = $1 order by created_at desc limit 1")
            .bind(F1)
            .fetch_one(&pool)
            .await
            .unwrap();
    // Fusion par-dessus le dernier snapshot du fournisseur (celui de 987654 a été supprimé).
    assert_eq!(dernier.0, json!({ "900001": { "before": "B", "after": "A" }, "900002": { "before": "B", "after": "C" } }));
    assert!(dernier.1.unwrap().starts_with("Draft — "));
    assert_eq!(en_cache.rows.read()[0].code_gamme.as_deref(), Some("C"), "cache patché (900002)");
    // Le report dans grid_rows est asynchrone.
    let mut vu = false;
    for _ in 0..50 {
        let g = get_grid_rows_gammes(F1, &["900002".into()]).await.unwrap();
        if g["900002"].code_gamme.as_deref() == Some("C") {
            vu = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(vu, "grid_rows mis à jour en arrière-plan");

    // ── gammes à valider ───────────────────────────────────────────────────
    let p = |c: &str, g: &str| PropositionGamme { codein: c.into(), gamme: g.into(), gamme_precedente: Some("B".into()) };
    proposer_gammes(F1, &[p("900001", "Z"), p("900002", "A")], &[], &"x".repeat(150)).await.unwrap();
    proposer_gammes(F1, &[p("900002", "Y")], &["900001".into()], "api-key").await.unwrap();
    let liste = lister_gammes_a_valider(F1).await.unwrap();
    assert_eq!(liste.len(), 1);
    assert_eq!((liste[0].codein.as_str(), liste[0].gamme.as_str(), liste[0].auteur.as_deref()), ("900002", "Y", Some("api-key")));
    assert!(liste[0].proposee_le.ends_with('Z'));
    let par_article = gammes_a_valider_par_article(&["900002".into(), "900009".into()]).await.unwrap();
    assert_eq!(par_article.get(&format!("{F1}|900002")).map(String::as_str), Some("Y"));
    proposer_gammes(F1, &[p("900001", "Z")], &[], &"x".repeat(150)).await.unwrap();
    let auteur: (String,) = sqlx::query_as("select auteur from gammes_a_valider where code_fournisseur = $1 and codein = '900001'")
        .bind(F1)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(auteur.0.len(), 100);

    // saveDraftChanges : les propositions traitées quittent la file.
    let res = enregistrer_brouillon(
        "987654",
        &json!({ "codeFournisseur": F1, "magasin": "TOTAL", "changes": [{ "codein": "900002", "codeGammeBefore": "C", "codeGamme": "Y" }], "gammesAValiderTraitees": ["900002"] }),
    )
    .await;
    assert_eq!(res, json!({ "success": true, "saved": 1 }));
    let restantes: Vec<String> = lister_gammes_a_valider(F1).await.unwrap().into_iter().map(|g| g.codein).collect();
    assert_eq!(restantes, vec!["900001".to_string()]);
    supprimer_gammes_a_valider(F1, &["900001".into()]).await.unwrap();
    assert!(lister_gammes_a_valider(F1).await.unwrap().is_empty());
    let invalide = enregistrer_brouillon("0", &json!({ "codeFournisseur": F1 })).await;
    assert_eq!(invalide["success"], false);
    assert!(invalide["error"].as_str().unwrap().starts_with("Validation failed: [\n  {\n    \"expected\": \"string\""));

    // ── route /api/v1/nomenclatures (sans HTTP : schéma + requêtes) ────────
    let params = query_map(vec![("fournisseur".into(), F1.into()), ("niveau".into(), "2".into())]);
    let parsed = super::api_schemas::parse_nomenclatures_query(&params).unwrap();
    let postes = list_grid_nomenclatures(&parsed.fournisseur, parsed.niveau, None).await.unwrap();
    assert_eq!(postes.iter().map(|p| p.code.as_str()).collect::<Vec<_>>(), vec!["3202"]);

    nettoyer(&pool).await;
    rows_cache::invalidate_grid_rows_cache(None);
}
