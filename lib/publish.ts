import "server-only";

import { eq } from "drizzle-orm";

import { parseSiteConfig } from "@/lib/config/schema";
import { db, sites, type Site } from "@/lib/db";
import { PLANS, type PlanId } from "@/lib/plans";
import { slugSuffix, slugifyNames } from "@/lib/tokens";

/**
 * Turning a paid site into a live one.
 *
 * Deliberately separate from marking the order paid: this half mints a
 * slug and sends an email, and either can fail. Keeping them apart means a
 * failure here is retryable without touching anyone's money.
 */

/**
 * Picks a free slug derived from the couple's names.
 *
 * The random suffix is always appended, never only on collision. Handing
 * the first couple of each name pair the bare "ana-e-joao" made that link
 * guessable from the names alone, and a list of common Brazilian first
 * names is a few thousand entries — every "first" site was findable
 * without brute force at all.
 *
 * With 48 bits of suffix a collision is a lottery win, but the loop stays:
 * it is cheap, and a unique index that can reject a publish deserves a
 * retry rather than a crashed webhook. Bounded, because an unbounded loop
 * against that index is how a webhook hangs forever.
 */
function allocateSlug(author: string, recipient: string): string {
  const base = slugifyNames(author, recipient);

  for (let attempt = 0; attempt < 12; attempt++) {
    const candidate = `${base}-${slugSuffix()}`;
    const taken = db
      .select({ slug: sites.slug })
      .from(sites)
      .where(eq(sites.slug, candidate))
      .get();

    if (!taken) return candidate;
  }

  // Twelve collisions on a 2^48 space means the random source is broken,
  // not that we were unlucky. Fall back to something that cannot collide
  // rather than failing the publish.
  return `${base}-${Date.now().toString(36)}`;
}

export interface PublishedSite {
  slug: string;
  publicUrl: string;
  editUrl: string;
  /** When hosting ends. Returned rather than re-read — the caller holds a
   *  Site row loaded before this ran, where the field is still null. */
  expiresAt: Date;
}

/**
 * Publishes a paid site. Idempotent: publishing twice returns the same slug.
 *
 * Idempotency matters because Mercado Pago retries webhooks, and a second
 * delivery must not mint a second slug and orphan the link the buyer was
 * already given.
 */
export function publishSite(
  site: Site,
  plan: PlanId,
  appUrl: string,
): PublishedSite {
  const links = (slug: string, expiresAt: number): PublishedSite => ({
    slug,
    publicUrl: `${appUrl}/p/${slug}`,
    editUrl: `${appUrl}/editar/${site.editToken}`,
    expiresAt: new Date(expiresAt * 1000),
  });

  if (site.status === "PUBLISHED" && site.slug) {
    return links(site.slug, site.expiresAt ?? 0);
  }

  const config = parseSiteConfig(site.config);
  const slug = site.slug ?? allocateSlug(
    config.couple.authorName,
    config.couple.recipientName,
  );

  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + PLANS[plan].hostingDays * 86_400;

  db.update(sites)
    .set({
      slug,
      plan,
      status: "PUBLISHED",
      publishedAt: now,
      expiresAt,
      updatedAt: now,
    })
    .where(eq(sites.id, site.id))
    .run();

  return links(slug, expiresAt);
}
