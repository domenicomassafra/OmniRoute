import test from "node:test";
import assert from "node:assert/strict";

import { createChatPipelineHarness } from "../integration/_chatPipelineHarness.ts";

const harness = await createChatPipelineHarness("lane76-allowed-connections");
const {
  buildOpenAIResponse,
  buildRequest,
  combosDb,
  handleChat,
  resetStorage,
  seedApiKey,
  seedConnection,
} = harness;

test.beforeEach(resetStorage);
test.afterEach(resetStorage);
test.after(harness.cleanup);

async function seedCombo() {
  const connection = await seedConnection("openai", { apiKey: "sk-lane76-openai" });
  await combosDb.createCombo({
    name: "lane76-allowlist-combo",
    strategy: "priority",
    config: { maxRetries: 0, retryDelayMs: 0 },
    models: ["openai/o3-mini"],
  });
  return connection;
}

test("handleChat checkModelAvailable treats persisted allowedConnections=[] as unrestricted", async () => {
  await seedCombo();
  const key = await seedApiKey({ allowedConnections: [] });
  let dispatches = 0;
  globalThis.fetch = async () => {
    dispatches += 1;
    return buildOpenAIResponse("lane76-ok", "o3-mini");
  };

  const response = await handleChat(
    buildRequest({
      authKey: key.key,
      body: {
        model: "lane76-allowlist-combo",
        stream: false,
        messages: [{ role: "user", content: "fixture" }],
      },
    })
  );

  assert.equal(response.status, 200);
  assert.equal(dispatches, 1);
});

test("handleChat returns ALL_TARGETS_SKIPPED with zero attempts only for an explicit allowlist exclusion", async () => {
  const connection = await seedCombo();
  const key = await seedApiKey({
    allowedConnections: ["00000000-0000-4000-8000-000000000076"],
  });
  let dispatches = 0;
  globalThis.fetch = async () => {
    dispatches += 1;
    return buildOpenAIResponse("must-not-dispatch", "o3-mini");
  };

  assert.notEqual(connection.id, "00000000-0000-4000-8000-000000000076");
  const response = await handleChat(
    buildRequest({
      authKey: key.key,
      body: {
        model: "lane76-allowlist-combo",
        stream: false,
        messages: [{ role: "user", content: "fixture" }],
      },
    })
  );
  const payload = (await response.json()) as any;

  assert.equal(response.status, 503);
  assert.equal(payload.error?.code, "ALL_TARGETS_SKIPPED");
  assert.equal(payload.diagnostics?.attempted, 0);
  assert.equal(response.headers.get("x-omniroute-combo-attempted"), "0");
  assert.equal(dispatches, 0);
});
