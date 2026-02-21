-- ================================================================
-- TABLE : ventes_produits
-- Import Excel Ventes Fournisseurs
-- Structure : 1 ligne = 1 produit × 1 magasin × 1 période
--
-- Stratégie : UPSERT sur (codein, magasin, periode)
-- → Chaque import met à jour les données existantes
-- → L'historique des anciens mois est conservé automatiquement
-- → On peut ré-importer le même fichier plusieurs fois sans doublons
-- ================================================================

DROP TABLE IF EXISTS ventes_produits;

CREATE TABLE ventes_produits (
    id               SERIAL PRIMARY KEY,

    -- Identification produit
    codein           VARCHAR(20)  NOT NULL,  -- Code interne produit
    code_fournisseur VARCHAR(20),            -- Code fournisseur (ex: G009)
    nom_fournisseur  VARCHAR(255),           -- Nom fournisseur (ex: GLAMA INTERNATIONAL)
    libelle1         VARCHAR(500),           -- Libellé produit
    gtin             VARCHAR(30),            -- Code-barres GTIN/EAN
    reference        VARCHAR(100),           -- Référence fournisseur
    colisage         NUMERIC(10,5),          -- Colisage

    -- Gamme & Nomenclature
    code_gamme       VARCHAR(20),            -- CODE : gamme (A, Z, Aucune)
    code3            VARCHAR(20),            -- Code nomenclature (ex: 320211)
    libelle3         VARCHAR(500),           -- Libellé nomenclature

    -- Dimension magasin & période
    magasin          VARCHAR(20)  NOT NULL,  -- HOUDEMONT, NANCY, TOTAL
    code_magasin     VARCHAR(10),            -- 579, 292, ALL
    annee            SMALLINT,               -- 2025, 2026
    mois             SMALLINT,               -- 1..12
    periode          VARCHAR(10)  NOT NULL,  -- 202508, 202509, ... ou TOTAL

    -- Métriques (valeurs négatives = ventes clients, sens comptable)
    quantite         NUMERIC(12,2),
    montant_mvt      NUMERIC(14,4),
    marge_mvt        NUMERIC(14,4),

    -- Métadonnées d'import
    imported_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    -- Contrainte UNIQUE pour l'UPSERT
    CONSTRAINT uq_ventes_produit_magasin_periode
        UNIQUE (codein, magasin, periode)
);

-- ================================================================
-- INDEX pour les performances Metabase
-- ================================================================
CREATE INDEX idx_ventes_codein         ON ventes_produits(codein);
CREATE INDEX idx_ventes_fournisseur    ON ventes_produits(code_fournisseur);
CREATE INDEX idx_ventes_gamme          ON ventes_produits(code_gamme);
CREATE INDEX idx_ventes_code3          ON ventes_produits(code3);
CREATE INDEX idx_ventes_magasin        ON ventes_produits(magasin);
CREATE INDEX idx_ventes_periode        ON ventes_produits(periode);
CREATE INDEX idx_ventes_annee_mois     ON ventes_produits(annee, mois);
CREATE INDEX idx_ventes_codein_magasin ON ventes_produits(codein, magasin, periode);
CREATE INDEX idx_ventes_updated_at     ON ventes_produits(updated_at);

-- Trigger pour mettre à jour updated_at automatiquement à chaque UPSERT
CREATE OR REPLACE FUNCTION fn_update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_ventes_updated_at
    BEFORE UPDATE ON ventes_produits
    FOR EACH ROW
    EXECUTE FUNCTION fn_update_updated_at();

-- ================================================================
-- VUES utiles pour Metabase
-- ================================================================

-- Vue synthèse par fournisseur & magasin
CREATE OR REPLACE VIEW v_ca_fournisseur AS
SELECT
    code_fournisseur,
    nom_fournisseur,
    magasin,
    annee,
    mois,
    periode,
    SUM(ABS(quantite))    AS quantite_totale,
    SUM(ABS(montant_mvt)) AS ca_total,
    SUM(ABS(marge_mvt))   AS marge_totale,
    CASE WHEN SUM(ABS(montant_mvt)) > 0
         THEN ROUND(SUM(ABS(marge_mvt)) / SUM(ABS(montant_mvt)) * 100, 2)
         ELSE 0 END       AS taux_marge
FROM ventes_produits
WHERE magasin != 'TOTAL'
  AND periode != 'TOTAL'
GROUP BY code_fournisseur, nom_fournisseur, magasin, annee, mois, periode;

-- Vue synthèse par nomenclature & magasin
CREATE OR REPLACE VIEW v_ca_nomenclature AS
SELECT
    code3,
    libelle3,
    magasin,
    annee,
    mois,
    periode,
    SUM(ABS(quantite))    AS quantite_totale,
    SUM(ABS(montant_mvt)) AS ca_total,
    SUM(ABS(marge_mvt))   AS marge_totale,
    CASE WHEN SUM(ABS(montant_mvt)) > 0
         THEN ROUND(SUM(ABS(marge_mvt)) / SUM(ABS(montant_mvt)) * 100, 2)
         ELSE 0 END       AS taux_marge
FROM ventes_produits
WHERE magasin != 'TOTAL'
  AND periode != 'TOTAL'
GROUP BY code3, libelle3, magasin, annee, mois, periode;

-- Vue synthèse par gamme & magasin
CREATE OR REPLACE VIEW v_ca_gamme AS
SELECT
    code_gamme,
    magasin,
    annee,
    mois,
    periode,
    SUM(ABS(quantite))    AS quantite_totale,
    SUM(ABS(montant_mvt)) AS ca_total,
    SUM(ABS(marge_mvt))   AS marge_totale
FROM ventes_produits
WHERE magasin != 'TOTAL'
  AND periode != 'TOTAL'
GROUP BY code_gamme, magasin, annee, mois, periode;
