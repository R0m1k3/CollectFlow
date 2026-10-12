//! Référentiels partagés : magasins et gammes (miroir de `src/lib/magasins.ts`
//! et `src/lib/gammes.ts` côté interface).

pub struct Magasin {
    /// Code FF du site (clé de toutes les requêtes).
    pub code: &'static str,
    /// Nom complet.
    pub nom: &'static str,
    /// Nom court.
    pub court: &'static str,
}

pub const MAGASINS: [Magasin; 2] = [
    Magasin { code: "292", nom: "Frouard (Nancy)", court: "Frouard" },
    Magasin { code: "579", nom: "Houdemont", court: "Houdemont" },
];

/// Code utilisé par la Grille et l'API pour « tous nos magasins ».
pub const CODE_TOUS_MAGASINS: &str = "TOTAL";
pub const LIBELLE_TOUS_MAGASINS: &str = "Nos 2 magasins";

/// Anciens codes encore présents dans certaines réponses de l'API FF.
fn alias(code: &str) -> &str {
    match code {
        "F01" => "292",
        "F02" => "579",
        c => c,
    }
}

pub fn trouver_magasin(code: &str) -> Option<&'static Magasin> {
    let c = alias(code.trim());
    MAGASINS.iter().find(|m| m.code == c)
}

/// Nom lisible d'un magasin. `TOTAL` (ou vide) → « Nos 2 magasins ».
pub fn nom_magasin(code: Option<&str>, court: bool) -> String {
    match code {
        None | Some("") | Some(CODE_TOUS_MAGASINS) => LIBELLE_TOUS_MAGASINS.to_string(),
        Some(c) => match trouver_magasin(c) {
            Some(m) => (if court { m.court } else { m.nom }).to_string(),
            None => c.to_string(),
        },
    }
}

/// Codes de gamme valides.
pub const CODES_GAMME: [&str; 5] = ["A", "B", "C", "Y", "Z"];

pub fn est_gamme_valide(code: &str) -> bool {
    CODES_GAMME.contains(&code)
}
