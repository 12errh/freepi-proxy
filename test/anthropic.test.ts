import test from "node:test";
import assert from "node:assert/strict";
import {
  AnthropicStreamTranslator,
  countInputTokens,
  errorTypeForStatus,
  mapStopReason,
  toAnthropicResponse,
  translateAnthropicRequest,
} from "../src/anthropic.ts";
import type { Catalog } from "../src/upstream.ts";

const catalog: Catalog = {
  latest: "0.6.20",
  min: "0.6.19",
  defaultModel: "DeepSeek V4 Flash",
  fetchedAt: Date.now(),
  models: [
    { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash · Free Unlimited", display_name: "DeepSeek V4.1 Flash", free: true, multiplier: 1 },
    { id: "glm-5.3-flash", name: "GLM 5.3 Flash · Free Unlimited", display_name: "GLM 5.3 Flash", free: true, multiplier: 1 },
  ],
};

test("translates system, messages, tools, and sampling options", () => {
  const translated = translateAnthropicRequest(catalog, {
    model: "sonnet",
    max_tokens: 32000,
    temperature: 0.2,
    top_p: 0.9,
    stop_sequences: ["END"],
    system: [
      { type: "text", text: "You are Claude Code." },
      { type: "text", text: "Be concise.", cache_control: { type: "ephemeral" } },
    ],
    tools: [
      {
        name: "Read",
        description: "Read a file",
        input_schema: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          properties: { file_path: { type: "string" } },
          required: ["file_path"],
        },
        defer_loading: true,
      },
    ],
    tool_choice: { type: "tool", name: "Read", disable_parallel_tool_use: true },
    messages: [
      { role: "user", content: [{ type: "text", text: "Read package.json" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Reading it." },
          { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "package.json" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "{\"name\":\"freepi-proxy\"}" }] },
          { type: "text", text: "What is the name?" },
        ],
      },
      { role: "system", content: [{ type: "text", text: "Environment: linux" }] },
    ],
  });

  assert.equal(translated.model, "glm-5.3-flash");
  assert.equal(translated.stream, false);
  assert.equal(translated.body.max_tokens, 32000);
  assert.equal(translated.body.temperature, 0.2);
  assert.equal(translated.body.top_p, 0.9);
  assert.deepEqual(translated.body.stop, ["END"]);
  assert.deepEqual(translated.body.tool_choice, { type: "function", function: { name: "Read" } });
  assert.equal(translated.body.parallel_tool_calls, false);
  assert.equal((translated.body.tools as unknown[]).length, 1);
  assert.equal(JSON.stringify(translated.body.tools).includes("$schema"), false);
  assert.equal(JSON.stringify(translated.body.tools).includes("defer_loading"), false);

  const messages = translated.body.messages as Array<Record<string, unknown>>;
  assert.deepEqual(messages.map((m) => m.role), ["system", "user", "assistant", "tool", "user", "system"]);
  assert.equal(messages[0]!.content, "You are Claude Code.\n\nBe concise.");
  assert.deepEqual(messages[2]!.tool_calls, [{
    id: "toolu_1",
    type: "function",
    function: { name: "Read", arguments: "{\"file_path\":\"package.json\"}" },
  }]);
  assert.equal(messages[3]!.tool_call_id, "toolu_1");
  assert.equal(messages[4]!.content, "What is the name?");
  assert.equal(messages[5]!.content, "Environment: linux");
});

test("translates image input to an OpenAI data URL", () => {
  const translated = translateAnthropicRequest(catalog, {
    model: "default",
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "What is this?" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
      ],
    }],
  });
  const messages = translated.body.messages as Array<Record<string, unknown>>;
  assert.deepEqual(messages[0]!.content, [
    { type: "text", text: "What is this?" },
    { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
  ]);
});

test("requests usage on streams", () => {
  const translated = translateAnthropicRequest(catalog, {
    model: "default",
    stream: true,
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(translated.stream, true);
  assert.deepEqual(translated.body.stream_options, { include_usage: true });
});

test("converts a non-streaming completion with tool calls", () => {
  const response = toAnthropicResponse({
    id: "abc123",
    choices: [{
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: "I'll read that.",
        tool_calls: [{ id: "call_1", function: { name: "Read", arguments: "{\"file_path\":\"package.json\"}" } }],
      },
    }],
    usage: { prompt_tokens: 120, completion_tokens: 9 },
  }, "deepseek-v4.1-flash");

  assert.equal(response.type, "message");
  assert.equal(response.id, "msg_abc123");
  assert.equal(response.model, "deepseek-v4.1-flash");
  assert.equal(response.stop_reason, "tool_use");
  assert.deepEqual(response.content, [
    { type: "text", text: "I'll read that." },
    { type: "tool_use", id: "call_1", name: "Read", input: { file_path: "package.json" } },
  ]);
  assert.deepEqual(response.usage, { input_tokens: 120, output_tokens: 9 });
});

test("maps finish reasons", () => {
  assert.equal(mapStopReason("stop", false), "end_turn");
  assert.equal(mapStopReason("length", false), "max_tokens");
  assert.equal(mapStopReason("tool_calls", true), "tool_use");
  assert.equal(mapStopReason("length", true), "max_tokens");
});

test("streams text and buffered tool calls as Anthropic SSE", () => {
  const translator = new AnthropicStreamTranslator("deepseek-v4.1-flash", 42);
  const chunks = [
    "data: {\"id\":\"x\",\"choices\":[{\"delta\":{\"role\":\"assistant\",\"content\":\"\"},\"finish_reason\":null}]}\n\n",
    "data: {\"id\":\"x\",\"choices\":[{\"delta\":{\"content\":\"Hello\"},\"finish_reason\":null}]}\n\n",
    "data: {\"id\":\"x\",\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"function\":{\"name\":\"Read\",\"arguments\":\"{\\\"file_path\\\":\"}}]}}]}\n\n",
    "data: {\"id\":\"x\",\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"\\\"package.json\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\n",
    "data: {\"id\":\"x\",\"choices\":[],\"usage\":{\"prompt_tokens\":100,\"completion_tokens\":7}}\n\n",
    "data: [DONE]\n\n",
  ];
  let output = "";
  for (const chunk of chunks) output += translator.push(chunk);
  output += translator.finish();

  assert.match(output, /event: message_start/);
  assert.match(output, /"input_tokens":42/);
  assert.match(output, /event: content_block_delta[\s\S]*"type":"text_delta","text":"Hello"/);
  assert.match(output, /"type":"tool_use","id":"call_1","name":"Read","input":\{\}/);
  assert.match(output, /"partial_json":"\{\\"file_path\\":\\"package.json\\"\}"/);
  assert.match(output, /"stop_reason":"tool_use"/);
  assert.match(output, /"input_tokens":100,"output_tokens":7/);
  assert.match(output, /event: message_stop/);
  assert.equal((output.match(/event: content_block_stop/g) ?? []).length, 2);
  assert.deepEqual(translator.usage, { prompt_tokens: 100, completion_tokens: 7 });
});

test("estimates token counts for count_tokens", () => {
  const tokens = countInputTokens({
    system: "You are a helpful assistant.",
    messages: [{ role: "user", content: "Hello there" }],
    tools: [{ name: "Read", input_schema: { type: "object", properties: {} } }],
  });
  assert.ok(tokens > 0);
  assert.ok(Number.isInteger(tokens));
});

test("maps HTTP statuses to Anthropic error types", () => {
  assert.equal(errorTypeForStatus(400), "invalid_request_error");
  assert.equal(errorTypeForStatus(401), "authentication_error");
  assert.equal(errorTypeForStatus(429), "rate_limit_error");
  assert.equal(errorTypeForStatus(500), "api_error");
});
