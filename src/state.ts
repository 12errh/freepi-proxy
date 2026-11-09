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
