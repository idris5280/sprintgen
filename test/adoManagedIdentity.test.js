const test = require("node:test");
const assert = require("node:assert/strict");
const { listProjectTeams, setAdoAuthProvider } = require("../src/adoClient");

test("Azure DevOps requests use Bearer auth and renew once after a 401", async (t) => {
  const originalFetch = global.fetch;
  const authCalls = [];
  const requestHeaders = [];
  let requestCount = 0;

  t.after(() => {
    global.fetch = originalFetch;
    setAdoAuthProvider(null);
  });

  setAdoAuthProvider(async ({ forceRefresh }) => {
    authCalls.push(forceRefresh);
    return { bearerToken: forceRefresh ? "renewed-token" : "initial-token" };
  });
  global.fetch = async (url, init) => {
    requestCount += 1;
    requestHeaders.push(init.headers.Authorization);
    if (requestCount === 1) {
      return {
        ok: false,
        status: 401,
        headers: { get: () => "application/json" },
        json: async () => ({ message: "expired" })
      };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      json: async () => ({ value: [{ id: "team-id", name: "Platform" }] })
    };
  };

  const result = await listProjectTeams({ org: "example", project: "Delivery" });

  assert.equal(result.count, 1);
  assert.deepEqual(authCalls, [false, true]);
  assert.deepEqual(requestHeaders, ["Bearer initial-token", "Bearer renewed-token"]);
});
