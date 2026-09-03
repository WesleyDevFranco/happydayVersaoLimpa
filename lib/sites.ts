import "server-only";

import { eq } from "drizzle-orm";

import { db, sites, type Site } from "@/lib/db";
import { parseSiteConfig, type SiteConfig } from "@/lib/config/schema";

/** A site plus its config already parsed and validated. */
export interface LoadedSite {
  site: Site;
  config: SiteConfig;
}

/**
 * What a public slug turned out to be.
 *
 * "known" covers a slug that exists but is not servable — a site whose
 * hosting ran out, most often. It answers with the same 404 as "unknown",
 * but the caller can tell the two apart to decide whether the request
 * looked like a guess. Someone clicking a gift that expired last month is
 * not scanning, and should not be treated as though they were.
 */
export type SlugLookup =
  | { state: "published"; loaded: LoadedSite }
  | { state: "known" }
  | { state: "unknown" };

/**
 * Resolves a public slug.
 *
 * The distinction between "known" and "unknown" never reaches the
 * response — both render a 404, because the public URL must not reveal
 * that a slug exists but isn't paid for yet. It exists only so the rate
 * limiter can avoid charging someone for a link that was real.
 */
export function lookupSlug(slug: string): SlugLookup {
  const site = db.select().from(sites).where(eq(sites.slug, slug)).get();

  if (!site) return { state: "unknown" };
  if (site.status !== "PUBLISHED") return { state: "known" };

  // A config that fails validation means a bad migration or a hand-edited
  // row. Rendering half a site is worse than a 404, so let it throw.
  return { state: "published", loaded: { site, config: parseSiteConfig(site.config) } };
}

/**
 * Looks up a published site by its public slug.
 *
 * Returns null for drafts and expired sites as well as missing ones — the
 * public URL must not reveal that a slug exists but isn't payed for yet.
 */
export function findPublishedSite(slug: string): LoadedSite | null {
  const found = lookupSlug(slug);
  return found.state === "published" ? found.loaded : null;
}

/** Looks up any site (draft included) by its secret edit token. */
export function findSiteByEditToken(token: string): LoadedSite | null {
  const site = db
    .select()
    .from(sites)
    .where(eq(sites.editToken, token))
    .get();

  if (!site) return null;

  return { site, config: parseSiteConfig(site.config) };
}
