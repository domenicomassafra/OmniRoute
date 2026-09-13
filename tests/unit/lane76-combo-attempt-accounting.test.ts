import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-lane76-combo-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const { handleComboChat } = await import("../../open-sse/services/combo.ts");
const core = await import("../../src/lib/db/core.ts");

function createLog() {
  return { info() {}, warn() {}, error() {}, debug() {} } as any;
}

function errorResponse(status: number, message: string) {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("ALL_TARGETS_SKIPPED reports zero recorded attempts when every target is explicitly pre-screened", async () => {
  let dispatches = 0;
  const response = await handleComboChat({
    body: {},
    combo: {
      name: "lane76-all-prescreened",
      strategy: "priority",
      models: ["openai/model-a", "openai/model-b"],
      config: { maxRetries: 0 },
    },
    handleSingleModel: async () => {
      dispatches += 1;
      return errorResponse(500, "must not dispatch");
    },
    isModelAvailable: async () => false,
    log: createLog(),
    settings: null,
    relayOptions: null as any,
    allCombos: null,
  });
  const payload = (await response.json()) as any;

  assert.equal(response.status, 503);
  assert.equal(payload.error?.code, "ALL_TARGETS_SKIPPED");
  assert.equal(payload.diagnostics?.attempted, 0);
  assert.equal(response.headers.get("x-omniroute-combo-attempted"), "0");
  assert.equal(dispatches, 0);
});

test("recordedAttempts increments only after the one target that reaches dispatch", async () => {
  let dispatches = 0;
  const response = await handleComboChat({
    body: {},
    combo: {
      name: "lane76-one-dispatch",
      strategy: "priority",
      models: ["openai/model-a", "openai/model-b"],
      config: { maxRetries: 0 },
    },
    handleSingleModel: async (_body: unknown, model: string) => {
      dispatches += 1;
      assert.equal(model, "openai/model-b");
      return errorResponse(500, "real dispatched failure");
    },
    isModelAvailable: async (model: string) => model === "openai/model-b",
    log: createLog(),
    settings: null,
    relayOptions: null as any,
    allCombos: null,
  });
  const payload = (await response.json()) as any;

  assert.equal(dispatches, 1);
  assert.notEqual(payload.error?.code, "ALL_TARGETS_SKIPPED");
  assert.equal(payload.diagnostics?.attempted, 1);
  assert.equal(response.headers.get("x-omniroute-combo-attempted"), "1");
});
