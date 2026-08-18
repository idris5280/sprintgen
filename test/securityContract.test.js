const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("removed credential workflows are not registered", () => {
  const root = path.join(__dirname, "..");
  const routeSource = fs.readFileSync(path.join(root, "src", "cloudRoutes.js"), "utf8");
  const adoSource = fs.readFileSync(path.join(root, "src", "adoClient.js"), "utf8");
  assert.doesNotMatch(routeSource, /ado-admin\/(?:connect|disconnect)|ado-test|type=["']password/i);
  assert.doesNotMatch(adoSource, /Basic\s|Buffer\.from\([^)]*:/i);
  assert.match(adoSource, /Bearer/);
});

test("production API writes require a same-origin browser request", () => {
  const root = path.join(__dirname, "..");
  const userContext = fs.readFileSync(path.join(root, "src", "userContext.js"), "utf8");
  const routeSource = fs.readFileSync(path.join(root, "src", "cloudRoutes.js"), "utf8");
  assert.match(userContext, /function requireSameOrigin/);
  assert.match(routeSource, /app\.use\("\/api", deps\.requireApiUser, deps\.requireSameOrigin/);
});

test("Fluent application is excluded from artifact renderer source", () => {
  const root = path.join(__dirname, "..");
  const artifactSource = fs.readFileSync(path.join(root, "src", "artifactEngine.js"), "utf8");
  assert.doesNotMatch(artifactSource, /@fluentui|griffel|react-dom|FluentProvider/);
});
