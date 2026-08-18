# Azure pilot deployment

This Terraform configuration updates the existing Scrum Studio resources by name. It does not recreate the registry, Container Apps environment, managed identity, or storage account.

## Existing resources

- Resource group: `rg-scrumstudio`
- Registry: `acrscrumstudio`
- Container App: `ca-scrumstudio`
- Container Apps Environment: `cae-scrumstudio`
- Managed identity: `umi-scrumstudio`
- Storage account: `scrumstudioblob`
- Review container: `scrum-studio`
- Terraform state container: `scrum-studio-tfstate`

The storage account remains in East US for the pilot while the application remains in South Central US.

## Administrator prerequisites

An administrator must provide:

1. An Entra application registration for Container Apps Easy Auth.
2. A `Scrum Studio Users` security group and its object ID.
3. A Key Vault secret containing the Entra application client credential.
4. The managed identity added directly to the Azure DevOps organization/project with team, iteration, work-item, area-path, and Analytics read access.
5. These Azure role assignments for `umi-scrumstudio`:
   - `AcrPull` on `acrscrumstudio`
   - `Storage Blob Data Contributor` on the `scrum-studio` container
   - `Key Vault Secrets User` on the selected Key Vault
6. `Storage Blob Data Contributor` for the deployment operator on `scrum-studio-tfstate` so Terraform can use Azure AD authentication for remote state.

The Easy Auth redirect URI is:

```text
https://<container-app-fqdn>/.auth/login/aad/callback
```

Do not put an Entra secret value, storage key, or connection string in `terraform.tfvars`.

## First deployment

Run from Azure Cloud Shell PowerShell after activating the eligible Contributor role through PIM:

```powershell
cd <cloned-repository>/infra

./Prepare-Azure.ps1 `
  -SubscriptionId '<subscription-id>'

Copy-Item terraform.tfvars.example terraform.tfvars
```

Complete the non-secret values in `terraform.tfvars`, including the Entra IDs, Key Vault name/secret URI, and Azure DevOps organization. Then deploy:

```powershell
./Deploy-Azure.ps1 `
  -SubscriptionId '<subscription-id>' `
  -Release 'v1-pilot'
```

The script:

- Ensures the private review and Terraform-state containers exist.
- Builds the image using ACR Tasks, so local Docker is not required.
- Resolves the immutable image digest.
- Initializes remote Terraform state with Azure AD authentication.
- Imports the existing Container App into state when needed.
- Applies the Container App, Easy Auth, Blob protection, Application Insights, probes, and scaling configuration.
- Records the current and previous image digests in ignored `infra/local` files.

If ACR public network access is disabled, the cloud build may require a company build pipeline or an ACR Task agent pool connected to the registry's network.

## Existing Easy Auth configuration

If `ca-scrumstudio` already has an `authConfigs/current` resource, import it before applying:

```powershell
$appId = az containerapp show -g rg-scrumstudio -n ca-scrumstudio --query id -o tsv
terraform import -var-file=terraform.tfvars -var='container_image=<immutable-image>' azapi_resource.easy_auth "$appId/authConfigs/current"
```

## Rollback

Read `infra/local/last-deployment.json`, then redeploy the recorded `previousImage` without rebuilding:

```powershell
./Deploy-Azure.ps1 `
  -SubscriptionId '<subscription-id>' `
  -Release 'rollback' `
  -ExistingImage '<previous immutable image digest>'
```

## Pilot verification

- `/health/live` returns `200` without authentication.
- `/health/ready` returns `200` after Blob connectivity is established.
- An allowed Entra user is redirected through company sign-in.
- A user outside the allowed group is denied.
- Manual and ADO reviews persist after a Container App revision restart.
- ADO data loads without PATs.
- HTML, PDF, screenshots, logos, and presentation modes work.
- Application Insights receives request, dependency, error, and correlation data.

After the Blob-backed review flow and Terraform's Azure AD state backend are verified, disable storage account key authentication:

```powershell
az storage account update `
  --resource-group rg-scrumstudio `
  --name scrumstudioblob `
  --allow-shared-key-access false
```

Keep public storage networking enabled only for the pilot. Restrict it after the Container Apps outbound network path has been validated.
