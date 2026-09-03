import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { Pill } from "@/components/brand/Pill";
import { SceneLost } from "@/components/brand/scenes";
import { Shell } from "@/components/brand/Shell";
import { brandViewport } from "@/components/brand/viewport";
import { createDraft } from "@/lib/drafts";
import { clientIp, consume } from "@/lib/rate-limit";

/**
 * Starts a new site and hands the visitor their edit link.
 *
 * No form, no account — landing here *is* starting. The edit token in the
 * destination URL is the only thing that will ever grant access to this
 * draft, which is why the page must never be cached or prerendered.
 *
 * Because arriving here writes a row, this is the cheapest thing in the
 * product to abuse: a GET with no body, reachable by any crawler or link
 * preview bot. Hence the per-IP limit, and the noindex below to keep
 * well-behaved crawlers from tripping it in the first place.
 */
export const dynamic = "force-dynamic";

export const viewport = brandViewport;

export const metadata: Metadata = {
  title: "Criar meu presente",
  robots: { index: false, follow: false },
};

export default async function CriarPage() {
  const limit = consume("draft", clientIp(await headers()));

  if (!limit.ok) {
    return (
      <Shell>
        <main className="grid min-h-[70dvh] place-items-center px-5 py-16 text-center sm:px-8">
          <div>
            <SceneLost className="mx-auto w-[240px] sm:w-[320px]" />
            <h1 className="mt-6 text-display sm:text-display-lg">
              Calma, um de cada vez.
            </h1>
            <p className="mx-auto mt-3 max-w-sm text-body leading-relaxed text-brand-slate">
              Começamos vários presentes a partir daqui nos últimos minutos.
              Se um deles é seu, procure o link de edição — ele continua
              valendo. Senão, tente de novo em alguns minutos.
            </p>
            <Pill href="/" tone="ink" className="mt-8">
              Voltar pro início
            </Pill>
          </div>
        </main>
      </Shell>
    );
  }

  const { site } = createDraft();
  redirect(`/editar/${site.editToken}`);
}
