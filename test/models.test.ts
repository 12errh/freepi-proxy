import test from "node:test";
import assert from "node:assert/strict";
import {
  freeModels,
  isFreeModel,
  pickClaudeModels,
  resolveModel,
} from "../src/models.ts";
import type { Catalog, CatalogModel } from "../src/upstream.ts";

function model(id: string, name: string, extra: Partial<CatalogModel> = {}): CatalogModel {
  return { id, name, multiplier: 1, ...extra };
}

const catalog: Catalog = {
  latest: "0.6.20",
  min: "0.6.19",
  defaultModel: "DeepSeek V4 Flash",
  fetchedAt: Date.now(),
  models: [
    model("particle", "Particle · 🔥 Free Unlimited: limited time", { free: true, display_name: "Particle" }),
    model("deepseek-v4.1-flash", "DeepSeek V4.1 Flash · 🔥 Free Unlimited: limited time", { free: true, display_name: "DeepSeek V4.1 Flash" }),
    model("glm-5.3-flash", "GLM 5.3 Flash · 🔥 Free Unlimited: limited time", { free: true, display_name: "GLM 5.3 Flash" }),
    model("deepseek-v4-flash", "DeepSeek V4 Flash · 🔥 Free Unlimited: limited time", { free: true, display_name: "DeepSeek V4 Flash" }),
    model("solar-pro-4", "Solar Pro 4 · ~0.6x usage", { usage_x: "0.6", multiplier: 0.6 }),
    model("dead-model", "Dead Model · unavailable", { unavailable: true, free: true }),
  ],
};

test("detects free models by catalog flag and by name", () => {
  assert.equal(isFreeModel(catalog.models[0]!), true);
  assert.equal(isFreeModel(catalog.models[4]!), false);
  assert.equal(isFreeModel(model("x", "X · Free Unlimited")), true);
  assert.deepEqual(freeModels(catalog).map((m) => m.id), [
    "particle",
    "deepseek-v4.1-flash",
    "glm-5.3-flash",
    "deepseek-v4-flash",
  ]);
});

test("maps the free lineup onto Claude Code slots", () => {
  const map = pickClaudeModels(catalog);
  assert.equal(map.default.id, "deepseek-v4.1-flash");
  assert.equal(map.opus.id, "deepseek-v4.1-flash");
  assert.equal(map.fable.id, "particle");
  assert.equal(map.sonnet.id, "glm-5.3-flash");
  assert.equal(map.haiku.id, "deepseek-v4-flash");
  assert.equal(map.default.free, true);
  assert.match(map.default.description, /free unlimited/);
});

test("falls back to catalog order when preferred free models disappear", () => {
  const changed: Catalog = {
    ...catalog,
    models: [
      model("new-a", "New A · Free Unlimited", { free: true }),
      model("new-b", "New B · Free Unlimited", { free: true }),
    ],
  };
  const map = pickClaudeModels(changed);
  assert.equal(map.default.id, "new-a");
  assert.equal(map.fable.id, "new-b");
  assert.equal(map.sonnet.id, "new-a");
});

test("uses built-in defaults when the catalog is unavailable", () => {
  const map = pickClaudeModels(null);
  assert.equal(map.default.id, "deepseek-v4.1-flash");
  assert.equal(map.fable.id, "particle");
  assert.equal(map.sonnet.id, "glm-5.3-flash");
  assert.equal(map.haiku.id, "deepseek-v4-flash");
});

test("resolves aliases, free-pi ids, and Claude family names", () => {
  assert.equal(resolveModel(catalog, "default"), "deepseek-v4.1-flash");
  assert.equal(resolveModel(catalog, "free"), "deepseek-v4.1-flash");
  assert.equal(resolveModel(catalog, "fable"), "particle");
  assert.equal(resolveModel(catalog, "opus"), "deepseek-v4.1-flash");
  assert.equal(resolveModel(catalog, "sonnet"), "glm-5.3-flash");
  assert.equal(resolveModel(catalog, "haiku"), "deepseek-v4-flash");
  assert.equal(resolveModel(catalog, "freepi/glm-5.3-flash"), "glm-5.3-flash");
  assert.equal(resolveModel(catalog, "solar-pro-4"), "solar-pro-4");
  assert.equal(resolveModel(catalog, "claude-sonnet-5-5"), "glm-5.3-flash");
  assert.equal(resolveModel(catalog, "claude-opus-5-5"), "deepseek-v4.1-flash");
  assert.equal(resolveModel(catalog, "claude-haiku-5-5"), "deepseek-v4-flash");
  assert.equal(resolveModel(catalog, "something-unknown"), "deepseek-v4.1-flash");
});
