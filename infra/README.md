# Azure pilot deployment

This deployment updates the application runtime in the existing Scrum Studio resources. Container Apps Easy Auth, its Entra application, authorization group, credential, and existing Container App secrets are externally provisioned and owned by Cyber.

## Existing resources

- Resource group: `rg-scrumstudio`
- Registry: `acrscrumstudio`
- Container App: `ca-scrumstudio`
- Container Apps Environment: `cae-scrumstudio`
- Managed identity: `umi-scrumstudio`
- Cyber-managed storage account: `sascrumstudio`
- Private review container: `scrum-studio`
- Terraform state: `terraform/scrum-studio.tfstate` in the private `scrum-studio` container
- Azure DevOps organization: `esiappdev`

The replacement storage account contains no legacy data to migrate.

## Ownership boundary

Application deployment owns the image, runtime environment variables, probes, scaling, telemetry, and the attachment of `umi-scrumstudio`.

Application deployment does **not** create, import, replace, or update:

- `authConfigs/current`
- The Easy Auth Entra application or credential
- The Entra authorization group or its membership
- Existing Container App secrets
- A Key Vault or Key Vault role assignment
- Storage accounts, containers, protection settings, networking, or RBAC

Terraform ignores the Container App secret collection and prevents destruction of the app. `Deploy-Azure.ps1` also rejects any plan that touches authentication or deletes/replaces the Container App, then verifies the Easy Auth configuration hash and secret-name set after apply.

## Administrator confirmations

Cyber must confirm:

1. Private container `scrum-studio` exists in `sascrumstudio`.
2. `umi-scrumstudio` has `Storage Blob Data Contributor` on that container or a parent scope.
3. The deployment operator can access the `scrum-studio` container as the Azure AD Terraform backend.
4. Storage networking allows the Container App to reach review data and the deployment process to reach Terraform state.

Cyber confirmed that `umi-scrumstudio` belongs to the `Digital Transformation` Readers group in Azure DevOps organization `esiappdev`. This is verified after deployment with a Team -> Sprint -> Work Areas smoke test because Azure Resource Manager cannot inspect ADO permissions.

Cyber has already provisioned Easy Auth and the authorization group. No app registration, group, group member list, client secret, or Key Vault secret value is required by this repository.

## Prepare and preflight

Run from Azure Cloud Shell PowerShell after activating the eligible Contributor role through PIM:

```powershell
cd <cloned-repository>/infra

./Prepare-Azure.ps1 `
  -SubscriptionId '<subscription-id>'

Copy-Item terraform.tfvars.example terraform.tfvars
```

`Prepare-Azure.ps1` only discovers existing resources and runs the read-only preflight. It never creates or changes storage. The preflight confirms:

- Easy Auth rejects anonymous access or redirects it to company sign-in.
- Any group list exposed by Easy Auth is reported, but Cyber may enforce group assignment in Entra instead.
- `umi-scrumstudio` is attached to the Container App.
- Required ACR and Blob RBAC assignments exist.
- The shared review/Terraform container exists and is private.
- The deployment identity can access the Terraform backend.
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
- Imports the existing Container App, Log Analytics workspace, and Application Insights resource when rebuilding an empty backend.
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

Storage security, retention, networking, shared-key policy, and recovery settings remain entirely Cyber-managed.

For the pilot, application data and Terraform state share one private container. Application data remains under `users/`; Terraform uses the distinct blob key `terraform/scrum-studio.tfstate`. Backend account and container parameters remain overridable if Cyber later provides a centralized Terraform backend.
