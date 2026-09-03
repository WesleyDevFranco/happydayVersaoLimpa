import "server-only";

import { sqlite } from "./db";

/**
 * Per-IP request limits, backed by the SQLite database the app already has.
 *
 * Deliberately not Redis: this runs on one VPS, and a second service to
 * operate (and back up, and restart in the right order) is a real cost for
 * a counter that fits in a table. If the app ever runs on more than one
 * host, this is the piece to replace — the interface below is the seam.
 *
 * The window is fixed rather than sliding, which makes the entire check a
 * single atomic UPSERT: no read-then-write race between concurrent
 * requests. Worst case a caller gets 2x the limit straddling a boundary,
 * which does not matter at these sizes.
 */

export interface Policy {
  /** Requests allowed per window. */
  limit: number;
  windowSeconds: number;
  /** Shown to the caller when the limit is hit. */
  message: string;
}

/**
 * Limits are sized so a real person never meets them.
 *
 * `draft`: someone building a gift creates one draft, maybe three if they
 * start over. Ten an hour leaves room for a shared office IP and for the
 * carrier-grade NAT most Brazilian mobile traffic sits behind.
 *
 * `upload`: the most generous plan caps a site at 60 photos, so a full
 * premium build fits inside one window with room to redo a few.
 */
export const POLICIES = {
  draft: {
    limit: 10,
    windowSeconds: 3600,
    message: "muitos rascunhos criados agora há pouco — tente de novo em alguns minutos",
  },
  upload: {
    limit: 80,
    windowSeconds: 3600,
    message: "muitos envios seguidos — espere alguns minutos e continue",
  },
  /**
   * Counts only *failed* /p/ lookups, so opening a real link never spends
   * any of it. Sixty an hour is far past a person mistyping a URL or
   * clicking a couple of expired gifts, and far under what a scan needs.
   */
  lookup: {
    limit: 60,
    windowSeconds: 3600,
    message: "muitos links inválidos a partir daqui — tente de novo mais tarde",
  },
} as const satisfies Record<string, Policy>;

export type PolicyName = keyof typeof POLICIES;

export interface RateLimitResult {
  ok: boolean;
  limit: number;
  /** Requests left in this window; 0 once blocked. */
  remaining: number;
  /** Seconds until the window resets. Always >= 1 so Retry-After is valid. */
  retryAfter: number;
  message: string;
}

/**
 * One statement, so two requests arriving together cannot both read the
 * same count and both decide they are under the limit.
 *
 * `excluded` is not used for the window reset because SQLite evaluates the
 * CASE against the existing row; @now is passed explicitly instead.
 */
const STATEMENT = `
  INSERT INTO rate_limits (key, count, window_start)
  VALUES (@key, 1, @now)
  ON CONFLICT(key) DO UPDATE SET
    count        = CASE WHEN @now - window_start >= @window THEN 1 ELSE count + 1 END,
    window_start = CASE WHEN @now - window_start >= @window THEN @now ELSE window_start END
  RETURNING count, window_start
`;

/** Prepared once; better-sqlite3 caches the plan on the statement object. */
let statement: ReturnType<typeof sqlite.prepare> | null = null;

function prepared() {
  return (statement ??= sqlite.prepare(STATEMENT));
}

/**
 * Records one request against `policy` for `identifier` and reports whether
 * it is allowed. Counts the blocked requests too — a caller hammering the
 * endpoint keeps their window open rather than sliding out of it.
 */
export function consume(
  policy: PolicyName,
  identifier: string,
  now = Math.floor(Date.now() / 1000),
): RateLimitResult {
  const { limit, windowSeconds, message } = POLICIES[policy];

  const row = prepared().get({
    key: `${policy}:${identifier}`,
    now,
    window: windowSeconds,
  }) as { count: number; window_start: number };

  const used = row.count;
  const resetsAt = row.window_start + windowSeconds;

  return {
    ok: used <= limit,
    limit,
    remaining: Math.max(0, limit - used),
    retryAfter: Math.max(1, resetsAt - now),
    message,
  };
}

/**
 * Whether `identifier` has already blown through `policy`, without spending
 * anything itself.
 *
 * Separate from consume() so a caller can refuse the work *before* doing
 * it, and so checking never pushes anyone further past their own limit.
 * An expired window reads as under budget: the row is stale, and the next
 * consume() will reset it.
 */
export function overBudget(
  policy: PolicyName,
  identifier: string,
  now = Math.floor(Date.now() / 1000),
): boolean {
  const { limit, windowSeconds } = POLICIES[policy];

  const row = sqlite
    .prepare("SELECT count, window_start FROM rate_limits WHERE key = ?")
    .get(`${policy}:${identifier}`) as
    | { count: number; window_start: number }
    | undefined;

  if (!row) return false;
  if (now - row.window_start >= windowSeconds) return false;

  return row.count > limit;
}

/**
 * The caller's IP, as seen through Caddy.
 *
 * Caddy appends the real peer address to any X-Forwarded-For the client
 * sent, so the **last** entry is the trustworthy one. Reading the first —
 * the usual mistake — would let anyone past the limit by sending their own
 * header. The Caddyfile also deletes the incoming value, so this is belt
 * and braces.
 */
export function clientIp(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    const hops = forwarded.split(",");
    const peer = hops[hops.length - 1]?.trim();
    if (peer) return peer;
  }

  return headers.get("x-real-ip")?.trim() || "unknown";
}

/** A 429 carrying Retry-After, which well-behaved clients honour. */
export function tooManyRequests(result: RateLimitResult): Response {
  return Response.json(
    { error: result.message },
    {
      status: 429,
      headers: {
        "Retry-After": String(result.retryAfter),
        "X-RateLimit-Limit": String(result.limit),
        "X-RateLimit-Remaining": "0",
      },
    },
  );
}
