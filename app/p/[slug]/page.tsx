import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";

import { SiteExperience } from "@/components/SiteExperience";
import { SiteConfigProvider } from "@/lib/config/context";
import { interpolate } from "@/lib/config/schema";
import { clientIp, consume, overBudget } from "@/lib/rate-limit";
import { lookupSlug } from "@/lib/sites";

/**
 * A published couple's site.
 *
 * Rendered on demand rather than prebuilt: slugs are created when someone
 * pays, so there is no build-time list of them, and a site edited after
 * publishing must reflect the change immediately.
 *
 * Guesses are rate limited per IP. Slugs carry 48 bits of suffix, so this
 * is not what makes a scan hopeless — it is what stops one from costing us
 * a database round trip per guess, and what puts the attempt in the logs.
 *
 * Only a slug that exists nowhere counts. Opening a gift whose hosting ran
 * out is a real link arriving late, not a guess, and charging for it would
 * punish exactly the innocent case: an old link resent in a family group,
 * where everyone behind one carrier NAT clicks it at once.
 *
 * The tradeoff is deliberate and worth stating: an address that has burned
 * its budget gets a 404 for valid links too, because the only way to skip
 * the lookup is to skip it before knowing the answer. The window is short
 * for that reason — against 2^48 a scanner is equally dead at five tries
 * per ten minutes or five per day, so the longer window would buy nothing
 * and cost an innocent an hour.
 */
export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;

  // Peeked, never spent: the page component below does the counting, so a
  // single request is one attempt rather than two.
  const blocked = overBudget("lookup", clientIp(await headers()));
  const found = blocked ? null : lookupSlug(slug);

  if (found?.state !== "published") return { title: "Site não encontrado" };

  const { config } = found.loaded;
  const title = interpolate(config.meta.title, config.couple);
  const description = interpolate(config.meta.description, config.couple);

  return {
    title,
    description,
    // The OG image itself comes from opengraph-image.tsx, which Next wires
    // up automatically — pointing at the couple's own photo here would put
    // it in the WhatsApp preview and spoil the surprise in the chat list.
    openGraph: {
      title,
      description,
      type: "website",
    },
    // Drafts and gifts alike have no business in search results.
    robots: { index: false, follow: false },
  };
}

export default async function PublishedSitePage({ params }: Props) {
  const { slug } = await params;

  const ip = clientIp(await headers());
  const blocked = overBudget("lookup", ip);
  const found = blocked ? null : lookupSlug(slug);

  if (found?.state !== "published") {
    // Charged only for a slug that exists nowhere. Answered with the same
    // 404 in every case: a distinct status would tell a scanner it had
    // found the edge of something.
    if (found?.state === "unknown") consume("lookup", ip);
    notFound();
  }

  return (
    <SiteConfigProvider config={found.loaded.config}>
      <SiteExperience />
    </SiteConfigProvider>
  );
}
