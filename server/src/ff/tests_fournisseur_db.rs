//! Test d'intégration contre une vraie base PostgreSQL : rattachement d'un
//! article à son fournisseur quand aucun n'est marqué principal, ou quand
//! aucune ligne `artfou1` n'existe (cas du codein 504202).
//!
//! Désactivé par défaut. Pour le lancer (base JETABLE : les tables FF de test
//! y sont recréées) :
//!
//! ```sh
//! FF_FOURNISSEUR_TEST_DATABASE_URL=postgres://postgres:postgres@localhost/fftest cargo test ff::tests_fournisseur_db
//! ```

use super::pg::*;

const SCHEMA: &str = r#"
DROP TABLE IF EXISTS articles, artfou1, fouident, mvtart, cube_stock, nomenclature;
CREATE TABLE articles (no_id bigint PRIMARY KEY, codein char(10), artcentrale char(20), libelle1 text, nom_no_id bigint, suspendu text);
CREATE TABLE artfou1 (no_id bigint PRIMARY KEY, art_no_id bigint, code text, preference int, reference text, pcb numeric);
CREATE TABLE fouident (code text PRIMARY KEY, nom text);
CREATE TABLE nomenclature (no_id bigint PRIMARY KEY, code text, libelle text);
CREATE TABLE mvtart (no_id bigint PRIMARY KEY, artnoid bigint, site text, genremvt int, datmvt date, qtemvt numeric, mntmvtttc numeric, margemvt numeric);
CREATE TABLE cube_stock (artnoid bigint, site text, qte numeric, dernierevente date);

INSERT INTO fouident VALUES ('F1', 'ALPHA'), ('F2', 'BETA');
-- 1 : aucune ligne artfou1, fournisseur connu du réseau (cas 504202)
-- 2 : un seul fournisseur, non marqué principal
-- 3 : un principal (F2) et un secondaire (F1)
-- 4 : aucun fournisseur nulle part
INSERT INTO articles VALUES
    (1, '504202', 'CC504202', 'Article sans artfou1', NULL, NULL),
    (2, '100001', 'CC100001', 'Article sans principal', NULL, NULL),
    (3, '100002', 'CC100002', 'Article avec principal', NULL, NULL),
    (4, '100003', 'CC100003', 'Article orphelin', NULL, NULL);
INSERT INTO artfou1 VALUES (10, 2, 'F1', 0, 'R2', 1), (11, 3, 'F1', 0, 'R3a', 1), (12, 3, 'F2', 1, 'R3b', 1);
INSERT INTO cube_stock VALUES (1, '292', -2, NULL), (2, '292', -3, NULL), (3, '292', -4, NULL), (4, '292', -5, NULL);
INSERT INTO mvtart VALUES
    (100, 1, '292', 1, DATE '2020-01-10', 10, 0, 0),
    (101, 2, '292', 1, DATE '2020-01-10', 10, 0, 0),
    (102, 3, '292', 1, DATE '2020-01-10', 10, 0, 0),
    (103, 4, '292', 1, DATE '2020-01-10', 10, 0, 0),
    (110, 1, '292', 3, DATE '2026-03-05', -1, -10, 3),
    (111, 2, '292', 3, DATE '2026-03-05', -1, -10, 3),
    (112, 3, '292', 3, DATE '2026-03-05', -1, -10, 3),
    (113, 4, '292', 3, DATE '2026-03-05', -1, -10, 3);
DELETE FROM qlik_network_metrics WHERE code_centrale LIKE 'CC%';
INSERT INTO qlik_network_metrics (code_centrale, fournisseur_reseau) VALUES ('CC504202', 'FOURNISSEUR RESEAU');
"#;

fn attendu(codein: &str) -> &'static str {
    match codein {
        "504202" => "FOURNISSEUR RESEAU",
        "100001" => "ALPHA",
        "100002" => "BETA",
        "100003" => "Sans fournisseur",
        autre => panic!("codein inattendu : {autre}"),
    }
}

#[tokio::test]
async fn article_sans_fournisseur_principal() {
    let Ok(url) = std::env::var("FF_FOURNISSEUR_TEST_DATABASE_URL") else {
        eprintln!("FF_FOURNISSEUR_TEST_DATABASE_URL absent : test d'intégration ignoré.");
        return;
    };
    let _verrou = crate::grid::rows_cache::TEST_LOCK.lock();
    let dir = std::env::temp_dir().join(format!("ff-tests-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    std::env::set_var("DATA_DIR", &dir);
    std::env::set_var("DATABASE_URL", &url);
    crate::db::refresh();
    let pool = crate::db::pool().unwrap();
    sqlx::raw_sql(include_str!("../../sql/init.sql")).execute(&pool).await.unwrap();
    sqlx::raw_sql(SCHEMA).execute(&pool).await.unwrap();

    // Stock négatif : les 4 articles sont listés, aucun n'est écarté faute de principal.
    let neg = pg_get_stock_negatif(None).await.unwrap();
    assert_eq!(neg.len(), 4, "{neg:?}");
    for r in &neg {
        assert_eq!(r.fournisseur, attendu(r.codein.trim()), "stock négatif {}", r.codein);
    }

    let hp = pg_get_hit_parade("2026-03-01", "2026-03-31").await.unwrap();
    assert_eq!(hp.len(), 4, "{hp:?}");
    for r in &hp {
        assert_eq!(r.fournisseur, attendu(&r.codein), "hit parade {}", r.codein);
    }

    let ca = pg_get_ca_by_fournisseur("2026-03", "2025-03").await.unwrap();
    let nom = |code: &str| ca.iter().find(|r| r.code == code).map(|r| r.nom.clone());
    assert_eq!(nom("F1").as_deref(), Some("ALPHA"), "{ca:?}");
    assert_eq!(nom("F2").as_deref(), Some("BETA"), "{ca:?}");
    assert_eq!(nom("SANS_FOURNISSEUR").as_deref(), Some("Sans fournisseur"), "{ca:?}");

    let receptions = pg_get_derniere_reception_par_fournisseur(None).await;
    assert!(receptions.contains_key("F1|292"), "{receptions:?}");

    let trouves = pg_search_produits("504202", 10).await;
    assert_eq!(trouves.first().map(|r| r.fournisseur.as_str()), Some("FOURNISSEUR RESEAU"), "{trouves:?}");

    let catalogue = pg_get_produits_by_code_centrale(&["CC504202".into(), "CC100001".into(), "CC100003".into()]).await;
    assert_eq!(catalogue["CC504202"].fournisseur, "FOURNISSEUR RESEAU");
    assert_eq!(catalogue["CC100001"].fournisseur, "ALPHA");
    assert_eq!(catalogue["CC100003"].fournisseur, "Sans fournisseur");
    assert!(catalogue["CC504202"].codefou.is_empty());
}
