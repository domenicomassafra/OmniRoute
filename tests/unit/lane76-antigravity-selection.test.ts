import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-lane76-selection-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "lane76-selection-secret";

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const settingsDb = await import("../../src/lib/db/settings.ts");
const auth = await import("../../src/sse/services/auth.ts");
const quotaCache = await import("../../src/domain/quotaCache.ts");
const oauthOccupancy = await import("../../open-sse/services/oauthSessionOccupancy.ts");

async function seedAntigravityConnection(index: number) {
  return providersDb.createProviderConnection({
    provider: "antigravity",
    authType: "oauth",
    name: `lane76-antigravity-${String(index).padStart(2, "0")}`,
    apiKey: `lane76-key-${index}`,
    accessToken: `lane76-access-${index}`,
    refreshToken: `lane76-refresh-${index}`,
    isActive: true,
    testStatus: "active",
    priority: 1,
    providerSpecificData: {},
  });
}

async function resetStorage() {
  quotaCache.__clearForTests();
  oauthOccupancy._clearOAuthSessionOccupancyForTest();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.beforeEach(resetStorage);

test.after(() => {
  quotaCache.__clearForTests();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("empty allowedConnections is unrestricted for synthetic and real credential selection", async () => {
  const synthetic = await auth.getProviderCredentials("opencode", null, [], "big-pickle");
  assert.equal(synthetic?.connectionId, "noauth");

  const real = await seedAntigravityConnection(0);
  quotaCache.setQuotaCache(real.id, "antigravity", {
    "gemini-3.8-flash-tiered": { remainingPercentage: 100, resetAt: null },
  });

  const selected = await auth.getProviderCredentials(
    "antigravity",
    null,
    [],
    "gemini-3.8-flash"
  );
  assert.equal(selected?.connectionId, real.id);
});

test("33-account tiered selection skips exact exhausted accounts and same-session concurrency spills over with affinity disabled", async () => {
  await settingsDb.updateSettings({
    fallbackStrategy: "round-robin",
    stickyRoundRobinLimit: 1,
    sessionAffinityTtlMs: 0,
  });

  const connections = [];
  for (let index = 0; index < 33; index += 1) {
    const connection = await seedAntigravityConnection(index);
    connections.push(connection);
    quotaCache.setQuotaCache(connection.id, "antigravity", {
      "gemini-3.8-flash-tiered": {
        remainingPercentage: index < 31 ? 0 : 100,
        resetAt: null,
      },
      "gemini-pro-agent": { remainingPercentage: 100, resetAt: null },
    });
  }

  // Model a positive but stale observation without touching production storage.
  // Stale positive data is fail-open policy evidence, not a permanent availability proof.
  const staleEntry = quotaCache.getQuotaCache(connections[31].id) as any;
  staleEntry.fetchedAt = Date.now() - 10 * 60_000;
  assert.ok(quotaCache.getQuotaCacheStats().entries.some((entry) => entry.ageMs > 5 * 60_000));

  const eligibleIds = new Set([connections[31].id, connections[32].id]);
  const [first, second] = await Promise.all([
    auth.getProviderCredentials("antigravity", null, [], "gemini-3.8-flash", {
      sessionKey: "lane76-same-session",
      reserveOAuthSession: true,
    }),
    auth.getProviderCredentials("antigravity", null, [], "gemini-3.8-flash", {
      sessionKey: "lane76-same-session",
      reserveOAuthSession: true,
    }),
  ]);

  assert.ok(first?.connectionId && eligibleIds.has(first.connectionId));
  assert.ok(second?.connectionId && eligibleIds.has(second.connectionId));
  assert.notEqual(
    first?.connectionId,
    second?.connectionId,
    "round-robin sticky=1 with affinity disabled must spill concurrent same-session requests across eligible siblings"
  );

  first?.releaseOAuthSession?.();
  second?.releaseOAuthSession?.();

  // One available sibling remains selectable even when every other exact bucket is exhausted.
  quotaCache.setQuotaCache(connections[31].id, "antigravity", {
    "gemini-3.8-flash-tiered": { remainingPercentage: 0, resetAt: null },
    "gemini-pro-agent": { remainingPercentage: 100, resetAt: null },
  });
  const onlySibling = await auth.getProviderCredentials(
    "antigravity",
    null,
    [],
    "gemini-3.8-flash",
    { sessionKey: "lane76-one-sibling" }
  );
  assert.equal(onlySibling?.connectionId, connections[32].id);

  // Once the final exact bucket is exhausted too, selection stops before dispatch.
  quotaCache.setQuotaCache(connections[32].id, "antigravity", {
    "gemini-3.8-flash-tiered": { remainingPercentage: 0, resetAt: null },
    "gemini-pro-agent": { remainingPercentage: 100, resetAt: null },
  });
  const exhausted = await auth.getProviderCredentials(
    "antigravity",
    null,
    [],
    "gemini-3.8-flash",
    { sessionKey: "lane76-all-exhausted" }
  );
  assert.equal(exhausted?.allRateLimited, true);
  assert.equal(exhausted?.lastErrorCode, 429);
});
