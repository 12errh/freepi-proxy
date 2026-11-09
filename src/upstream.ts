// free-pi upstream client: catalog, stats, tool endpoints, completions.

import { BASE_URL, FALLBACK_CLIENT_VERSION, UA } from "./config.ts";

export interface CatalogModel {
  id: string;
  name: string;
  unavailable?: boolean;
  section?: string;
  /** parsed "~Nx usage" multiplier, default 1 */
  multiplier: number;
}

export interface Catalog {
  models: CatalogModel[];
  latest: string;
  min: string;
  defaultModel: string;
  fetchedAt: number;
}

export interface MeStats {
  tier: string;
  cap_usd_today: number;
  spent_usd_today: number;
  remaining_usd_today: number;
  credit_credits?: number;
  allowance_credits?: number;
  remaining_credits_today?: number;
  refill_at?: string;
  lane?: string;
  request_count_today?: number;
  prompt_tokens_today?: number;
  completion_tokens_today?: number;
  streak?: { days: number };
}

export class Upstream {
  catalog: Catalog | null = null;
  private clientVersion = FALLBACK_CLIENT_VERSION;

  authHeaders(jwt: string): Record<string, string> {
    return {
      authorization: `Bearer ${jwt}`,
      "x-client-version": this.clientVersion,
      "user-agent": UA,
    };
  }

  /** GET /client-version — public; parses usage multipliers out of names. */
  async refreshCatalog(): Promise<Catalog | null> {
    try {
      const res = await fetch(new URL("/client-version", BASE_URL), { headers: { "user-agent": UA } });
      if (!res.ok) return this.catalog;
      const d = (await res.json()) as {
        min: string; latest: string; model: string;
        models: Array<{ id: string; name: string; unavailable?: boolean; section?: string }>;
      };
      this.clientVersion = d.latest || this.clientVersion;
      this.catalog = {
        latest: d.latest,
        min: d.min,
        defaultModel: d.model,
        fetchedAt: Date.now(),
        models: (d.models || []).map((m) => ({
          ...m,
          multiplier: Number(/~([\d.]+)x/.exec(m.name)?.[1] ?? 1),
        })),
      };
      return this.catalog;
    } catch {
      return this.catalog;
    }
  }

  multiplier(id: string): number {
    return this.catalog?.models.find((m) => m.id === id)?.multiplier ?? 1;
  }

  /** GET /me with the JWT (account + optional server notice). */
  async me(jwt: string): Promise<{ handle?: string; tier?: string; lane?: string; notice?: string } | null> {
    try {
      const res = await fetch(new URL("/me", BASE_URL), { headers: this.authHeaders(jwt) });
      if (!res.ok) return null;
      return (await res.json()) as { handle?: string; tier?: string; lane?: string; notice?: string };
    } catch { return null; }
  }

  /** GET /me/stats with the JWT. */
  async stats(jwt: string): Promise<MeStats | null> {
    try {
      const res = await fetch(new URL("/me/stats", BASE_URL), { headers: this.authHeaders(jwt) });
      if (!res.ok) return null;
      return (await res.json()) as MeStats;
    } catch {
      return null;
    }
  }

  /** POST one of the metered /tools/* endpoints. Returns parsed JSON or an error string. */
  async tool<T>(jwt: string, path: string, body: unknown): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
    try {
      const res = await fetch(new URL(path, BASE_URL), {
        method: "POST",
        headers: { ...this.authHeaders(jwt), "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
      if (res.ok) return { ok: true, data: (await res.json()) as T };
      const err = (await res.json().catch(() => ({}))) as { code?: string; message?: string };
      const mapped: Record<string, string> = {
        daily_cap: "The user's daily free usage is used up. Do not retry.",
        rolling_cap: "The user's short-term usage limit is reached. Do not retry.",
        rate_limited: "Too many calls right now. Wait and retry later.",
        not_configured: "This tool is not available on this server.",
        upstream_error: "The upstream provider failed. You may retry once.",
        content_rejected: "The provider rejected this prompt. Do not retry the same prompt.",
        account_review: "This account is under review; tool disabled.",
      };
      const code = err.code ?? "";
      return { ok: false, error: mapped[code] ?? `Request failed (HTTP ${res.status}): ${err.message ?? "no message"}` };
    } catch (e) {
      if (e instanceof Error && e.name === "TimeoutError") return { ok: false, error: "Request timed out." };
      return { ok: false, error: `Request failed: ${String(e)}` };
    }
  }

  webSearch(jwt: string, query: string, numResults?: number) {
    return this.tool<{ results: Array<{ title: string; url: string; published_date: string | null; text: string }>; cost_usd: string }>(
      jwt, "/tools/web-search", { query, ...(numResults ? { num_results: numResults } : {}) },
    );
  }

  docsLookup(jwt: string, library: string, query: string, libraryId?: string) {
    return this.tool<{ library_id: string; title: string; docs: string; cost_usd: string }>(
      jwt, "/tools/docs", { library, query, ...(libraryId ? { library_id: libraryId } : {}) },
    );
  }

  generateImage(jwt: string, prompt: string, aspectRatio?: string) {
    return this.tool<{ image_b64: string; media_type: string; cost_usd: string; model: string }>(
      jwt, "/tools/image", { prompt, ...(aspectRatio ? { aspect_ratio: aspectRatio } : {}) },
    );
  }

  /** POST /v1/chat/completions — returns the raw upstream Response for streaming. */
  completions(jwt: string, body: string, signal: AbortSignal, opts?: { sessionId?: string; gravityContext?: string }): Promise<Response> {
    const extra: Record<string, string> = {};
    if (opts?.sessionId) extra["x-session-id"] = opts.sessionId;
    if (opts?.gravityContext) extra["x-gravity-context"] = opts.gravityContext;
    return fetch(new URL("/v1/chat/completions", BASE_URL), {
      method: "POST",
      signal,
      headers: {
        ...this.authHeaders(jwt),
        "content-type": "application/json",
        ...extra,
      },
      body,
    });
  }

  /** GET /ads/next?slot=... with gravity context. 204/!ok => null. */
  async fetchAdNext(jwt: string, slot: string, sessionId: string, gravityContext?: string): Promise<any | null> {
    try {
      const extra: Record<string, string> = { "x-session-id": sessionId };
      if (gravityContext) extra["x-gravity-context"] = gravityContext;
      const res = await fetch(new URL(`/ads/next?slot=${encodeURIComponent(slot)}`, BASE_URL), {
        headers: { ...this.authHeaders(jwt), ...extra },
        signal: AbortSignal.timeout(5_000),
      });
      if (res.status === 204 || !res.ok) return null;
      return await res.json();
    } catch { return null; }
  }

  /** POST /ads/impression (best-effort). */
  async postImpression(jwt: string, adId: string, clickToken: string, sessionId: string, impFired = false): Promise<void> {
    try {
      await fetch(new URL("/ads/impression", BASE_URL), {
        method: "POST",
        headers: { ...this.authHeaders(jwt), "content-type": "application/json", "x-session-id": sessionId },
        body: JSON.stringify({ ad_id: adId, click_token: clickToken, ...(impFired ? { imp_fired: true } : {}) }),
        signal: AbortSignal.timeout(3_000),
      });
    } catch { /* best-effort */ }
  }
}
