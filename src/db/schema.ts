import { pgTable, serial, varchar, numeric, smallint, timestamp, uniqueIndex, index, text, jsonb, integer, boolean } from "drizzle-orm/pg-core";

export const ventesProduits = pgTable("ventes_produits", {
  id: serial("id").primaryKey(),

  // Identification produit
  codein: varchar("codein", { length: 20 }).notNull(),
  codeFournisseur: varchar("code_fournisseur", { length: 20 }),
  nomFournisseur: varchar("nom_fournisseur", { length: 255 }),
  libelle1: varchar("libelle1", { length: 500 }),
  gtin: varchar("gtin", { length: 30 }),
  reference: varchar("reference", { length: 100 }),
  colisage: numeric("colisage", { precision: 10, scale: 5 }),

  // Gamme & Nomenclature
  codeGamme: varchar("code_gamme", { length: 20 }),
  codeGammeInit: varchar("code_gamme_init", { length: 20 }),
  code3: varchar("code3", { length: 20 }),
  libelle3: varchar("libelle3", { length: 500 }),

  // Dimension magasin & période
  magasin: varchar("magasin", { length: 20 }).notNull(),
  codeMagasin: varchar("code_magasin", { length: 10 }),
  annee: smallint("annee"),
  mois: smallint("mois"),
  periode: varchar("periode", { length: 10 }).notNull(),

  // Métriques
  quantite: numeric("quantite", { precision: 12, scale: 2 }),
  montantMvt: numeric("montant_mvt", { precision: 14, scale: 4 }),
  margeMvt: numeric("marge_mvt", { precision: 14, scale: 4 }),

  // Métadonnées
  importedAt: timestamp("imported_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => {
  return [
    uniqueIndex("uq_ventes_produit_magasin_periode").on(table.codein, table.magasin, table.periode),
    index("idx_ventes_codein").on(table.codein),
    index("idx_ventes_fournisseur").on(table.codeFournisseur),
    index("idx_ventes_gamme").on(table.codeGamme),
    index("idx_ventes_code3").on(table.code3),
    index("idx_ventes_magasin").on(table.magasin),
    index("idx_ventes_periode").on(table.periode),
    index("idx_ventes_annee_mois").on(table.annee, table.mois),
    index("idx_ventes_updated_at").on(table.updatedAt),
  ];
});

/** User management (Epic 6) */
export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  username: varchar("username", { length: 50 }).notNull().unique(),
  /** Hashed password */
  passwordHash: text("password_hash").notNull(),
  /** 'admin' or 'user' */
  role: varchar("role", { length: 20 }).default("user").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

/** Snapshot of a complete arbitrage session (Epic 5) */
export const sessionSnapshots = pgTable("session_snapshots", {
  id: serial("id").primaryKey(),
  /** Link to user who created the snapshot */
  userId: integer("user_id").references(() => users.id),
  codeFournisseur: varchar("code_fournisseur", { length: 20 }).notNull(),
  nomFournisseur: varchar("nom_fournisseur", { length: 255 }),
  magasin: varchar("magasin", { length: 20 }).notNull(),
  /** JSON map of codein → { before: GammeCode, after: GammeCode } */
  changes: jsonb("changes").notNull(),
  /** Summary stats at time of snapshot */
  summaryJson: jsonb("summary_json"),
  /** Label for the snapshot */
  label: text("label"),
  /** snapshot vs export */
  type: varchar("type", { length: 20 }).default("snapshot"),
  createdAt: timestamp("created_at").defaultNow(),
});

/**
 * Cadencier / alertes de commande par fournisseur ET par magasin.
 * Un fournisseur peut être cadencé indépendamment sur chaque site (292/579)
 * avec un intervalle propre (toutes les X semaines). L'échéance est calculée
 * à partir de la dernière commande réelle (FF Nancy) + intervalle.
 */
export const commandeCadences = pgTable("commande_cadences", {
  id: serial("id").primaryKey(),
  /** Code fournisseur (fouident.code) */
  codeFournisseur: varchar("code_fournisseur", { length: 20 }).notNull(),
  /** Nom fournisseur dénormalisé pour l'affichage */
  nomFournisseur: varchar("nom_fournisseur", { length: 255 }),
  /** Site / magasin : "292" | "579" */
  site: varchar("site", { length: 20 }).notNull(),
  /** Fréquence de commande, en semaines */
  intervalleSemaines: integer("intervalle_semaines").notNull(),
  /** Cadence active ou non */
  actif: boolean("actif").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => {
  return [
    uniqueIndex("uq_cadence_fou_site").on(table.codeFournisseur, table.site),
    index("idx_cadence_site").on(table.site),
  ];
});

/**
 * Cache des métriques réseau Qlik Sense (~270 magasins La Foir'Fouille).
 * Clé = code centrale (format 10000XXXXXX). Rafraîchi par /api/qlik/sync.
 */
export const qlikNetworkMetrics = pgTable("qlik_network_metrics", {
  /** Code centrale article (clé jointure Qlik ↔ FF) */
  codeCentrale: varchar("code_centrale", { length: 20 }).primaryKey(),
  /** CA réseau total du produit */
  caReseau: numeric("ca_reseau", { precision: 16, scale: 2 }),
  /** Quantité vendue réseau */
  qteReseau: numeric("qte_reseau", { precision: 14, scale: 2 }),
  /** Nombre de magasins travaillant le produit (sur ~270) */
  nbMagasinsReseau: integer("nb_magasins_reseau"),
  /** CA moyen par magasin (productivité normalisée présence) */
  caParMagasinReseau: numeric("ca_par_magasin_reseau", { precision: 16, scale: 2 }),
  /** Taux de marge réseau (ratio brut Qlik) */
  margePctReseau: numeric("marge_pct_reseau", { precision: 8, scale: 4 }),
  /** Période couverte (libre, ex "12m" ou "2025") */
  periode: varchar("periode", { length: 20 }),
  /** Quantité vendue réseau par mois : { "YYYY-MM": qté } (12 derniers mois). */
  qteByMonth: jsonb("qte_by_month"),
  /**
   * Détail mensuel complet : { "YYYY-MM": { qte, ca, nbMag, caMag, margePct } }.
   * Superset de `qteByMonth`, qui reste maintenu tel quel pour la colonne
   * « Tendance / Réseau » de la Grille.
   */
  metricsByMonth: jsonb("metrics_by_month"),
  /**
   * Libellé de l'article tel que Qlik le renvoie. Renseigné par la recherche
   * produit (qui interroge la dimension libellé) ; la sync fournisseur ne
   * l'écrase pas. Permet d'afficher une fiche pour un produit réseau que le
   * catalogue Nancy ne référence pas.
   */
  libelleReseau: varchar("libelle_reseau", { length: 255 }),
  /** Fournisseur de l'article côté Qlik, même origine que `libelleReseau`. */
  fournisseurReseau: varchar("fournisseur_reseau", { length: 255 }),
  /** Dernière synchro depuis Qlik */
  fetchedAt: timestamp("fetched_at").defaultNow(),
});

/**
 * Instantané persisté des lignes de grille (une ligne par fournisseur × article).
 *
 * Raison d'être : `getProductRows()` reconstruit la grille en direct et ne la garde
 * qu'en mémoire 10 minutes — perdu à chaque redémarrage. L'API `/api/v1` ne doit
 * jamais déclencher ce calcul, elle lit donc cette table, remplie en effet de bord
 * quand quelqu'un ouvre la Grille. Aucun calcul supplémentaire n'est introduit : on
 * arrête simplement de jeter le résultat.
 *
 * Seul `magasin = TOTAL` est persisté : `payload` embarque déjà les ventilations par
 * magasin (sales12mByStore, caByStore…).
 */
export const gridRows = pgTable("grid_rows", {
  codeFournisseur: varchar("code_fournisseur", { length: 20 }).notNull(),
  codein: varchar("codein", { length: 20 }).notNull(),

  // Colonnes scalaires : servent aux filtres, au tri et à la recherche en SQL.
  nomFournisseur: varchar("nom_fournisseur", { length: 255 }),
  libelle1: varchar("libelle1", { length: 500 }),
  gtin: varchar("gtin", { length: 30 }),
  reference: varchar("reference", { length: 100 }),
  codeCentrale: varchar("code_centrale", { length: 20 }),
  code1: varchar("code1", { length: 20 }),
  code2: varchar("code2", { length: 20 }),
  code3: varchar("code3", { length: 20 }),
  codeGamme: varchar("code_gamme", { length: 20 }),
  codeGammeInit: varchar("code_gamme_init", { length: 20 }),
  totalCa: numeric("total_ca", { precision: 16, scale: 2 }),
  totalQuantite: numeric("total_quantite", { precision: 14, scale: 2 }),
  totalMarge: numeric("total_marge", { precision: 16, scale: 2 }),
  tauxMarge: numeric("taux_marge", { precision: 8, scale: 4 }),
  stockActuel: numeric("stock_actuel", { precision: 14, scale: 2 }),
  caReseau: numeric("ca_reseau", { precision: 16, scale: 2 }),
  qteReseau: numeric("qte_reseau", { precision: 14, scale: 2 }),
  nbMagasinsReseau: integer("nb_magasins_reseau"),
  caParMagasinReseau: numeric("ca_par_magasin_reseau", { precision: 16, scale: 2 }),
  margePctReseau: numeric("marge_pct_reseau", { precision: 8, scale: 4 }),

  /** ProductRow complet (séries mensuelles, ventilations par magasin, dates…). */
  payload: jsonb("payload").notNull(),
  /** Date du calcul ayant produit cette ligne — expose la fraîcheur au consommateur. */
  computedAt: timestamp("computed_at").defaultNow().notNull(),
}, (table) => {
  return [
    uniqueIndex("uq_grid_rows_fou_codein").on(table.codeFournisseur, table.codein),
    index("idx_grid_rows_fournisseur").on(table.codeFournisseur),
    index("idx_grid_rows_codein").on(table.codein),
    index("idx_grid_rows_gamme").on(table.codeGamme),
    index("idx_grid_rows_code_centrale").on(table.codeCentrale),
    index("idx_grid_rows_total_ca").on(table.totalCa),
    index("idx_grid_rows_libelle").on(table.libelle1),
  ];
});

/**
 * Clés d'API pour les appelants non-navigateur (scripts, outils externes).
 *
 * Seul le hachage SHA-256 est stocké : la clé en clair n'est affichée qu'une fois,
 * à la création. Une clé révoquée conserve sa ligne (traçabilité) via `revokedAt`.
 */
export const apiKeys = pgTable("api_keys", {
  id: serial("id").primaryKey(),
  /** Nom lisible choisi à la création (ex "Export Excel comptabilité"). */
  name: varchar("name", { length: 100 }).notNull(),
  /** Préfixe en clair (ex "cf_a1b2c3") — sert à identifier la clé dans l'UI. */
  keyPrefix: varchar("key_prefix", { length: 20 }).notNull(),
  /** SHA-256 hexadécimal de la clé complète. */
  keyHash: text("key_hash").notNull().unique(),
  /** 'admin' ou 'user' — même sémantique que users.role. */
  role: varchar("role", { length: 20 }).default("user").notNull(),
  createdBy: varchar("created_by", { length: 50 }),
  createdAt: timestamp("created_at").defaultNow(),
  lastUsedAt: timestamp("last_used_at"),
  revokedAt: timestamp("revoked_at"),
});

/** AI Context rules per supplier (Epic: AI Context) */
export const aiSupplierContext = pgTable("ai_supplier_context", {
  /** Supplier code serving as the primary key */
  codeFournisseur: varchar("code_fournisseur", { length: 20 }).primaryKey(),
  /** The business rules text provided by the user */
  context: text("context").notNull(),
  /** When it was last updated */
  updatedAt: timestamp("updated_at").defaultNow(),
});
