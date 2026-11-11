//! Format mémoire des lignes de grille : poids et JSON inchangé.

/// JSON des lignes identique, à l'octet près, à celui produit avec les `BTreeMap`
/// (référence générée par la version précédente du code) : ordre des clés, `null`,
/// doublons, clés longues, ventilations vides.
#[test]
fn json_identique_a_la_reference() {
    let entrees = [
        r#"{"codein":"1","sales12m":{"202612":1,"202601":2.5,"202603":null},"stock12m":{},"receptions12m":null,"sales12mByStore":{"579":{"202601":1,"202512":null},"292":null},"caByStore":{"292":1.25,"579":null},"qteReseauByMonth":null,"nbMagReseauByMonth":{"2026-01":3,"2025-12":2},"derniereLivraisonByStore":{"579":"2026-01-02","292":"2025-12-01"},"prixVenteByStore":{"une clé nettement plus longue que quinze":9.99,"292":1},"workingStores":["292"],"totalCa":12.5,"autre":{"x":1}}"#,
        r#"{"codein":"2","sales12m":{"202601":1,"202601":7},"stock12mByStore":{},"receptions12mByStore":{"292":{}}}"#,
        r#"{"codein":"3"}"#,
    ];
    let mut out = String::new();
    for e in entrees {
        let r: super::types::ProductRow = serde_json::from_str(e).unwrap();
        out.push_str(&serde_json::to_string(&r).unwrap());
        out.push('\n');
        let v: serde_json::Value = serde_json::from_str(e).unwrap();
        let r2: super::types::ProductRow = serde_json::from_value(v).unwrap();
        out.push_str(&serde_json::to_string(&r2).unwrap());
        out.push('\n');
    }
    assert_eq!(out, include_str!("testdata/lignes_json_reference.jsonl"));
}

/// Poids mémoire d'une ligne réaliste (2 magasins, 12 mois) : ~22 Ko avec les
/// `BTreeMap`, ~4,4 Ko avec [`super::compact::CompactMap`].
#[test]
fn poids_memoire_d_une_ligne() {
    use serde_json::json;
    let mois: Vec<String> = (1..=12).map(|m| format!("2026{m:02}")).collect();
    let mois_q: Vec<String> = (1..=12).map(|m| format!("2026-{m:02}")).collect();
    let serie = |ks: &Vec<String>| serde_json::Value::Object(ks.iter().map(|k| (k.clone(), json!(3.5))).collect());
    let par_mag = |ks: &Vec<String>| json!({ "292": serie(ks), "579": serie(ks) });
    let mags = json!({ "292": 1.5, "579": 2.5 });
    let ligne = json!({
        "codein": "123456789", "codeFournisseur": "F001", "nomFournisseur": "FOURNISSEUR TEST", "gtin": "3700000000000",
        "reference": "REF-001", "libelle1": "Un libellé produit assez long", "code1": "01", "libelleNiveau1": "Maison",
        "code2": "0101", "libelleNiveau2": "Cuisine", "code3": "010101", "libelle3": "Ustensiles",
        "codeGamme": "A", "codeGammeInit": "A",
        "sales12m": serie(&mois), "stock12m": serie(&mois), "receptions12m": serie(&mois),
        "sales12mByStore": par_mag(&mois), "stock12mByStore": par_mag(&mois), "receptions12mByStore": par_mag(&mois),
        "caByStore": mags, "caTtcByStore": mags, "quantiteByStore": mags, "margeByStore": mags, "prixVenteByStore": mags,
        "derniereLivraisonByStore": { "292": "2026-10-01", "579": "2026-09-12" },
        "workingStores": ["292", "579"], "qteReseauByMonth": serie(&mois_q), "nbMagReseauByMonth": serie(&mois_q),
        "totalQuantite": 10, "totalCa": 100.5, "tauxMarge": 0.3, "derniereVente": "2026-10-30",
    });
    let texte = ligne.to_string();
    let n = 20_000;
    use tikv_jemalloc_ctl::{epoch, stats};
    epoch::advance().unwrap();
    let avant = stats::allocated::read().unwrap();
    let rows: Vec<super::types::ProductRow> = (0..n).map(|_| serde_json::from_str(&texte).unwrap()).collect();
    epoch::advance().unwrap();
    let apres = stats::allocated::read().unwrap();
    println!("poids json={} o, struct={} o, par ligne={} o, {} lignes={} Mo",
        texte.len(), std::mem::size_of::<super::types::ProductRow>(), (apres - avant) / n, n, (apres - avant) / 1_048_576);
    let par_ligne = (apres - avant) / n;
    assert!(par_ligne < 6_000, "ligne de grille trop lourde en mémoire : {par_ligne} octets");
    drop(rows);
}
