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

test("Terraform excludes Cyber-managed authentication and preserves shared state", () => {
  const main = read("infra", "main.tf");
  const variables = read("infra", "variables.tf");

  assert.doesNotMatch(main, /resource\s+"azapi_resource"\s+"easy_auth"/);
  assert.doesNotMatch(main, /MICROSOFT_PROVIDER_AUTHENTICATION_SECRET|key_vault_secret_id/);
  assert.doesNotMatch(variables, /entra_client_id|entra_group_object_id|easy_auth_client_secret|key_vault_name/);
  assert.match(main, /prevent_destroy\s*=\s*true/);
  assert.match(main, /ignore_changes\s*=\s*\[[\s\S]*secret,[\s\S]*template\[0\]\.container\[0\]\.env/);
});

test("deployment script rejects authentication changes and verifies the boundary", () => {
  const deploy = read("infra", "Deploy-Azure.ps1");

  assert.match(deploy, /terraform state rm \$address/);
  assert.match(deploy, /azapi_resource\.easy_auth/);
  assert.match(deploy, /Assert-SafeTerraformPlan/);
  assert.match(deploy, /authConfigs\/current\?api-version=2025-07-01/);
  assert.match(deploy, /containerapp secret list/);
  assert.match(deploy, /authHash/);
  assert.match(deploy, /--set-env-vars/);
  assert.match(deploy, /-StrictRuntimeConfiguration/);
});

test("preflight checks Easy Auth group restriction, identity, RBAC, and runtime", () => {
  const preflight = read("infra", "Test-AzurePreflight.ps1");

  assert.match(preflight, /authConfigs\/current\?api-version=2025-07-01/);
  assert.match(preflight, /PSObject\.Properties\["properties"\]/);
  assert.match(preflight, /defaultAuthorizationPolicy[\s\S]*allowedPrincipals[\s\S]*groups/);
  assert.match(preflight, /Managed identity attached/);
  assert.match(preflight, /AcrPull/);
  assert.match(preflight, /Storage Blob Data Contributor/);
  for (const variable of [
    "NODE_ENV",
    "AZURE_CLIENT_ID",
    "ADO_ORG",
    "ADO_PROJECT",
    "AZURE_STORAGE_ACCOUNT_URL",
    "AZURE_STORAGE_CONTAINER",
    "APPLICATIONINSIGHTS_CONNECTION_STRING"
  ]) {
    assert.match(preflight, new RegExp(variable));
  }
  assert.match(preflight, /Azure DevOps administrator must confirm/);
});

test("Azure defaults target the confirmed Scrum Studio resources", () => {
  const variables = read("infra", "variables.tf");
  const example = read("infra", "terraform.tfvars.example");

  assert.match(variables, /variable "ado_org"[\s\S]*default\s*=\s*"esiappdev"/);
  assert.match(example, /ado_org\s*=\s*"esiappdev"/);
  assert.match(example, /storage_account_name\s*=\s*"scrumstudioblob"/);
  assert.match(example, /storage_container\s*=\s*"scrum-studio"/);
});
