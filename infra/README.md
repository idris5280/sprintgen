# Azure pilot deployment

This deployment updates the application runtime in the existing Scrum Studio resources. Container Apps Easy Auth, its Entra application, authorization group, credential, and existing Container App secrets are externally provisioned and owned by Cyber.

## Existing resources

- Resource group: `rg-scrumstudio`
- Registry: `acrscrumstudio`
- Container App: `ca-scrumstudio`
- Container Apps Environment: `cae-scrumstudio`
- Managed identity: `umi-scrumstudio`
- Storage account: `scrumstudioblob`
- Private review container: `scrum-studio`
- Terraform state container: `scrum-studio-tfstate`
- Azure DevOps organization: `esiappdev`

The East US storage account is accepted for the pilot while the application remains in South Central US.

## Ownership boundary

Application deployment owns the image, runtime environment variables, probes, scaling, telemetry, Blob protection, and the attachment of `umi-scrumstudio`.

Application deployment does **not** create, import, replace, or update:

- `authConfigs/current`
- The Easy Auth Entra application or credential
- The Entra authorization group or its membership
- Existing Container App secrets
- A Key Vault or Key Vault role assignment

Terraform ignores the Container App secret collection and prevents destruction of the app. `Deploy-Azure.ps1` also rejects any plan that touches authentication or deletes/replaces the Container App, then verifies the Easy Auth configuration hash and secret-name set after apply.

## Administrator confirmations

An Azure RBAC administrator must confirm:

1. `umi-scrumstudio` has `AcrPull` on `acrscrumstudio`.
2. `umi-scrumstudio` has `Storage Blob Data Contributor` on the private `scrum-studio` container or a parent scope.
3. The deployment operator has access to the `scrum-studio-tfstate` container for Terraform's Azure AD backend.

An Azure DevOps administrator must confirm that `umi-scrumstudio` is added to organization `esiappdev` and project `Digital Transformation` with read access to teams, iterations, work items, area paths, and Analytics. Azure RBAC does not prove this ADO organization membership.

Cyber has already provisioned Easy Auth and the authorization group. No app registration, group, group member list, client secret, or Key Vault secret value is required by this repository.

## Prepare and preflight

Run from Azure Cloud Shell PowerShell after activating the eligible Contributor role through PIM:

```powershell
cd <cloned-repository>/infra

./Prepare-Azure.ps1 `
  -SubscriptionId '<subscription-id>'

Copy-Item terraform.tfvars.example terraform.tfvars
```

`Prepare-Azure.ps1` discovers the existing resources, creates only missing private Blob containers, and runs the read-only preflight. The preflight confirms:

- Easy Auth is enabled and requires authentication.
- At least one Entra authorization group restriction exists.
- `umi-scrumstudio` is attached to the Container App.
- Required ACR and Blob RBAC assignments exist.
- `AZURE_CLIENT_ID` matches the identity client ID.
- Required runtime environment variables are present or identifies those the first application update will set.

Run the preflight independently at any time:

```powershell
./Test-AzurePreflight.ps1 `
  -SubscriptionId '<subscription-id>'
```

Use `-StrictRuntimeConfiguration` after deployment to require every runtime setting to match.

## Deploy

Complete only the non-secret values in `terraform.tfvars`, then run:

```powershell
./Deploy-Azure.ps1 `
  -SubscriptionId '<subscription-id>' `
  -Release 'v1-pilot'
```

The script:

- Runs read-only authentication, identity, and RBAC preflight before building.
- Captures a fingerprint of Cyber-managed Easy Auth and the Container App secret names.
- Builds an immutable image in `acrscrumstudio`.
- Initializes remote Terraform state with Azure AD authentication.
- Imports the existing Container App when needed.
- Releases legacy Easy Auth and Key Vault entries from Terraform state without deleting Azure resources.
- Rejects unsafe Terraform plans.
- Applies the application runtime update.
- Confirms authentication and secret names did not change.
- Runs strict post-deployment runtime verification.
- Records current and previous image digests in ignored `infra/local` files.

If ACR public network access is disabled, the cloud build needs an approved company pipeline or an ACR Task agent pool with registry network access.

## Rollback

Read `infra/local/last-deployment.json`, then redeploy the recorded `previousImage`:

```powershell
./Deploy-Azure.ps1 `
  -SubscriptionId '<subscription-id>' `
  -Release 'rollback' `
  -ExistingImage '<previous immutable image digest>'
```

## Pilot verification

- `/health/live` returns `200` through the configured Easy Auth health exclusion.
- `/health/ready` returns `200` after Blob connectivity is established.
- An allowed company user signs in; a user outside the group is denied.
- Missing Easy Auth identity headers fail closed in production.
- ADO loads through `umi-scrumstudio` without PATs.
- Reviews persist after revision restart and deployment.
- Users cannot access another user's reviews or artifacts.
- Screenshots, logos, HTML, PDF, and every presentation mode work.
- Application Insights receives request, dependency, error, and correlation data.

After the Blob flow and Terraform backend are verified, an administrator can disable storage account shared-key access. Keep public storage networking only for the pilot, then restrict it after the Container Apps outbound path is validated.
