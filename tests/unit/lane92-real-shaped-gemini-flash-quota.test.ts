import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-lane92-real-quota-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const { handleComboChat } = await import("../../open-sse/services/combo.ts");
const core = await import("../../src/lib/db/core.ts");
const quotaCache = await import("../../src/domain/quotaCache.ts");
const auth = await import("../../src/sse/services/auth.ts");

function createLog() {
  return { info() {}, warn() {}, error() {}, debug() {} } as any;
}

function dispatchedFailure() {
  return new Response(JSON.stringify({ error: { message: "fixture dispatch reached" } }), {
    status: 500,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Mirrors the two upstream Antigravity quota payload shapes that feed the
 * runtime cache: fetchAvailableModels carries per-model quotaInfo while the
 * weekly quota endpoint contributes the family aggregate. The public picker
 * calls this model "Gemini 3 Flash" even though quota telemetry uses the
 * technical gemini-3.8-flash-tiered key.
 */
function realShapedGemini3FlashSnapshot() {
  const resetTime = new Date(Date.now() + 60 * 60_000).toISOString();
  return {
    fetchAvailableModels: {
      models: {
        "gemini-3.8-flash-tiered": {
          displayName: "Gemini 3 Flash",
          quotaInfo: { remainingFraction: 1, resetTime },
        },
      },
    },
    weeklyQuota: {
      bucketId: "gemini_weekly",
      displayName: "Gemini weekly",
      remainingFraction: 0,
      resetTime,
    },
  } as const;
}

function cacheQuotasFromRealShape(snapshot: ReturnType<typeof realShapedGemini3FlashSnapshot>) {
  const modelQuota = snapshot.fetchAvailableModels.models["gemini-3.8-flash-tiered"].quotaInfo;
  const weekly = snapshot.weeklyQuota;
  return {
    "gemini-3.8-flash-tiered": {
      remainingPercentage: modelQuota.remainingFraction * 100,
      resetAt: modelQuota.resetTime,
    },
    gemini_weekly: {
      remainingPercentage: weekly.remainingFraction * 100,
      resetAt: weekly.resetTime,
    },
  };
}

test.beforeEach(() => quotaCache.__clearForTests());
test.after(() => {
  quotaCache.__clearForTests();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("real-shaped Gemini 3 Flash snapshot admits eligible tiered target despite exhausted family aggregate", async () => {
  const connectionId = "lane92-real-shaped-gemini-flash";
  const requestedModel = "antigravity/gemini-3.8-flash";
  const snapshot = realShapedGemini3FlashSnapshot();
  quotaCache.setQuotaCache(connectionId, "antigravity", cacheQuotasFromRealShape(snapshot));

  const connection = {
    id: connectionId,
    providerSpecificData: {
      limitPolicy: {
        enabled: true,
        thresholdPercent: 99,
        windows: ["gemini-3.8-flash-tiered"],
      },
    },
  } as any;

  const policy = auth.evaluateQuotaLimitPolicy("antigravity", connection, requestedModel);
  const exhausted = quotaCache.isQuotaExhaustedForRequest(
    connectionId,
    "antigravity",
    requestedModel
  );

  let dispatches = 0;
  const response = await handleComboChat({
    body: {},
    combo: {
      name: "lane92-real-shaped-quota",
      strategy: "priority",
      models: [requestedModel],
      config: { maxRetries: 0 },
    },
    handleSingleModel: async () => {
      dispatches += 1;
      return dispatchedFailure();
    },
    isModelAvailable: async () =>
      !auth.evaluateQuotaLimitPolicy("antigravity", connection, requestedModel).blocked &&
      !quotaCache.isQuotaExhaustedForRequest(connectionId, "antigravity", requestedModel),
    log: createLog(),
    settings: null,
    relayOptions: null as any,
    allCombos: null,
  });
  const payload = (await response.json()) as any;

  assert.equal(
    payload.diagnostics?.attempted,
    1,
    JSON.stringify({
      code: payload.error?.code ?? null,
      attempted: payload.diagnostics?.attempted,
      dispatches,
      exhausted,
      policyBlocked: policy.blocked,
    })
  );
  assert.equal(policy.blocked, false, "eligible technical bucket must be below the 99% policy threshold");
  assert.equal(
    exhausted,
    false,
    "exhausted Gemini aggregate must not hide an eligible exact technical tiered bucket"
  );
  assert.equal(dispatches, 1, "eligible target must reach dispatch exactly once");
  assert.equal(response.headers.get("x-omniroute-combo-attempted"), "1");
  assert.notEqual(payload.error?.code, "ALL_TARGETS_SKIPPED");
});
