import test from "node:test";
import assert from "node:assert/strict";
import { handleModels } from "../src/proxy.ts";
import { Upstream } from "../src/upstream.ts";
import type { Catalog } from "../src/upstream.ts";
import type { Ctx } from "../src/state.ts";

function ctx(catalog: Catalog): Ctx {
  const upstream = new Upstream();
  upstream.catalog = catalog;
  return { upstream } as Ctx;
}

const catalog: Catalog = {
  latest: "0.6.20",
  min: "0.6.19",
  defaultModel: "unlimited-a",
  fetchedAt: Date.now(),
  models: [
    { id: "unlimited-a", name: "Unlimited A · Free Unlimited", free: true, multiplier: 1 },
    { id: "unlimited-b", name: "Unlimited B · promotion", free: false, multiplier: 1 },
    { id: "paid-a", name: "Paid A · ~1x usage", multiplier: 1 },
    { id: "offline", name: "Offline · Free Unlimited", free: true, unavailable: true, multiplier: 1 },
  ],
};

test("OpenAI model discovery exposes only available unlimited models", async () => {
  const response = handleModels(ctx(catalog));
  const body = await response.json() as { data: Array<{ id: string }> };

  assert.deepEqual(body.data.map((model) => model.id), ["unlimited-a"]);
});

test("OpenAI model discovery is empty before the live catalog is ready", async () => {
  const upstream = new Upstream();
  const response = handleModels({ upstream } as Ctx);
  const body = await response.json() as { data: unknown[] };

  assert.deepEqual(body.data, []);
});
