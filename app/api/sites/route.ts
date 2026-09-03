import { createDraft } from "@/lib/drafts";
import { clientIp, consume, tooManyRequests } from "@/lib/rate-limit";

/**
 * Starts a new draft. No body, no auth — anyone can begin building.
 *
 * The response carries the edit token exactly once. The client stores it
 * (localStorage plus the URL) and it is emailed at checkout; there is no
 * way to recover it from the server afterwards, which is the point.
 *
 * Rate limited per IP because "anyone can begin building" also describes a
 * loop: every call writes a row, and each row can then hold 60 photos.
 */
export const dynamic = "force-dynamic";

export function POST(request: Request) {
  const limit = consume("draft", clientIp(request.headers));
  if (!limit.ok) return tooManyRequests(limit);

  const { site, config } = createDraft();

  return Response.json(
    { id: site.id, editToken: site.editToken, config },
    { status: 201 },
  );
}
