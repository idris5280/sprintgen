const test = require("node:test");
const assert = require("node:assert/strict");
const { createConcurrencyGate, validateProductionConfig } = require("../src/runtimeSafety");

test("production configuration fails fast when cloud settings are missing", () => {
  assert.throws(
    () => validateProductionConfig({ NODE_ENV: "production" }),
    /AZURE_CLIENT_ID.*ADO_ORG.*ADO_PROJECT.*AZURE_STORAGE_ACCOUNT_URL.*AZURE_STORAGE_CONTAINER.*APPLICATIONINSIGHTS_CONNECTION_STRING/
  );
  assert.doesNotThrow(() => validateProductionConfig({ NODE_ENV: "development" }));
});

test("PDF concurrency gate runs only one operation at a time", async () => {
  const gate = createConcurrencyGate({ limit: 1, maxQueue: 2 });
  const order = [];
  let releaseFirst;
  const firstWait = new Promise((resolve) => { releaseFirst = resolve; });
  const first = gate.run(async () => {
    order.push("first-start");
    await firstWait;
    order.push("first-end");
  });
  const second = gate.run(async () => {
    order.push("second-start");
    order.push("second-end");
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["first-start"]);
  assert.deepEqual(gate.stats(), { active: 1, queued: 1 });
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first-start", "first-end", "second-start", "second-end"]);
});
