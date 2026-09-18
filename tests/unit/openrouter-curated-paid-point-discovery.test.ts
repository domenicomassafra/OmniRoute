import assert from "node:assert/strict";
import test from "node:test";

const {
  buildOpenRouterPointModelUrl,
  enrichOpenRouterCatalogWithCuratedPaidPointModels,
  OPENROUTER_CURATED_PAID_POINT_MODEL_IDS,
} = await import("../../src/lib/catalog/openrouterCuratedPaidModels.ts");

test("curated OpenRouter paid point discovery adds Jev when bulk /models omits it", async () => {
  const calls: string[] = [];
  const result = await enrichOpenRouterCatalogWithCuratedPaidPointModels(
    [{ id: "openai/gpt-4.1", name: "GPT-4.1" }],
    async (url, modelId) => {
      calls.push(url);
      return {
        data: {
          id: modelId,
          name: "TypeSafe: Jev Latest",
          context_length: 32000,
          pricing: { prompt: "0.000000042", completion: "0" },
        },
      };
    }
  );

  assert.deepEqual(OPENROUTER_CURATED_PAID_POINT_MODEL_IDS, ["~typesafe/jev-latest"]);
  assert.deepEqual(calls, ["https://openrouter.ai/api/v1/model/~typesafe/jev-latest"]);
  assert.equal(result.at(-1)?.id, "~typesafe/jev-latest");
  assert.equal(result.at(-1)?.context_length, 32000);
});

test("curated point discovery skips the network when bulk already contains Jev", async () => {
  let calls = 0;
  const models = [{ id: "~typesafe/jev-latest", name: "Already present" }];
  const result = await enrichOpenRouterCatalogWithCuratedPaidPointModels(models, async () => {
    calls++;
    throw new Error("must not fetch");
  });

  assert.equal(calls, 0);
  assert.deepEqual(result, models);
});

test("curated point discovery preserves the healthy bulk catalog when point lookup fails", async () => {
  const bulk = [{ id: "openai/gpt-4.1", name: "GPT-4.1" }];
  const result = await enrichOpenRouterCatalogWithCuratedPaidPointModels(bulk, async () => {
    throw new Error("point endpoint unavailable");
  });

  assert.deepEqual(result, bulk);
});

test("OpenRouter point URL builder rejects malformed ids", () => {
  assert.throws(() => buildOpenRouterPointModelUrl("jev-latest"), /Invalid OpenRouter/);
});
