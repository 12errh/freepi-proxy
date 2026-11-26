// Shared runtime state: token lifecycle, live stats, credit-diff attribution.

import { CATALOG_REFRESH_MS, STATS_POLL_MS, CREDITS_PER_USD, SESSION_ID_PATH } from "./config.ts";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { checkToken, loadJwt, saveJwt } from "./token.ts";
import type { TokenState } from "./token.ts";
import { Upstream } from "./upstream.ts";
import type { MeStats } from "./upstream.ts";
import type { Tracker } from "./track.ts";

export interface AppState {
  token: TokenState;
  live: MeStats | null;
  liveAt: number;
  sessionId: string;
  startedAt: number;
  lastCreditDiffAt: number;
  lastCreditDiff: number;
  /** server-owned notice (e.g. ads paused) from /me */
  notice: string | null;
  /** last settled spent_usd_today seen from /me/stats */
  lastSettledUsd: number | null;
  /** start of the window the next settlement will cover */
  lastSettleAt: number;
}

export interface Ctx {
  upstream: Upstream;
  tracker: Tracker;
  state: AppState;
  /** base64url Gravity context for ad attribution; undefined if pixel unavailable. */
  getGravityContext?: () => string | undefined;
}

/** Stable per-install session id: reuse across restarts so the server does not
 * count every proxy launch as a new concurrent session (account limit is 4). */
async function loadSessionId(): Promise<string> {
  try {
    const id = (await readFile(SESSION_ID_PATH, "utf8")).trim();
    if (id) return id;
  } catch {}
  const id = crypto.randomUUID();
  try {
    await mkdir(dirname(SESSION_ID_PATH), { recursive: true });
    await writeFile(SESSION_ID_PATH, id);
  } catch { /* best effort */ }
  return id;
}

// ---------- upstream sessions ----------
//
// free-pi meters a *session* (one `free-pi-cli` run, identified by
// x-session-id), not only a single request. If a session exhausts its
// context/token budget the backend may answer later completions with
// `context_too_long` ("This conversation is too long. Run /compact or start a
// new session with /new.") — a smaller prompt (a freshly compacted
// conversation) does not help, because the session itself is spent, not the
// request. The upstream bug that triggered this well below the 200k window is
// fixed; the rotation below stays as a defensive fallback.
//
// The CLI never notices: it starts a new session on every launch. This proxy
// persists one session id forever to hold a single concurrent-session slot, so
// a long agent run could otherwise wedge itself. We retire a spent session and
// replay the request on a fresh one instead, which is what makes compaction
// work again.

/** Session-level rejections. Deliberately excludes `concurrent_session`, which
 * is about the account's slot count — rotating more sessions would only make
 * that worse. The last branch is free-pi's real spent-context rejection:
 * `{"code":"context_too_long","message":"This conversation is too long…"}`.
 * A provider's per-request "maximum context length is N tokens" is not matched
 * on purpose: a fresh session would not make an oversized request fit. */
const SESSION_EXHAUSTED =
  /session[\s_-]*(?:is[\s_-]*)?too[\s_-]*long|session_too_long|session[\s_-]*(?:token[\s_-]*)?(?:limit|budget|quota|cap)\b|session[\s_-]*(?:exhausted|spent)|(?:context|conversation)[\s_-]*(?:is[\s_-]*)?too[\s_-]*long/i;

export function isSessionTooLong(status: number, body: string): boolean {
  if (status < 400) return false;
  if (/concurrent[\s_-]*session/i.test(body)) return false;
  return SESSION_EXHAUSTED.test(body);
}

/** Retire the current upstream session and persist a fresh one. The old
 * session's lease is left to expire; it is already unusable. */
export async function rotateSession(state: AppState, reason: string): Promise<string> {
  const previous = state.sessionId;
  const id = crypto.randomUUID();
  state.sessionId = id;
  try {
    await mkdir(dirname(SESSION_ID_PATH), { recursive: true });
    await writeFile(SESSION_ID_PATH, id);
  } catch { /* the in-memory rotation is enough for this run */ }
  console.warn(`[freepi-proxy] upstream session rotated (${reason}); retired ${previous}`);
  return id;
}

export interface SessionCompletion {
  /** upstream response for the attempt that was returned to the client */
  upstream: Response;
  /** session id that response came from */
  sessionId: string;
  /** true when the first attempt was rejected and the request was replayed */
  retried: boolean;
}

/** Rebuild a failed response whose body we had to consume to classify it. */
function replayed(res: Response, body: string): Response {
  const headers = new Headers();
  const ctype = res.headers.get("content-type");
  if (ctype) headers.set("content-type", ctype);
  return new Response(body, { status: res.status, statusText: res.statusText, headers });
}

/** Send one completion as a CLI-style turn (ad cycle + turn id on the current
 * session). If upstream reports the session itself is spent, retire it and
 * replay the same body once on a fresh session. */
export async function completeWithSessionRetry(
  ctx: Ctx,
  jwt: string,
  body: string,
  signal: AbortSignal,
): Promise<SessionCompletion> {
  const send = async (sessionId: string): Promise<Response> => {
    const turnId = crypto.randomUUID();
    // The ad cycle must run for this turn id on this session, or upstream
    // pauses the completion with ads_required.
    ctx.upstream.runAdCycle(jwt, sessionId, turnId, ctx.getGravityContext?.());
    return ctx.upstream.completions(jwt, body, signal, {
      sessionId,
      turnId,
      gravityContext: ctx.getGravityContext?.(),
    });
  };

  const first = await send(ctx.state.sessionId);
  if (first.ok) return { upstream: first, sessionId: ctx.state.sessionId, retried: false };

  const text = await first.text().catch(() => "");
  if (!isSessionTooLong(first.status, text)) {
    return { upstream: replayed(first, text), sessionId: ctx.state.sessionId, retried: false };
  }

  const sessionId = await rotateSession(ctx.state, `upstream ${first.status}: ${text.slice(0, 120)}`);
  const second = await send(sessionId);
  return { upstream: second, sessionId, retried: true };
}

export async function bootState(): Promise<AppState> {
  const token = await loadJwt();
  const st: TokenState = { token, status: token ? "unknown" : "missing", checkedAt: 0 };
  return {
    token: st,
    live: null,
    liveAt: 0,
    sessionId: await loadSessionId(),
    startedAt: Date.now(),
    lastCreditDiffAt: 0,
    lastCreditDiff: 0,
    notice: null,
    lastSettledUsd: null,
    lastSettleAt: Date.now(),
  };
}

/** Validate the stored token and record status/handle. */
export async function refreshTokenState(state: AppState): Promise<void> {
  if (!state.token.token) {
    state.token = { token: null, status: "missing", checkedAt: Date.now() };
    return;
  }
  const r = await checkToken(state.token.token);
  if (r.ok) {
    state.token = { token: state.token.token, status: "ok", handle: r.handle, checkedAt: Date.now() };
  } else {
    state.token = { token: state.token.token, status: r.code === "rejected" ? "rejected" : "unknown", checkedAt: Date.now() };
  }
}

/** Pull authoritative /me/stats and return remaining_credits_today. */
export async function pollStats(ctx: Ctx): Promise<MeStats | null> {
  const jwt = ctx.state.token.token;
  if (!jwt) return null;
  try {
    const s = await ctx.upstream.stats(jwt);
    if (s) {
      ctx.state.live = s;
      ctx.state.liveAt = Date.now();
    } else {
      console.error("[freepi-proxy] pollStats: upstream returned no stats");
    }
    return s;
  } catch (e) {
    console.error("[freepi-proxy] pollStats failed:", e instanceof Error ? e.message : e);
    return null;
  }
}

/** After usage: check whether the server's settled spend meter has moved.
 * The server meters request_count and tokens live, but settles USD/credits on
 * a delay. When a settlement lands we return the newly settled credits and
 * the window they apply to, so recorded estimates can be reconciled. */
export async function settleSpend(ctx: Ctx, minGapMs: number): Promise<{ credits: number; sinceTs: number } | null> {
  const now = Date.now();
  if (now - ctx.state.lastCreditDiffAt < minGapMs) return null;
  const s = await pollStats(ctx);
  ctx.state.lastCreditDiffAt = now;
  if (!s || typeof s.spent_usd_today !== "number") return null;
  const before = ctx.state.lastSettledUsd;
  ctx.state.lastSettledUsd = s.spent_usd_today;
  if (typeof before !== "number" || s.spent_usd_today <= before) return null;
  const credits = (s.spent_usd_today - before) * CREDITS_PER_USD;
  const sinceTs = ctx.state.lastSettleAt;
  ctx.state.lastSettleAt = now;
  ctx.state.lastCreditDiff = credits;
  return { credits, sinceTs };
}

/** Pull /me for the server-owned notice line (ads paused etc.). */
export async function pollNotice(ctx: Ctx): Promise<void> {
  const jwt = ctx.state.token.token;
  if (!jwt) { ctx.state.notice = null; return; }
  const me = await ctx.upstream.me(jwt);
  ctx.state.notice = me?.notice ?? null;
}

export function startBackgroundLoops(ctx: Ctx, loginSaved: () => void): void {
  // catalog + client version
  void ctx.upstream.refreshCatalog();
  setInterval(() => void ctx.upstream.refreshCatalog(), CATALOG_REFRESH_MS);
  // token check + stats
  void refreshTokenState(ctx.state).then(loginSaved);
  setInterval(() => void refreshTokenState(ctx.state), 5 * 60_000);
  setInterval(() => void pollStats(ctx).catch(() => {}), STATS_POLL_MS);
  void pollStats(ctx).catch(() => {});
  setInterval(() => void pollNotice(ctx).catch(() => {}), STATS_POLL_MS);
  void pollNotice(ctx).catch(() => {});
}

/** Called by the login manager after a successful device flow. */
export function onLoginToken(ctx: Ctx): (token: string) => void {
  return (token: string) => {
    void saveJwt(token).then(() => {
      ctx.state.token = { token, status: "ok", checkedAt: Date.now() };
      void pollStats(ctx).catch(() => {});
    });
  };
}
