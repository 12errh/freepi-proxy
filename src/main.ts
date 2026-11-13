// freepi-proxy entry point: wires the HTTP server, routes, background loops.

import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { PORT, BASE_URL } from "./config.ts";
import { Upstream } from "./upstream.ts";
import { newTracker } from "./track.ts";
import { bootState, onLoginToken, pollStats, startBackgroundLoops } from "./state.ts";
import type { Ctx } from "./state.ts";
import { handleCompletions, handleModels } from "./proxy.ts";
import {
  handleAnthropicCountTokens,
  handleAnthropicMessages,
  handleApiHello,
  handleClaudeConfig,
} from "./anthropic.ts";
import { handleMcp } from "./mcp.ts";
import { LoginManager } from "./token.ts";
import { startGravityPixel } from "./gravity.ts";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const upstream = new Upstream();
const tracker = newTracker();
await tracker.ready();
const state = await bootState();
let gravityGetter: (() => string | undefined) | undefined;
const ctx: Ctx = { upstream, tracker, state, getGravityContext: () => gravityGetter?.() };
const login = new LoginManager();
login.onToken = (token: string) => {
  onLoginToken(ctx)(token);
  gravityGetter = startGravityPixel(token);
};
if (state.token.token) gravityGetter = startGravityPixel(state.token.token);

const UI_HTML = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "ui.html"), "utf8");

// ---------- dashboard API ----------

function apiState(): ReturnType<typeof JSON.stringify> {
  const live = state.live;
  return JSON.stringify({
    status: {
      token: state.token.status,
      handle: state.token.handle,
      tier: live?.tier,
      lane: live?.lane,
      notice: state.notice,
      lifetimeRequests: live?.lifetime_requests,
    },
    live: {
      allowance_credits: live?.allowance_credits ?? null,
      remaining_credits_today: live?.remaining_credits_today ?? null,
      spent_usd_today: live?.spent_usd_today ?? null,
      cap_usd_today: live?.cap_usd_today ?? null,
      request_count_today: live?.request_count_today ?? null,
      prompt_tokens_today: live?.prompt_tokens_today ?? null,
      completion_tokens_today: live?.completion_tokens_today ?? null,
      refill_at: live?.refill_at ?? null,
      streak_days: live?.streak?.days ?? null,
      fetchedAgoMs: live ? Date.now() - state.liveAt : null,
    },
    recent: tracker.recent(250),
    hourly: tracker.hourly(24),
    days: tracker.byDay(14),
    models: tracker.byModel(3),
    catalog: upstream.catalog ? {
      fetchedAt: upstream.catalog.fetchedAt,
      defaultModel: upstream.catalog.defaultModel,
      latest: upstream.catalog.latest,
      min: upstream.catalog.min,
      models: upstream.catalog.models,
    } : null,
    server: {
      baseUrl: BASE_URL,
      startedAt: state.startedAt,
      uptimeMs: Date.now() - state.startedAt,
      proxyPort: PORT,
      lastCreditDiff: state.lastCreditDiff,
    },
  });
}

// ---------- routing ----------

async function route(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const p = url.pathname;

  if (p === "/v1/chat/completions" && req.method === "POST") return handleCompletions(req, ctx);
  if (p === "/v1/messages" && req.method === "POST") return handleAnthropicMessages(req, ctx);
  if (p === "/v1/messages/count_tokens" && req.method === "POST") return handleAnthropicCountTokens(req);
  if (p === "/v1/models" && req.method === "GET") return handleModels(ctx);
  if (p === "/mcp" && (req.method === "POST" || req.method === "GET" || req.method === "DELETE")) return handleMcp(req, ctx);

  // Claude Code probes this before opening the Messages stream.
  if (p === "/api/hello" && (req.method === "GET" || req.method === "HEAD")) return handleApiHello(req);
  if (p === "/api/claude/config" && req.method === "GET") return handleClaudeConfig(ctx);

  if (p === "/" || p === "/index.html") {
    return new Response(UI_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
  }

  if (p === "/api/state" && req.method === "GET") {
    return new Response(apiState(), { headers: { "content-type": "application/json" } });
  }

  if (p === "/api/login/start" && req.method === "POST") {
    const s = login.start();
    return Response.json({ ok: s.state !== "error", error: s.error ?? null });
  }

  if (p === "/api/login/status" && req.method === "GET") {
    const s = login.current;
    if (!s) return Response.json({ state: "idle" });
    return Response.json({
      state: s.state,
      error: s.error ?? null,
      user_code: s.flow?.user_code ?? null,
      verification_uri: s.flow?.verification_uri ?? null,
    });
  }


  // Ad endpoints (legitimate: dashboard shows the ad and reports impressions
  // so completions aren't paused for "ads not showing").
  if (p === "/api/ads/next" && req.method === "GET") {
    const jwt = state.token.token;
    if (!jwt) return Response.json({ ad: null, reason: "no_token" });
    const slot = url.searchParams.get("slot") || "banner";
    const ad = await upstream.fetchAdNext(jwt, slot, state.sessionId, ctx.getGravityContext?.());
    if (!ad) return new Response(null, { status: 204 });
    // expose imp_url to the browser so it can fire the Gravity pixel client-side
    return Response.json(ad);
  }

  if (p === "/api/ads/impression" && req.method === "POST") {
    const jwt = state.token.token;
    if (!jwt) return Response.json({ ok: false });
    try {
      const b = await req.json() as { ad_id: string; click_token: string; imp_fired?: boolean };
      await upstream.postImpression(jwt, b.ad_id, b.click_token, state.sessionId, b.imp_fired === true);
      return Response.json({ ok: true });
    } catch { return Response.json({ ok: false }); }
  }

  if (p === "/api/stats/refresh" && req.method === "POST") {
    await pollStats(ctx).catch(() => {});
    return Response.json({ ok: true });
  }

  return new Response("not found", { status: 404 });
}

// node:http <-> fetch Request bridge (works on node and bun)

const server = createServer(async (nodeReq: IncomingMessage, nodeRes: ServerResponse) => {
  const ac = new AbortController();
  nodeReq.on("error", () => ac.abort());
  nodeRes.on("close", () => { if (!nodeRes.writableEnded) ac.abort(); });
  try {
    const body = await readBody(nodeReq);
    const req = new Request(`http://127.0.0.1:${PORT}${nodeReq.url ?? "/"}`, {
      method: nodeReq.method ?? "GET",
      headers: sanitizeHeaders(nodeReq.headers),
      body: ["GET", "HEAD"].includes(nodeReq.method ?? "GET") ? undefined : body,
      duplex: "half",
      signal: ac.signal,
    } as RequestInit);
    const res = await route(req);
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => { headers[k] = v; });
    nodeRes.writeHead(res.status, headers);
    if (res.body) {
      const reader = res.body.getReader();
      nodeRes.on("close", () => void reader.cancel().catch(() => {}));
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!nodeRes.write(value)) {
          await new Promise<void>((r) => nodeRes.once("drain", () => r()));
        }
      }
    }
    nodeRes.end();
  } catch (e) {
    if (!nodeRes.headersSent) {
      nodeRes.writeHead(500, { "content-type": "application/json" });
      nodeRes.end(JSON.stringify({ error: { message: `proxy internal error: ${String(e)}`, type: "freepi_proxy_error" } }));
    } else {
      nodeRes.end();
    }
  }
});

function sanitizeHeaders(h: IncomingMessage["headers"]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    if (v === undefined) continue;
    if (["host", "connection", "content-length", "transfer-encoding", "keep-alive", "upgrade"].includes(k)) continue;
    out[k] = Array.isArray(v) ? v.join(", ") : v;
  }
  return out;
}

function readBody(req: IncomingMessage): Promise<Buffer | undefined> {
  return new Promise((resolve, reject) => {
    if (["GET", "HEAD"].includes(req.method ?? "GET")) return resolve(undefined);
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 512 * 1024 * 1024) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

startBackgroundLoops(ctx, () => {});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`freepi-proxy  →  http://127.0.0.1:${PORT}`);
  console.log(`  completions : http://127.0.0.1:${PORT}/v1  (OpenAI-compatible)`);
  console.log(`  messages    : http://127.0.0.1:${PORT}/v1/messages  (Anthropic-compatible)`);
  console.log(`  claude      : freepi-proxy claude`);
  console.log(`  MCP         : http://127.0.0.1:${PORT}/mcp`);
  console.log(`  dashboard   : http://127.0.0.1:${PORT}`);
  console.log(`  upstream    : ${BASE_URL}`);
  if (!state.token.token) console.log("  ⚠ no free-pi token — open the dashboard to log in");
});
