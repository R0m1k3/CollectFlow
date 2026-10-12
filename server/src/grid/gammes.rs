//! Les gammes d'assortiment : code, nom et couleurs — source unique
//! (port de `src/lib/gammes.ts`, utilisé par la validation `/api/v1` et le
//! document OpenAPI).

pub struct Gamme {
    pub code: &'static str,
    /// Nom court : « Cœur », « Sortie »…
    pub nom: &'static str,
    /// Phrase d'explication pour les infobulles.
    pub description: &'static str,
    /// Classes de pastille (fond, bordure, texte) lisibles en clair comme en sombre.
    pub classes: &'static str,
}

pub const GAMMES: [Gamme; 5] = [
    Gamme {
        code: "A",
        nom: "Cœur",
        description: "Produit permanent, au cœur de l'assortiment.",
        classes: "border-emerald-500/40 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300",
    },
    Gamme {
        code: "B",
        nom: "Complémentaire",
        description: "Produit qui complète l'offre du rayon.",
        classes: "border-blue-500/40 bg-blue-500/10 text-blue-800 dark:text-blue-300",
    },
    Gamme {
        code: "C",
        nom: "Saisonnier",
        description: "Produit présent selon la saison.",
        classes: "border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-300",
    },
    Gamme {
        code: "Y",
        nom: "En veille",
        description: "Produit mis en attente : il n'est plus commandé pour l'instant.",
        classes: "border-violet-500/40 bg-violet-500/10 text-violet-800 dark:text-violet-300",
    },
    Gamme {
        code: "Z",
        nom: "Sortie",
        description: "Produit à retirer de l'assortiment.",
        classes: "border-rose-500/40 bg-rose-500/10 text-rose-800 dark:text-rose-300",
    },
];

/// Pastille d'un produit sans gamme.
pub const CLASSES_SANS_GAMME: &str = "border-slate-400/40 bg-slate-500/10 text-slate-700 dark:text-slate-300";

/// Codes de gamme, dans l'ordre de [`GAMMES`].
pub fn codes_gamme() -> Vec<&'static str> {
    GAMMES.iter().map(|g| g.code).collect()
}

pub fn trouver_gamme(code: Option<&str>) -> Option<&'static Gamme> {
    let code = code.filter(|c| !c.is_empty())?;
    let c = super::js::js_trim(code);
    GAMMES.iter().find(|g| g.code == c)
}

#[cfg(test)]
mod tests {
    #[test]
    fn coherent_avec_le_socle() {
        assert_eq!(super::codes_gamme(), crate::domain::CODES_GAMME.to_vec());
        assert_eq!(super::trouver_gamme(Some(" Z ")).unwrap().nom, "Sortie");
        assert!(super::trouver_gamme(None).is_none());
    }
}
