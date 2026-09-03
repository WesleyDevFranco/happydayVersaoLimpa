import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";

import { SiteExperience } from "@/components/SiteExperience";
import { SiteConfigProvider } from "@/lib/config/context";
import { interpolate } from "@/lib/config/schema";
import { clientIp, consume, overBudget } from "@/lib/rate-limit";
import { findPublishedSite } from "@/lib/sites";

/**
 * A published couple's site.
 *
 * Rendered on demand rather than prebuilt: slugs are created when someone
 * pays, so there is no build-time list of them, and a site edited after
 * publishing must reflect the change immediately.
 *
 * Misses are rate limited per IP. Slugs carry 48 bits of suffix, so this
 * is not what makes a scan hopeless — it is what stops one from costing us
 * a database round trip per guess, and what puts the attempt in the logs.
 *
 * The tradeoff is deliberate and worth stating: an address that has burned
 * its budget gets a 404 for valid links too, because the only way to skip
 * the lookup is to skip it before knowing the answer. Sixty misses an hour
 * is far past anything a person does with real links.
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
  const loaded = blocked ? null : findPublishedSite(slug);

  if (!loaded) return { title: "Site não encontrado" };

  const { config } = loaded;
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
  const loaded = blocked ? null : findPublishedSite(slug);

  if (!loaded) {
    // Only misses cost anything, so opening a real gift — the overwhelming
    // majority of traffic here — never spends a request. Answered with the
    // same 404 either way: a distinct status would tell a scanner it had
    // found the edge of something.
    if (!blocked) consume("lookup", ip);
    notFound();
  }

  return (
    <SiteConfigProvider config={loaded.config}>
      <SiteExperience />
    </SiteConfigProvider>
  );
}
