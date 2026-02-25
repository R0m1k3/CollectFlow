import { pgTable, serial, varchar, numeric, smallint, timestamp, uniqueIndex, index, text, jsonb, integer } from "drizzle-orm/pg-core";

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

/** AI Context rules per supplier (Epic: AI Context) */
export const aiSupplierContext = pgTable("ai_supplier_context", {
  /** Supplier code serving as the primary key */
  codeFournisseur: varchar("code_fournisseur", { length: 20 }).primaryKey(),
  /** The business rules text provided by the user */
  context: text("context").notNull(),
  /** When it was last updated */
  updatedAt: timestamp("updated_at").defaultNow(),
});
