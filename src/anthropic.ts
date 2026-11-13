// Anthropic Messages API compatibility for Claude Code.
//
// Claude Code speaks Anthropic's /v1/messages (streaming SSE + tool use). This
// module translates that dialect to/from the OpenAI chat-completions shape the
// free-pi backend speaks, including tool calls, images, and mid-conversation
// system turns. It also serves /api/hello and the Claude settings config.

import { CREDIT_DIFF_MIN_MS, DASHBOARD_URL } from "./config.ts";
import type { Ctx } from "./state.ts";
import { settleSpend } from "./state.ts";
import { estimateCredits } from "./proxy.ts";
import type { Catalog } from "./upstream.ts";
import {
  allModelChoices,
  freeModelChoices,
  pickClaudeModels,
  resolveModel,
} from "./models.ts";

interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
}

interface AnthropicRequest {
  model?: string;
  messages?: unknown;
  system?: unknown;
  tools?: unknown;
  tool_choice?: unknown;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  stream?: boolean;
  [key: string]: unknown;
}

interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null | Array<Record<string, unknown>>;
  tool_calls?: Array<Record<string, unknown>>;
  tool_call_id?: string;
}

export interface TranslatedRequest {
  body: Record<string, unknown>;
  /** free-pi catalog id sent upstream */
  model: string;
  /** same id returned to the Anthropic client */
  displayModel: string;
  stream: boolean;
  estimatedInputTokens: number;
}

// ---------- request translation ----------

function systemText(system: unknown): string {
  if (typeof system === "string") return system;
  if (!Array.isArray(system)) return "";
  return system
    .map((block) => {
      if (typeof block === "string") return block;
      if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
        return String((block as { text?: unknown }).text ?? "");
      }
      return "";
    })
    .filter(Boolean)
    .join("\n\n");
}

function flattenText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (typeof block === "string") return block;
      if (!block || typeof block !== "object") return "";
      const b = block as { type?: string; text?: unknown };
      if (b.type === "text") return String(b.text ?? "");
      if (b.type === "image") return "[image]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function imageUrl(source: unknown): string | null {
  if (!source || typeof source !== "object") return null;
  const s = source as { type?: string; media_type?: string; data?: string; url?: string };
  if (s.type === "base64" && s.data) {
    return `data:${s.media_type || "image/png"};base64,${s.data}`;
  }
  if (s.type === "url" && s.url) return s.url;
  return null;
}

function toolResultText(block: { content?: unknown; is_error?: boolean }): string {
  let text = flattenText(block.content);
  if (!text) text = "(no output)";
  if (block.is_error) text = `[tool error] ${text}`;
  return text;
}

function translateMessages(messages: unknown): OpenAIMessage[] {
  const out: OpenAIMessage[] = [];
  for (const raw of Array.isArray(messages) ? messages : []) {
    if (!raw || typeof raw !== "object") continue;
    const msg = raw as { role?: string; content?: unknown };
    const content = msg.content;

    if (msg.role === "system") {
      const text = flattenText(content);
      if (text) out.push({ role: "system", content: text });
      continue;
    }

    if (msg.role === "user") {
      if (typeof content === "string") {
        out.push({ role: "user", content });
        continue;
      }
      if (!Array.isArray(content)) continue;
      const toolResults: OpenAIMessage[] = [];
      const parts: Array<Record<string, unknown>> = [];
      for (const rawBlock of content) {
        if (!rawBlock || typeof rawBlock !== "object") continue;
        const block = rawBlock as {
          type?: string; text?: unknown; source?: unknown;
          tool_use_id?: unknown; content?: unknown; is_error?: boolean;
        };
        if (block.type === "text") {
          const text = String(block.text ?? "");
          if (text) parts.push({ type: "text", text });
        } else if (block.type === "image") {
          const url = imageUrl(block.source);
          if (url) parts.push({ type: "image_url", image_url: { url } });
        } else if (block.type === "tool_result") {
          toolResults.push({
            role: "tool",
            tool_call_id: String(block.tool_use_id ?? ""),
            content: toolResultText(block),
          });
        }
      }
      out.push(...toolResults);
      if (parts.length) {
        if (parts.every((p) => p.type === "text")) {
          out.push({ role: "user", content: parts.map((p) => String(p.text ?? "")).join("\n\n") });
        } else {
          out.push({ role: "user", content: parts });
        }
      }
      continue;
    }

    if (msg.role === "assistant") {
      if (typeof content === "string") {
        if (content) out.push({ role: "assistant", content });
        continue;
      }
      if (!Array.isArray(content)) continue;
      let text = "";
      const toolCalls: Array<Record<string, unknown>> = [];
      for (const rawBlock of content) {
        if (!rawBlock || typeof rawBlock !== "object") continue;
        const block = rawBlock as { type?: string; text?: unknown; id?: string; name?: string; input?: unknown };
        if (block.type === "text") {
          text += String(block.text ?? "");
        } else if (block.type === "tool_use") {
          toolCalls.push({
            id: block.id || `call_${crypto.randomUUID().replace(/-/g, "")}`,
            type: "function",
            function: {
              name: block.name || "unknown",
              arguments: JSON.stringify(block.input ?? {}),
            },
          });
        }
      }
      if (!text && !toolCalls.length) continue;
      const message: OpenAIMessage = { role: "assistant", content: text || null };
      if (toolCalls.length) message.tool_calls = toolCalls;
      out.push(message);
    }
  }
  return out;
}

function translateTools(tools: unknown): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(tools)) return undefined;
  const out: Array<Record<string, unknown>> = [];
  for (const raw of tools) {
    if (!raw || typeof raw !== "object") continue;
    const tool = raw as { name?: unknown; description?: unknown; input_schema?: unknown };
    if (typeof tool.name !== "string" || !tool.name) continue;
    let parameters: Record<string, unknown> = { type: "object", properties: {} };
    if (tool.input_schema && typeof tool.input_schema === "object" && !Array.isArray(tool.input_schema)) {
      parameters = { ...(tool.input_schema as Record<string, unknown>) };
      delete parameters.$schema;
    }
    out.push({
      type: "function",
      function: {
        name: tool.name,
        ...(typeof tool.description === "string" ? { description: tool.description } : {}),
        parameters,
      },
    });
  }
  return out.length ? out : undefined;
}

function translateToolChoice(choice: unknown): unknown {
  if (!choice || typeof choice !== "object") return undefined;
  const c = choice as { type?: string; name?: string };
  if (c.type === "auto") return "auto";
  if (c.type === "any") return "required";
  if (c.type === "none") return "none";
  if (c.type === "tool" && c.name) return { type: "function", function: { name: c.name } };
  return undefined;
}

export function translateAnthropicRequest(catalog: Catalog | null, input: AnthropicRequest): TranslatedRequest {
  const requested = typeof input.model === "string" ? input.model : "";
  const model = resolveModel(catalog, requested);
  const stream = input.stream === true;

  const messages = translateMessages(input.messages);
  const system = systemText(input.system);
  if (system) messages.unshift({ role: "system", content: system });

  const body: Record<string, unknown> = { model, messages, stream };
  if (typeof input.max_tokens === "number") body.max_tokens = input.max_tokens;
  if (typeof input.temperature === "number") body.temperature = input.temperature;
  if (typeof input.top_p === "number") body.top_p = input.top_p;
  if (Array.isArray(input.stop_sequences) && input.stop_sequences.length) body.stop = input.stop_sequences;

  const tools = translateTools(input.tools);
  if (tools) body.tools = tools;
  const toolChoice = translateToolChoice(input.tool_choice);
  if (toolChoice !== undefined) body.tool_choice = toolChoice;
  if (input.tool_choice && typeof input.tool_choice === "object") {
    const disable = (input.tool_choice as { disable_parallel_tool_use?: boolean }).disable_parallel_tool_use;
    if (disable === true) body.parallel_tool_calls = false;
  }
  if (stream) body.stream_options = { include_usage: true };

  return {
    body,
    model,
    displayModel: model,
    stream,
    estimatedInputTokens: estimateRequestTokens(body),
  };
}

// ---------- token estimation ----------

export function estimateTokens(value: unknown): number {
  if (value == null) return 0;
  const text = typeof value === "string" ? value : (JSON.stringify(value) ?? "");
  if (!text) return 0;
  let cjk = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if ((cp >= 0x3400 && cp <= 0x9fff) || (cp >= 0xf900 && cp <= 0xfaff)
      || (cp >= 0x3040 && cp <= 0x30ff) || (cp >= 0xac00 && cp <= 0xd7af)) cjk++;
  }
  return Math.max(1, Math.ceil((text.length - cjk) / 4) + cjk);
}

function estimateRequestTokens(body: Record<string, unknown>): number {
  let total = estimateTokens(body.messages);
  if (body.tools) total += estimateTokens(body.tools);
  return Math.max(1, total);
}

export function countInputTokens(input: AnthropicRequest): number {
  let total = estimateTokens(input.system ?? "");
  for (const message of Array.isArray(input.messages) ? input.messages : []) {
    const m = message as { content?: unknown };
    total += estimateTokens(m?.content) + 4;
  }
  if (input.tools) total += estimateTokens(input.tools);
  return Math.max(1, total);
}

// ---------- response translation ----------

export function mapStopReason(finish: string | null | undefined, hasToolUse: boolean): string {
  if (finish === "length") return "max_tokens";
  if (hasToolUse) return "tool_use";
  if (finish === "tool_calls" || finish === "function_call") return "tool_use";
  return "end_turn";
}

function parseToolInput(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function messageId(upstreamId: unknown): string {
  if (typeof upstreamId === "string" && upstreamId) {
    return upstreamId.startsWith("msg_") ? upstreamId : `msg_${upstreamId}`;
  }
  return `msg_${crypto.randomUUID().replace(/-/g, "")}`;
}

export function toAnthropicResponse(openai: Record<string, any>, displayModel: string): Record<string, unknown> {
  const choice = openai?.choices?.[0] ?? {};
  const message = choice.message ?? {};
  const content: Array<Record<string, unknown>> = [];
  const text = typeof message.content === "string"
    ? message.content
    : flattenText(message.content);
  if (text) content.push({ type: "text", text });

  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  for (const call of toolCalls) {
    content.push({
      type: "tool_use",
      id: typeof call?.id === "string" && call.id
        ? call.id
        : `toolu_${crypto.randomUUID().replace(/-/g, "")}`,
      name: call?.function?.name ?? "unknown",
      input: parseToolInput(call?.function?.arguments),
    });
  }
  if (!content.length) content.push({ type: "text", text: "" });

  const usage = openai?.usage ?? {};
  return {
    id: messageId(openai?.id),
    type: "message",
    role: "assistant",
    model: displayModel,
    content,
    stop_reason: mapStopReason(choice.finish_reason, toolCalls.length > 0),
    stop_sequence: null,
    usage: {
      input_tokens: usage.prompt_tokens ?? 0,
      output_tokens: usage.completion_tokens ?? 0,
    },
  };
}

// ---------- streaming translation ----------

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

interface ToolAccumulator {
  id: string;
  name: string;
  args: string;
}

/** Converts an OpenAI SSE stream into Anthropic Messages SSE events. Tool
 * calls are buffered until the stream finishes so content blocks stay
 * sequential (Anthropic requires start → deltas → stop per block). */
export class AnthropicStreamTranslator {
  readonly model: string;
  private readonly inputTokens: number;
  private readonly id = `msg_${crypto.randomUUID().replace(/-/g, "")}`;
  private buffer = "";
  private started = false;
  private finished = false;
  private textIndex = -1;
  private textOpen = false;
  private nextIndex = 0;
  private readonly tools = new Map<number, ToolAccumulator>();
  private lastToolIndex = -1;
  private finishReason: string | null = null;
  private readonly used: Usage = { prompt_tokens: 0, completion_tokens: 0 };

  constructor(model: string, estimatedInputTokens = 0) {
    this.model = model;
    this.inputTokens = Math.max(0, estimatedInputTokens);
    this.used.prompt_tokens = this.inputTokens;
  }

  get usage(): Usage {
    return this.used;
  }

  push(text: string): string {
    this.buffer += text;
    let out = "";
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline === -1) break;
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      out += this.handleLine(line);
    }
    return out;
  }

  finish(): string {
    if (this.finished) return "";
    this.finished = true;
    let out = "";
    if (this.buffer.trim()) {
      out += this.handleLine(this.buffer.trim());
      this.buffer = "";
    }
    if (!this.started) out += this.startEvent();
    if (this.textOpen) {
      out += sse("content_block_stop", { type: "content_block_stop", index: this.textIndex });
      this.textOpen = false;
    }

    const tools = [...this.tools.entries()].sort((a, b) => a[0] - b[0]);
    for (const [, tool] of tools) {
      if (!tool.name) continue;
      const index = this.nextIndex++;
      out += sse("content_block_start", {
        type: "content_block_start",
        index,
        content_block: {
          type: "tool_use",
          id: tool.id || `toolu_${crypto.randomUUID().replace(/-/g, "")}`,
          name: tool.name,
          input: {},
        },
      });
      out += sse("content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(parseToolInput(tool.args)) },
      });
      out += sse("content_block_stop", { type: "content_block_stop", index });
    }

    const hasToolUse = tools.some(([, tool]) => Boolean(tool.name));
    out += sse("message_delta", {
      type: "message_delta",
      delta: { stop_reason: mapStopReason(this.finishReason, hasToolUse), stop_sequence: null },
      usage: {
        input_tokens: this.used.prompt_tokens ?? 0,
        output_tokens: this.used.completion_tokens ?? 0,
      },
    });
    out += sse("message_stop", { type: "message_stop" });
    return out;
  }

  private handleLine(line: string): string {
    if (!line.startsWith("data:")) return "";
    const payload = line.slice(5).trim();
    if (!payload) return "";
    if (payload === "[DONE]") return this.finish();
    let chunk: Record<string, any>;
    try {
      chunk = JSON.parse(payload) as Record<string, any>;
    } catch {
      return "";
    }
    return this.handleChunk(chunk);
  }

  private handleChunk(chunk: Record<string, any>): string {
    if (chunk.usage && typeof chunk.usage === "object") {
      if (typeof chunk.usage.prompt_tokens === "number") this.used.prompt_tokens = chunk.usage.prompt_tokens;
      if (typeof chunk.usage.completion_tokens === "number") this.used.completion_tokens = chunk.usage.completion_tokens;
    }

    let out = "";
    if (!this.started) out += this.startEvent();
    const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
    if (!choice) return out;

    const delta = choice.delta ?? {};
    if (typeof delta.content === "string" && delta.content.length) {
      out += this.textDelta(delta.content);
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const call of delta.tool_calls) this.toolDelta(call);
    }
    if (choice.finish_reason) this.finishReason = choice.finish_reason;
    return out;
  }

  private startEvent(): string {
    this.started = true;
    return sse("message_start", {
      type: "message_start",
      message: {
        id: this.id,
        type: "message",
        role: "assistant",
        model: this.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: this.used.prompt_tokens ?? 0, output_tokens: 0 },
      },
    });
  }

  private textDelta(text: string): string {
    let out = "";
    if (!this.textOpen) {
      this.textIndex = this.nextIndex++;
      this.textOpen = true;
      out += sse("content_block_start", {
        type: "content_block_start",
        index: this.textIndex,
        content_block: { type: "text", text: "" },
      });
    }
    out += sse("content_block_delta", {
      type: "content_block_delta",
      index: this.textIndex,
      delta: { type: "text_delta", text },
    });
    return out;
  }

  private toolDelta(call: Record<string, any>): void {
    const index = typeof call?.index === "number"
      ? call.index
      : (this.lastToolIndex >= 0 ? this.lastToolIndex : this.tools.size);
    this.lastToolIndex = index;
    let tool = this.tools.get(index);
    if (!tool) {
      tool = { id: "", name: "", args: "" };
      this.tools.set(index, tool);
    }
    if (typeof call.id === "string" && call.id) tool.id = call.id;
    const fn = call.function;
    if (fn && typeof fn === "object") {
      if (typeof fn.name === "string" && fn.name) tool.name = fn.name;
      if (typeof fn.arguments === "string") tool.args += fn.arguments;
      else if (fn.arguments != null) tool.args += JSON.stringify(fn.arguments);
    }
  }
}

// ---------- handlers ----------

export function anthropicError(status: number, type: string, message: string): Response {
  return Response.json({ type: "error", error: { type, message } }, { status });
}

export function errorTypeForStatus(status: number): string {
  if (status === 400) return "invalid_request_error";
  if (status === 401) return "authentication_error";
  if (status === 403) return "permission_error";
  if (status === 404) return "not_found_error";
  if (status === 413) return "request_too_large";
  if (status === 429) return "rate_limit_error";
  if (status === 529) return "overloaded_error";
  return "api_error";
}

function upstreamErrorMessage(text: string, status: number): string {
  if (!text) return `Upstream returned HTTP ${status}.`;
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string }; message?: string };
    const message = parsed?.error?.message ?? parsed?.message;
    if (typeof message === "string" && message) return message;
  } catch { /* not JSON */ }
  return text.slice(0, 500);
}

async function record(
  ctx: Ctx,
  started: number,
  model: string,
  source: string,
  status: number,
  usage: Usage | null,
  error?: string,
): Promise<void> {
  const pt = usage?.prompt_tokens ?? 0;
  const ct = usage?.completion_tokens ?? 0;
  await ctx.tracker.add({
    ts: started,
    kind: "chat",
    model,
    pt,
    ct,
    credits: estimateCredits(ctx, model, pt, ct),
    ms: Date.now() - started,
    status,
    source,
    ...(error ? { error } : {}),
  });
  const settle = await settleSpend(ctx, CREDIT_DIFF_MIN_MS);
  if (settle) ctx.tracker.reconcile(settle.credits, settle.sinceTs);
}

export async function handleAnthropicMessages(req: Request, ctx: Ctx): Promise<Response> {
  const started = Date.now();
  const jwt = ctx.state.token.token;
  if (!jwt) {
    return anthropicError(
      401,
      "authentication_error",
      `No free-pi token. Open the dashboard to log in: ${DASHBOARD_URL}`,
    );
  }

  let input: AnthropicRequest;
  try {
    input = await req.json() as AnthropicRequest;
  } catch {
    return anthropicError(400, "invalid_request_error", "Request body must be valid JSON.");
  }

  let translated: TranslatedRequest;
  try {
    translated = translateAnthropicRequest(ctx.upstream.catalog, input);
  } catch (e) {
    return anthropicError(400, "invalid_request_error", e instanceof Error ? e.message : String(e));
  }

  const source = new URL(req.url).searchParams.get("source") || "claude";

  // Same per-request turn + ad cycle as the OpenAI endpoint.
  const turnId = crypto.randomUUID();
  ctx.upstream.runAdCycle(jwt, ctx.state.sessionId, turnId, ctx.getGravityContext?.());

  let upstream: Response;
  try {
    upstream = await ctx.upstream.completions(jwt, JSON.stringify(translated.body), req.signal, {
      sessionId: ctx.state.sessionId,
      turnId,
      gravityContext: ctx.getGravityContext?.(),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await record(ctx, started, translated.model, source, 0, null, message);
    return anthropicError(502, "api_error", `Upstream connection failed: ${message}`);
  }

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => "");
    await record(ctx, started, translated.model, source, upstream.status, null, text.slice(0, 300));
    return anthropicError(
      upstream.status,
      errorTypeForStatus(upstream.status),
      upstreamErrorMessage(text, upstream.status),
    );
  }

  if (!translated.stream) {
    const text = await upstream.text();
    let json: Record<string, any>;
    try {
      json = JSON.parse(text) as Record<string, any>;
    } catch {
      await record(ctx, started, translated.model, source, upstream.status, null, "invalid upstream JSON");
      return anthropicError(502, "api_error", `Upstream returned invalid JSON: ${text.slice(0, 200)}`);
    }
    await record(ctx, started, translated.model, source, upstream.status, json.usage ?? null);
    return Response.json(toAnthropicResponse(json, translated.displayModel));
  }

  if (!upstream.body) {
    await record(ctx, started, translated.model, source, upstream.status, null, "empty upstream body");
    return anthropicError(502, "api_error", "Upstream returned an empty response body.");
  }

  const translator = new AnthropicStreamTranslator(translated.displayModel, translated.estimatedInputTokens);
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const convert = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const out = translator.push(decoder.decode(chunk, { stream: true }));
      if (out) controller.enqueue(encoder.encode(out));
    },
    flush(controller) {
      const out = translator.push(decoder.decode()) + translator.finish();
      if (out) controller.enqueue(encoder.encode(out));
    },
  });

  const [client, drain] = upstream.body.pipeThrough(convert).tee();
  void drain
    .pipeTo(new WritableStream({ write() { /* drain */ } }))
    .catch(() => { /* stream aborted */ })
    .finally(() => {
      void record(ctx, started, translated.model, source, upstream.status, translator.usage);
    });

  return new Response(client, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      "x-accel-buffering": "no",
    },
  });
}

export async function handleAnthropicCountTokens(req: Request): Promise<Response> {
  let input: AnthropicRequest;
  try {
    input = await req.json() as AnthropicRequest;
  } catch {
    return anthropicError(400, "invalid_request_error", "Request body must be valid JSON.");
  }
  return Response.json({ input_tokens: countInputTokens(input) });
}

export function handleApiHello(req: Request): Response {
  if (req.method === "HEAD") return new Response(null, { status: 200 });
  return Response.json({ ok: true, service: "freepi-proxy" });
}

export async function handleClaudeConfig(ctx: Ctx): Promise<Response> {
  // The wrapper may call this immediately after starting the proxy; wait for
  // the first catalog fetch so model ids and labels are real.
  if (!ctx.upstream.catalog) await ctx.upstream.refreshCatalog();
  const catalog = ctx.upstream.catalog;
  return Response.json({
    baseUrl: DASHBOARD_URL,
    models: pickClaudeModels(catalog),
    free: freeModelChoices(catalog),
    all: allModelChoices(catalog),
  });
}
