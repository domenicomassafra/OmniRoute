import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-lane76-quota-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const coreDb = await import("../../src/lib/db/core.ts");
const quotaCache = await import("../../src/domain/quotaCache.ts");
const auth = await import("../../src/sse/services/auth.ts");

test.beforeEach(() => quotaCache.__clearForTests());

test.after(() => {
  quotaCache.__clearForTests();
  coreDb.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("public Gemini Flash alias scopes exhaustion to its technical tiered quota window", () => {
  const connectionId = "lane76-public-technical";
  quotaCache.setQuotaCache(connectionId, "antigravity", {
    "gemini-3.8-flash-tiered": { remainingPercentage: 0, resetAt: null },
    "gemini-pro-agent": { remainingPercentage: 100, resetAt: null },
  });

  assert.equal(
    quotaCache.isQuotaExhaustedForRequest(
      connectionId,
      "antigravity",
      "antigravity/gemini-3.8-flash"
    ),
    true
  );
});

test("exact Gemini Flash reset timestamp reopens the technical quota bucket", () => {
  const connectionId = "lane76-reset";
  quotaCache.setQuotaCache(connectionId, "antigravity", {
    "gemini-3.8-flash-tiered": {
      remainingPercentage: 0,
      resetAt: new Date(Date.now() - 1_000).toISOString(),
    },
    "gemini-pro-agent": { remainingPercentage: 100, resetAt: null },
  });

  assert.equal(
    quotaCache.isQuotaExhaustedForRequest(
      connectionId,
      "antigravity",
      "antigravity/gemini-3.8-flash"
    ),
    false,
    "a passed exact-model reset must unblock selection immediately"
  );
});

test("stale positive exact-model snapshot remains fail-open but is not confused with sibling quota", () => {
  const connectionId = "lane76-stale-positive";
  quotaCache.setQuotaCache(connectionId, "antigravity", {
    "gemini-3.8-flash-tiered": { remainingPercentage: 100, resetAt: null },
    "gemini-pro-agent": { remainingPercentage: 0, resetAt: null },
  });
  const entry = quotaCache.getQuotaCache(connectionId) as any;
  entry.fetchedAt = Date.now() - 10 * 60_000;

  assert.equal(
    quotaCache.isQuotaExhaustedForRequest(
      connectionId,
      "antigravity",
      "antigravity/gemini-3.8-flash"
    ),
    false
  );
  assert.ok(quotaCache.getQuotaCacheStats().entries[0].ageMs > 5 * 60_000);
});

test("evaluateQuotaLimitPolicy honors the 99% boundary and a passed reset", () => {
  const connectionId = "lane76-policy-boundary";
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
  const futureReset = new Date(Date.now() + 60_000).toISOString();

  quotaCache.setQuotaCache(connectionId, "antigravity", {
    "gemini-3.8-flash-tiered": { remainingPercentage: 1, resetAt: futureReset },
  });
  const atBoundary = auth.evaluateQuotaLimitPolicy(
    "antigravity",
    connection,
    "gemini-3.8-flash"
  );
  assert.equal(atBoundary.blocked, true);
  assert.equal(atBoundary.resetAt, futureReset);

  quotaCache.setQuotaCache(connectionId, "antigravity", {
    "gemini-3.8-flash-tiered": { remainingPercentage: 1.01, resetAt: futureReset },
  });
  assert.equal(
    auth.evaluateQuotaLimitPolicy("antigravity", connection, "gemini-3.8-flash").blocked,
    false,
    "98.99% used is below a 99% threshold"
  );

  quotaCache.setQuotaCache(connectionId, "antigravity", {
    "gemini-3.8-flash-tiered": {
      remainingPercentage: 0,
      resetAt: new Date(Date.now() - 1_000).toISOString(),
    },
  });
  assert.equal(
    auth.evaluateQuotaLimitPolicy("antigravity", connection, "gemini-3.8-flash").blocked,
    false,
    "a passed reset timestamp must not keep policy blocked"
  );
});
