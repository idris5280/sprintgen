const test = require("node:test");
const assert = require("node:assert/strict");
const { getUserFromRequest } = require("../src/userContext");

function request(headers = {}) {
  return { get(name) { return headers[name.toLowerCase()] || ""; } };
}

test("Easy Auth principal id is authoritative", () => {
  const user = getUserFromRequest(request({ "x-ms-client-principal-id": "immutable-id", "x-ms-client-principal-name": "Ada" }));
  assert.deepEqual(user, { id: "immutable-id", name: "Ada", source: "easy-auth" });
});

test("production fails closed without Easy Auth", () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try { assert.equal(getUserFromRequest(request()), null); } finally { process.env.NODE_ENV = previous; }
});
