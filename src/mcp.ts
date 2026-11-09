// MCP server over Streamable HTTP (POST /mcp, JSON responses). Exposes the
// free-pi special tools: generate_image, web_search, docs_lookup, check_usage.
// Stateless single-JSON-response implementation — no SSE needed for tool calls.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { DASHBOARD_URL, IMAGE_FALLBACK_DIR } from "./config.ts";
import type { Ctx } from "./state.ts";
import { settleSpend } from "./state.ts";

async function logTool(ctx: Ctx, kind: "web_search" | "docs_lookup" | "generate_image", model: string): Promise<void> {
  await ctx.tracker.add({ ts: Date.now(), kind, model, pt: 0, ct: 0, credits: null, ms: 0, status: 200, source: "mcp" });
  const settle = await settleSpend(ctx, 3_000);
  if (settle) ctx.tracker.reconcile(settle.credits, settle.sinceTs);
}

// ---------- JSON-RPC ----------

interface RpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

function rpcResult(id: RpcRequest["id"], result: unknown): Response {
  return Response.json({ jsonrpc: "2.0", id, result });
}

function rpcError(id: RpcRequest["id"], code: number, message: string): Response {
  return Response.json({ jsonrpc: "2.0", id, error: { code, message } });
}

// ---------- tool schemas ----------

const TOOLS = [
  {
    name: "generate_image",
    description:
      "Generate one image from a text prompt and save it under images/ in the project. " +
      "Returns the file path; you cannot see the image. Use it only when the user asks for an image, mockup, icon or illustration. " +
      "Each call uses part of the user's daily free-pi allowance.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "What to draw: subject, style, any exact text to render, and composition" },
        aspect_ratio: { type: "string", enum: ["1:1", "16:9", "9:16", "4:3", "3:2"], description: "Default 1:1" },
        name: { type: "string", description: "Short file name hint, e.g. hero-banner" },
      },
      required: ["prompt"],
    },
  },
  {
    name: "web_search",
    description:
      "Search the web and return a numbered list of results with title, URL, publish date and page text. " +
      "For current or recent information your training data may lack. Each call uses part of the user's daily allowance.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: 'Specific query as you would type into a search engine, e.g. "vite 6 release notes"' },
        num_results: { type: "integer", minimum: 1, maximum: 10, description: "1-10, default 5" },
      },
      required: ["query"],
    },
  },
  {
    name: "docs_lookup",
    description:
      "Look up current documentation for a third-party library, framework or API. " +
      "Returns the matching library's title and library_id, then docs relevant to your query. " +
      "Prefer this over relying on memory for exact signatures and options. Each call uses part of the user's daily allowance.",
    inputSchema: {
      type: "object",
      properties: {
        library: { type: "string", description: 'Package name, e.g. "next.js", "prisma", "@tanstack/react-query"' },
        query: { type: "string", description: 'One specific question, e.g. "configure middleware matcher for API routes"' },
        library_id: { type: "string", description: "library_id from an earlier docs_lookup; skips the name search" },
      },
      required: ["library", "query"],
    },
  },
  {
    name: "check_usage",
    description:
      "Report the free-pi account's current usage: tier, daily allowance remaining (credits), refill time, and today's token counts. Read-only.",
    inputSchema: { type: "object", properties: {} },
  },
] as const;

// ---------- tool execution ----------

interface ToolResult { content: Array<{ type: "text"; text: string }>; isError?: boolean }

function txt(content: string, isError = false): ToolResult {
  return { content: [{ type: "text", text: content }], ...(isError ? { isError: true } : {}) };
}

function requireJwt(ctx: Ctx): string | ToolResult {
  const jwt = ctx.state.token.token;
  if (!jwt || ctx.state.token.status === "rejected") {
    return txt(`No valid free-pi token. Open the dashboard (${DASHBOARD_URL}) and log in first.`, true);
  }
  return jwt;
}

async function callTool(ctx: Ctx, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const jwtOr = requireJwt(ctx);
  if (!(typeof jwtOr === "string")) return jwtOr;
  const jwt = jwtOr;

  switch (name) {
    case "generate_image": {
      const prompt = String(args.prompt ?? "").slice(0, 1000);
      if (!prompt) return txt("prompt is required", true);
      const ar = typeof args.aspect_ratio === "string" ? args.aspect_ratio : undefined;
      const r = await ctx.upstream.generateImage(jwt, prompt, ar);
      if (!r.ok) return txt(r.error, true);
      const buf = Buffer.from(r.data.image_b64 ?? "", "base64");
      const ext = ({ "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" } as Record<string, string>)[r.data.media_type] ?? "png";
      const slug = (String(args.name ?? prompt).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+/, "").slice(0, 40).replace(/-+$/, "") || "image");
      const rel = `images/${slug}-${randomBytes(3).toString("hex")}.${ext}`;
      try {
        await mkdir(join(process.cwd(), "images"), { recursive: true });
        await writeFile(join(process.cwd(), rel), buf, { flag: "wx" });
      } catch {
        await mkdir(IMAGE_FALLBACK_DIR, { recursive: true });
        const fb = join(IMAGE_FALLBACK_DIR, `${slug}-${randomBytes(3).toString("hex")}.${ext}`);
        await writeFile(fb, buf).catch(() => {});
        return txt(`Saved image to ${fb} (cost: ${r.data.cost_usd}). You cannot see the image; reference the path in your answer and tell the user you could not check how it looks.`);
      }
      await logTool(ctx, "generate_image", r.data.model || "image");
      return txt(`Saved image to ${rel} (${ext}, ${buf.length} bytes, cost: ${r.data.cost_usd}). You cannot see the image; reference this path in your answer or code, and tell the user you could not check how it looks.`);
    }
    case "web_search": {
      const query = String(args.query ?? "").slice(0, 500);
      if (!query) return txt("query is required", true);
      const num = typeof args.num_results === "number" ? args.num_results : undefined;
      const r = await ctx.upstream.webSearch(jwt, query, num);
      if (!r.ok) return txt(r.error, true);
      const results = r.data.results ?? [];
      const out = results.length
        ? `Web results for "${query}":\n\n` + results.map((x, i) => `${i + 1}. ${x.title}\n${x.url}${x.published_date ? `\nPublished: ${x.published_date}` : ""}\n${x.text}`).join("\n\n")
        : `No results for "${query}". Try a broader or differently worded query.`;
      await logTool(ctx, "web_search", "web_search");
      return txt(out);
    }
    case "docs_lookup": {
      const library = String(args.library ?? "").slice(0, 200);
      const query = String(args.query ?? "").slice(0, 500);
      if (!library || !query) return txt("library and query are required", true);
      const libId = typeof args.library_id === "string" ? args.library_id : undefined;
      const r = await ctx.upstream.docsLookup(jwt, library, query, libId);
      if (!r.ok) return txt(r.error, true);
      await logTool(ctx, "docs_lookup", r.data.library_id || "docs_lookup");
      return txt(`${r.data.title} (library_id: ${r.data.library_id})\n\n${r.data.docs}`);
    }
    case "check_usage": {
      const s = await ctx.upstream.stats(jwt);
      if (!s) return txt("Could not fetch usage (upstream error or no token).", true);
      const creditsLeft = typeof s.remaining_credits_today === "number" ? s.remaining_credits_today : null;
      const allowance = typeof s.allowance_credits === "number" ? s.allowance_credits : null;
      return txt([
        `tier: ${s.tier}`,
        allowance !== null && creditsLeft !== null
          ? `credits: ${creditsLeft.toLocaleString("en-US")} of ${allowance.toLocaleString("en-US")} remaining today${s.refill_at ? ` (refills ${s.refill_at})` : ""}`
          : `today: ${s.spent_usd_today} / ${s.cap_usd_today} USD used`,
        s.lane === "fallback" ? "lane: fallback (slow lane active)" : `lane: ${s.lane ?? "standard"}`,
        `today tokens: ${s.prompt_tokens_today ?? 0} prompt / ${s.completion_tokens_today ?? 0} completion`,
        `today requests: ${s.request_count_today ?? 0}`,
        `dashboard: ${DASHBOARD_URL}`,
      ].join("\n"));
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

// ---------- HTTP entry ----------

export async function handleMcp(req: Request, ctx: Ctx): Promise<Response> {
  if (req.method === "GET") {
    return new Response("SSE streaming not supported; POST JSON-RPC here.", { status: 405 });
  }
  if (req.method === "DELETE") return new Response(null, { status: 204 });
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

  let rpc: RpcRequest;
  try {
    rpc = (await req.json()) as RpcRequest;
  } catch {
    return rpcError(null, -32700, "parse error");
  }
  const id = rpc.id ?? null;
  const isNotification = rpc.id === undefined || rpc.id === null;

  switch (rpc.method) {
    case "initialize":
      return rpcResult(id, {
        protocolVersion: (rpc.params as { protocolVersion?: string } | undefined)?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "freepi-proxy", version: "1.0.0" },
      });
    case "notifications/initialized":
      return new Response(null, { status: 202 });
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: TOOLS });
    case "tools/call": {
      const params = rpc.params as { name?: string; arguments?: Record<string, unknown> } | undefined;
      try {
        const result = await callTool(ctx, params?.name ?? "", params?.arguments ?? {});
        if (isNotification) return new Response(null, { status: 202 });
        return rpcResult(id, result);
      } catch (e) {
        if (isNotification) return new Response(null, { status: 202 });
        return rpcResult(id, txt(e instanceof Error ? e.message : String(e), true));
      }
    }
    default:
      if (isNotification) return new Response(null, { status: 202 });
      return rpcError(id, -32601, `method not found: ${rpc.method}`);
  }
}
