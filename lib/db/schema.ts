import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * A site goes DRAFT → PAID → PUBLISHED, and eventually EXPIRED.
 *
 * PAID and PUBLISHED are separate on purpose: the webhook marks PAID the
 * instant Mercado Pago confirms, but publishing also has to mint a slug
 * and send the e-mail. Keeping them apart means a failure in that second
 * half is retryable without re-charging anyone.
 */
export const SITE_STATUS = ["DRAFT", "PAID", "PUBLISHED", "EXPIRED"] as const;
export type SiteStatus = (typeof SITE_STATUS)[number];

export const ORDER_STATUS = [
  "PENDING",
  "APPROVED",
  "REJECTED",
  "REFUNDED",
  "CANCELLED",
] as const;
export type OrderStatus = (typeof ORDER_STATUS)[number];

const now = sql`(unixepoch())`;

export const sites = sqliteTable(
  "sites",
  {
    id: text("id").primaryKey(),

    /** Public URL segment: /p/[slug]. Null until published — drafts are
     *  reachable only through editToken, so they can't be guessed. */
    slug: text("slug").unique(),

    /** The only credential in the product. Whoever holds it can edit the
     *  site; it is never shown in a public URL. */
    editToken: text("edit_token").notNull().unique(),

    status: text("status", { enum: SITE_STATUS }).notNull().default("DRAFT"),

    /** Collected at checkout, not at draft creation — asking for an e-mail
     *  before someone has seen their site built costs conversions. */
    ownerEmail: text("owner_email"),

    /** The whole SiteConfig, serialized. Validated with Zod on write, so
     *  the content schema can evolve without a migration. */
    config: text("config", { mode: "json" }).notNull(),

    /** Plan id from lib/plans.ts. Null while still a draft. */
    plan: text("plan"),

    createdAt: integer("created_at").notNull().default(now),
    updatedAt: integer("updated_at").notNull().default(now),
    publishedAt: integer("published_at"),
    /** Published sites are hosted for a year. */
    expiresAt: integer("expires_at"),
  },
  (t) => [
    index("sites_status_idx").on(t.status),
    // Drives the sweep that deletes abandoned drafts and their uploads.
    index("sites_updated_idx").on(t.updatedAt),
  ],
);

export const photos = sqliteTable(
  "photos",
  {
    id: text("id").primaryKey(),
    siteId: text("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),

    /** Which gallery this belongs to: "dates", "cover", "fav", etc.
     *  Matches the slot names in SiteConfig. */
    slot: text("slot").notNull(),
    /** Position within its slot. */
    order: integer("order").notNull().default(0),

    /** Paths relative to UPLOAD_DIR — never absolute, so moving the volume
     *  doesn't invalidate every row. */
    path: text("path").notNull(),
    thumbPath: text("thumb_path").notNull(),

    width: integer("width").notNull(),
    height: integer("height").notNull(),
    bytes: integer("bytes").notNull(),

    /** Precomputed at upload so the player's gradient doesn't need the
     *  client-side canvas quantizer for uploaded photos. */
    dominantColor: text("dominant_color"),

    createdAt: integer("created_at").notNull().default(now),
  },
  (t) => [index("photos_site_slot_idx").on(t.siteId, t.slot, t.order)],
);

export const orders = sqliteTable(
  "orders",
  {
    id: text("id").primaryKey(),
    siteId: text("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),

    plan: text("plan").notNull(),
    /** Cents, to keep floating point away from money. */
    amountCents: integer("amount_cents").notNull(),
    status: text("status", { enum: ORDER_STATUS }).notNull().default("PENDING"),

    mpPreferenceId: text("mp_preference_id"),
    /** Unique so a webhook delivered twice can't create a second order —
     *  Mercado Pago retries, and it does deliver duplicates. */
    mpPaymentId: text("mp_payment_id").unique(),
    /** "pix" | "credit_card" | ... — kept for revenue reporting. */
    mpPaymentMethod: text("mp_payment_method"),

    createdAt: integer("created_at").notNull().default(now),
    paidAt: integer("paid_at"),
  },
  (t) => [index("orders_site_idx").on(t.siteId)],
);

export type Site = typeof sites.$inferSelect;
export type NewSite = typeof sites.$inferInsert;
export type Photo = typeof photos.$inferSelect;
export type NewPhoto = typeof photos.$inferInsert;
export type Order = typeof orders.$inferSelect;
export type NewOrder = typeof orders.$inferInsert;

/**
 * Fixed-window request counters, keyed by "policy:identifier".
 *
 * Kept in SQLite rather than memory so the limit survives a restart — an
 * in-process Map resets on every deploy, which is exactly when a scripted
 * caller would get a fresh allowance. It also means no new dependency:
 * the counter lives in the same file the sweep already backs up.
 *
 * A fixed window (rather than sliding) lets the whole check be one atomic
 * UPSERT. The tradeoff is a burst of up to 2x the limit across a window
 * boundary, which is irrelevant for the sizes here.
 *
 * Rows are pruned by the nightly sweep; nothing reads a stale one, since
 * an expired window is reset on contact.
 */
export const rateLimits = sqliteTable(
  "rate_limits",
  {
    /** "draft:203.0.113.7" — policy name and caller, colon-separated. */
    key: text("key").primaryKey(),
    count: integer("count").notNull().default(0),
    /** Unix seconds when the current window opened. */
    windowStart: integer("window_start").notNull(),
  },
  (t) => [index("rate_limits_window_idx").on(t.windowStart)],
);

export type RateLimitRow = typeof rateLimits.$inferSelect;
