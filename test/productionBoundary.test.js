const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");

test("production image uses an explicit application allowlist", () => {
  const dockerfile = fs.readFileSync(path.join(root, "Dockerfile"), "utf8");
  const dockerignore = fs.readFileSync(path.join(root, ".dockerignore"), "utf8");

  assert.doesNotMatch(dockerfile, /^COPY\s+\.\s+\./m);
  assert.match(dockerfile, /^COPY src \.\/src$/m);
  assert.match(dockerfile, /^COPY public \.\/public$/m);
  assert.match(dockerfile, /^COPY templates \.\/templates$/m);
  assert.match(dockerfile, /^USER scrumstudio$/m);

  for (const entry of [".env", "*.tfstate", "*.tfvars", "input", "reference", "runtime", "infra", "test"]) {
    assert.match(dockerignore, new RegExp(`^${entry.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
  }
});

test("hosted artifacts do not depend on external Google Fonts", () => {
  const files = [
    "src/server.js",
    "public/ado-present.css",
    "public/present.css",
    "templates/sprint-demo.hbs",
    "templates/sprint-demo-present.hbs"
  ];

  for (const file of files) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    assert.doesNotMatch(source, /fonts\.googleapis\.com|fonts\.gstatic\.com/i, file);
  }
});
