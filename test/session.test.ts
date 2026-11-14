import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// config.ts resolves ~/.freepi-proxy when it is imported, so point HOME at a
// temp dir first: rotating a session in a test must not touch the real proxy.
process.env.HOME = await mkdtemp(join(tmpdir(), "freepi-proxy-test-"));
const { completeWithSessionRetry, isSessionTooLong } = await import("../src/state.ts");

type Ctx = Parameters<typeof completeWithSessionRetry>[0];

function fakeCtx(responses: Array<() => Response>): {
  ctx: Ctx;
  calls: Array<{ sessionId?: string; turnId?: string }>;
} {
  const calls: Array<{ sessionId?: string; turnId?: string }> = [];
  const ctx = {
    upstream: {
      completions: async (
        _jwt: string,
        _body: string,
        _signal: AbortSignal,
        opts?: { sessionId?: string; turnId?: string },
      ): Promise<Response> => {
        calls.push({ sessionId: opts?.sessionId, turnId: opts?.turnId });
        const next = responses.shift();
        if (!next) throw new Error("unexpected extra upstream call");
        return next();
      },
      runAdCycle: () => {},
    },
    tracker: { add: async () => {}, reconcile: () => {} },
    state: { sessionId: "session-old" },
  };
  return { ctx: ctx as unknown as Ctx, calls };
}

const ok = () => new Response('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n', {
  headers: { "content-type": "text/event-stream" },
});
const rejected = (status: number, body: string) => () =>
  new Response(body, { status, headers: { "content-type": "application/json" } });

test("recognizes an upstream spent-session rejection", () => {
  assert.equal(isSessionTooLong(400, JSON.stringify({ error: { message: "session is too long" } })), true);
  assert.equal(isSessionTooLong(429, JSON.stringify({ code: "session_too_long" })), true);
  assert.equal(isSessionTooLong(400, '{"error":{"message":"Session is too long: compact and retry."}}'), true);
  assert.equal(isSessionTooLong(413, '{"error":{"message":"Session limit reached"}}'), true);
  assert.equal(isSessionTooLong(400, '{"message":"session token budget exhausted"}'), true);
});

test("ignores errors that a fresh session would not fix", () => {
  assert.equal(isSessionTooLong(400, '{"code":"daily_cap"}'), false);
  assert.equal(isSessionTooLong(429, '{"code":"rolling_cap"}'), false);
  assert.equal(isSessionTooLong(409, '{"code":"concurrent_session"}'), false);
  assert.equal(
    isSessionTooLong(400, '{"error":{"message":"maximum context length is 1048576 tokens"}}'),
    false,
  );
  assert.equal(isSessionTooLong(200, "session is too long"), false);
});

test("replays the request once on a fresh session when the session is spent", async () => {
  const { ctx, calls } = fakeCtx([rejected(400, '{"error":{"message":"session is too long"}}'), ok]);
  const result = await completeWithSessionRetry(ctx, "jwt", '{"messages":[]}', new AbortController().signal);

  assert.equal(result.retried, true);
  assert.equal(result.upstream.ok, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.sessionId, "session-old");
  assert.equal(calls[1]!.sessionId, result.sessionId);
  assert.notEqual(result.sessionId, "session-old");
  assert.equal(ctx.state.sessionId, result.sessionId, "the rotated session is kept for later requests");
  assert.ok(calls[0]!.turnId && calls[1]!.turnId, "each attempt gets its own ad-cycle turn");
  assert.notEqual(calls[0]!.turnId, calls[1]!.turnId);
});

test("passes unrelated errors through without rotating the session", async () => {
  const { ctx, calls } = fakeCtx([rejected(429, '{"code":"daily_cap","message":"used up"}')]);
  const result = await completeWithSessionRetry(ctx, "jwt", "{}", new AbortController().signal);

  assert.equal(result.retried, false);
  assert.equal(result.upstream.status, 429);
  assert.equal(await result.upstream.text(), '{"code":"daily_cap","message":"used up"}');
  assert.equal(calls.length, 1);
  assert.equal(ctx.state.sessionId, "session-old");
});

test("does not retry a successful completion", async () => {
  const { ctx, calls } = fakeCtx([ok]);
  const result = await completeWithSessionRetry(ctx, "jwt", "{}", new AbortController().signal);

  assert.equal(result.retried, false);
  assert.equal(result.upstream.status, 200);
  assert.equal(calls.length, 1);
});
