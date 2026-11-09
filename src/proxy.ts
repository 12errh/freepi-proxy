// /v1/chat/completions proxy: forwards to free-pi with injected auth, streams
// the response through untouched, and tees usage (tokens) out of the SSE/JSON
// body for the dashboard. Also serves /v1/models from the live catalog.

import { CREDIT_DIFF_MIN_MS, DASHBOARD_URL, EST_CREDITS_PER_TOKEN } from "./config.ts";
import type { Ctx } from "./state.ts";
import { settleSpend } from "./state.ts";

/** Instant local estimate: tokens × model multiplier × calibrated base rate. */
export function estimateCredits(ctx: Ctx, model: string, pt: number, ct: number): number {
  return Math.round((pt + ct) * ctx.upstream.multiplier(model) * EST_CREDITS_PER_TOKEN * 10) / 10;
}

interface Usage { prompt_tokens?: number; completion_tokens?: number }

/** Extract usage from a full non-stream JSON body. */
function usageFromJson(body: string): Usage | null {
  try {
    const j = JSON.parse(body) as { usage?: Usage };
    return j.usage ? { prompt_tokens: j.usage.prompt_tokens, completion_tokens: j.usage.completion_tokens } : null;
  } catch {
    return null;
  }
}

/** Extract the last non-null usage object from an SSE stream text. */
function usageFromSse(buf: string): Usage | null {
  let found: Usage | null = null;
  for (const line of buf.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const j = JSON.parse(payload) as { usage?: Usage | null };
      if (j.usage && (j.usage.prompt_tokens || j.usage.completion_tokens)) found = j.usage;
    } catch { /* partial line */ }
  }
  return found;
}

export function handleModels(ctx: Ctx): Response {
  const models = (ctx.upstream.catalog?.models ?? [])
    .filter((m) => !m.unavailable)
    .map((m) => ({ id: m.id, object: "model", owned_by: "free-pi" }));
  return Response.json({ object: "list", data: models });
}

export async function handleCompletions(req: Request, ctx: Ctx): Promise<Response> {
  const started = Date.now();
  const jwt = ctx.state.token.token;
  if (!jwt) {
    return Response.json(
      { error: { message: "No free-pi token. Open the dashboard to log in: " + DASHBOARD_URL, type: "freepi_proxy_error", code: "no_token" } },
      { status: 401 },
    );
  }

  const raw = await req.text();
  let model = "unknown";
  let isStream = false;
  try {
    const parsed = JSON.parse(raw) as { model?: string; stream?: boolean };
    model = parsed.model ?? model;
    isStream = parsed.stream === true;
  } catch { /* let upstream reject */ }

  const source = new URL(req.url).searchParams.get("source") || "api";
  let upstream: Response;
  try {
    upstream = await ctx.upstream.completions(jwt, raw, req.signal, {
      sessionId: ctx.state.sessionId,
      gravityContext: ctx.getGravityContext?.(),
    });
  } catch (e) {
    await ctx.tracker.add({
      ts: started, kind: "chat", model, pt: 0, ct: 0, credits: null, ms: Date.now() - started,
      status: 0, source, error: e instanceof Error ? e.message : String(e),
    });
    return Response.json(
      { error: { message: `Upstream connection failed: ${String(e)}`, type: "freepi_proxy_error", code: "network" } },
      { status: 502 },
    );
  }

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => "");
    await ctx.tracker.add({
      ts: started, kind: "chat", model, pt: 0, ct: 0, credits: null, ms: Date.now() - started,
      status: upstream.status, source, error: text.slice(0, 300),
    });
    // pass upstream error shape through (401 daily caps etc.)
    return new Response(text || JSON.stringify({ error: { message: `upstream HTTP ${upstream.status}`, type: "freepi_proxy_error" } }), {
      status: upstream.status,
      headers: { "content-type": upstream.headers.get("content-type") || "application/json" },
    });
  }

  // ---------- success: stream through, tee usage ----------
  const ctype = upstream.headers.get("content-type") || "application/json";

  if (!upstream.body) {
    return new Response(upstream.body, { status: upstream.status, headers: { "content-type": ctype } });
  }

  const decoder = new TextDecoder();
  let carry = ""; // tail bytes that may split a multi-byte char
  let full = "";  // only populated for non-stream (small)
  let usage: Usage | null = null;

  const tee = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const text = carry + decoder.decode(chunk, { stream: true });
      if (isStream) {
        usage = usageFromSse(text) ?? usage;
        carry = tailAfterLastNewline(text);
      } else {
        full += text;
        carry = "";
      }
      controller.enqueue(chunk);
    },
    flush() {
      if (isStream) {
        const rest = carry + decoder.decode();
        usage = usageFromSse(rest) ?? usage;
      } else {
        full += decoder.decode();
        usage = usageFromJson(full) ?? usage;
      }
    },
  });

  // Split the parsed stream: one branch to the client, one drained locally to
  // capture usage — pipeTo on a single readable would consume it and the
  // client would receive nothing.
  const [clientStream, drainStream] = upstream.body.pipeThrough(tee).tee();

  // record with an instant estimate; reconcile later when the server settles
  void drainStream.pipeTo(new WritableStream({ write() {} })).catch(() => {}).finally(() => {
    void (async () => {
      const pt = usage?.prompt_tokens ?? 0;
      const ct = usage?.completion_tokens ?? 0;
      await ctx.tracker.add({
        ts: started, kind: "chat", model,
        pt, ct,
        credits: estimateCredits(ctx, model, pt, ct),
        ms: Date.now() - started, status: upstream.status, source,
      });
      const settle = await settleSpend(ctx, CREDIT_DIFF_MIN_MS);
      if (settle) ctx.tracker.reconcile(settle.credits, settle.sinceTs);
    })();
  });

  return new Response(clientStream, {
    status: upstream.status,
    headers: {
      "content-type": ctype,
      "cache-control": "no-cache",
    },
  });
}

function tailAfterLastNewline(text: string): string {
  const i = text.lastIndexOf("\n");
  return i === -1 ? text : text.slice(i + 1);
}
