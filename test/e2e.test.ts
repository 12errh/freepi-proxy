// End-to-end checks against a running proxy. These consume free-pi credits,
// so they only run when FREEPI_E2E=1 (npm run test:e2e).

import test from "node:test";
import assert from "node:assert/strict";

const enabled = process.env.FREEPI_E2E === "1";
const BASE = (process.env.FREEPI_PROXY_URL
  || `http://127.0.0.1:${process.env.FREEPI_PROXY_PORT || 8452}`).replace(/\/+$/, "");

test("POST /v1/messages returns an Anthropic message", { skip: !enabled }, async () => {
  const res = await fetch(`${BASE}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "deepseek-v4.1-flash",
      max_tokens: 64,
      messages: [{ role: "user", content: "Reply with exactly: FREEPI_OK" }],
    }),
  });
  assert.equal(res.status, 200);
  const body = await res.json() as {
    type: string;
    role: string;
    content: Array<{ type: string; text?: string }>;
    usage: { input_tokens: number; output_tokens: number };
  };
  assert.equal(body.type, "message");
  assert.equal(body.role, "assistant");
  const text = body.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
  assert.match(text, /FREEPI_OK/i);
  assert.ok(body.usage.output_tokens > 0);
});

test("POST /v1/messages streams Anthropic SSE events", { skip: !enabled }, async () => {
  const res = await fetch(`${BASE}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "deepseek-v4-flash",
      max_tokens: 32,
      stream: true,
      messages: [{ role: "user", content: "Say OK." }],
    }),
  });
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /event: message_start/);
  assert.match(text, /event: content_block_delta/);
  assert.match(text, /event: message_stop/);
});

test("POST /v1/messages/count_tokens estimates input tokens", { skip: !enabled }, async () => {
  const res = await fetch(`${BASE}/v1/messages/count_tokens`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "deepseek-v4.1-flash",
      system: "You are a helpful assistant.",
      messages: [{ role: "user", content: "Hello" }],
    }),
  });
  assert.equal(res.status, 200);
  const body = await res.json() as { input_tokens: number };
  assert.ok(body.input_tokens > 0);
});
