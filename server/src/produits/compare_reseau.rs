//! CollectFlow — Comparatif local vs réseau pour un produit — partie serveur de
//! `src/features/produits/lib/compare-reseau.ts`.
//!
//! Le calcul du comparatif lui-même (`computeComparatif`, `indiceVerdict`) reste
//! côté interface : seul `normalizeMargePct` sert au serveur (recherche produit).

/// Le taux de marge Qlik est un ratio brut (0.32 = 32 %) mais certaines
/// configurations renvoient déjà des points de pourcentage. Même normalisation
/// que la colonne « Marge % / Réseau » de la Grille.
pub fn normalize_marge_pct(raw: Option<f64>) -> Option<f64> {
    let v = raw?;
    if !v.is_finite() || v == 0.0 {
        return None;
    }
    Some(if v.abs() <= 1.0 { v * 100.0 } else { v })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ratio_brut_converti_en_points() {
        assert_eq!(normalize_marge_pct(Some(0.32)), Some(32.0));
        assert_eq!(normalize_marge_pct(Some(-0.5)), Some(-50.0));
        assert_eq!(normalize_marge_pct(Some(1.0)), Some(100.0));
    }

    #[test]
    fn points_de_pourcentage_conserves() {
        assert_eq!(normalize_marge_pct(Some(32.5)), Some(32.5));
        assert_eq!(normalize_marge_pct(Some(-12.0)), Some(-12.0));
    }

    #[test]
    fn absent_nul_ou_non_fini() {
        assert_eq!(normalize_marge_pct(None), None);
        assert_eq!(normalize_marge_pct(Some(0.0)), None);
        assert_eq!(normalize_marge_pct(Some(f64::NAN)), None);
        assert_eq!(normalize_marge_pct(Some(f64::INFINITY)), None);
    }
}
