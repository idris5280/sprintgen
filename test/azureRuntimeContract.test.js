const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");

test("managed identity is the only Azure DevOps credential path", () => {
  const identity = read("src", "azureIdentity.js");
  const ado = read("src", "adoClient.js");

  assert.match(identity, /new DefaultAzureCredential\(\{\s*managedIdentityClientId:\s*process\.env\.AZURE_CLIENT_ID/);
  assert.match(identity, /499b84ac-1321-427f-aa17-267ca6975798\/\.default/);
  assert.match(ado, /Authorization:\s*`Bearer \$\{bearerToken\}`/);
  assert.match(ado, /response\.status === 401/);
  assert.match(ado, /status === 403/);
  assert.doesNotMatch(ado, /Authorization:\s*`Basic|Buffer\.from\([^)]*pat/i);
});

test("Docker image is immutable, non-root, and exposes a health check", () => {
  const dockerfile = read("Dockerfile");

  assert.match(dockerfile, /FROM node:22-bookworm-slim AS studio-build/);
  assert.match(dockerfile, /FROM mcr\.microsoft\.com\/playwright:v1\.60\.0-noble/);
  assert.match(dockerfile, /RUN npm ci --omit=dev --no-audit --no-fund/);
  assert.match(dockerfile, /USER scrumstudio/);
  assert.match(dockerfile, /EXPOSE 3000/);
  assert.match(dockerfile, /\/health\/live/);
  assert.doesNotMatch(dockerfile, /git clone|github\.com|curl\s|wget\s/i);
});

test("Azure handoff contract defines the externally managed runtime boundary", () => {
  const contract = read("AZURE_DEPLOYMENT.md");

  for (const value of [
    "acrscrumstudio.azurecr.io/scrum-studio",
    "ca-scrumstudio",
    "umi-scrumstudio",
    "NODE_ENV=production",
    "PORT=3000",
    "ADO_ORG=esiappdev",
    "ADO_PROJECT=Digital Transformation",
    "AZURE_STORAGE_ACCOUNT_URL=https://sascrumstudio.blob.core.windows.net",
    "AZURE_STORAGE_CONTAINER=scrum-studio",
    "/health/live",
    "/health/ready"
  ]) {
    assert.match(contract, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }

  assert.match(contract, /Cyber's infrastructure repository owns all Azure resources/);
  assert.match(contract, /contains no Terraform state, Terraform deployment configuration/);
  assert.match(contract, /must remain unchanged/);
});

test("application repository has no independent Terraform deployment", () => {
  const obsoletePaths = [
    ["infra", "main.tf"],
    ["infra", "variables.tf"],
    ["infra", "versions.tf"],
    ["infra", "Deploy-Azure.ps1"],
    ["infra", "Prepare-Azure.ps1"],
    ["infra", "Test-AzurePreflight.ps1"]
  ];

  for (const parts of obsoletePaths) {
    assert.equal(fs.existsSync(path.join(root, ...parts)), false, `${parts.join("/")} must not exist`);
  }
});
