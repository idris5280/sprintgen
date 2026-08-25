[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$SubscriptionId,
  [Parameter(Mandatory = $true)]
  [string]$Release,
  [string]$ResourceGroup = "rg-scrumstudio",
  [string]$RegistryName = "acrscrumstudio",
  [string]$ContainerAppName = "ca-scrumstudio",
  [string]$IdentityName = "umi-scrumstudio",
  [string]$StorageAccountName = "scrumstudioblob",
  [string]$ReviewContainer = "scrum-studio",
  [string]$StateContainer = "scrum-studio-tfstate",
  [string]$AdoOrg = "esiappdev",
  [string]$AdoProject = "Digital Transformation",
  [string]$TfVarsPath = "terraform.tfvars",
  [string]$ExistingImage = "",
  [switch]$AutoApprove
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Invoke-AzureJson {
  param([Parameter(Mandatory = $true)][string[]]$Arguments)
  $output = & az @Arguments --only-show-errors --output json
  if ($LASTEXITCODE -ne 0) {
    throw "Azure CLI failed: az $($Arguments -join ' ')"
  }
  return $output | ConvertFrom-Json
}

function Get-StringHash {
  param([string]$Value)
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($Value)
  $algorithm = [System.Security.Cryptography.SHA256]::Create()
  try {
    $hash = $algorithm.ComputeHash($bytes)
    return (($hash | ForEach-Object { $_.ToString("x2") }) -join "")
  } finally {
    $algorithm.Dispose()
  }
}

function Get-AuthenticationBoundary {
  param([string]$AppId)
  try {
    $auth = Invoke-AzureJson -Arguments @(
      "containerapp", "auth", "show",
      "--name", $ContainerAppName,
      "--resource-group", $ResourceGroup
    )
  } catch {
    $auth = Invoke-AzureJson -Arguments @(
      "rest", "--method", "get",
      "--url", "https://management.azure.com$AppId/authConfigs/current?api-version=2025-07-01"
    )
  }
  $canonicalAuth = $auth.properties | ConvertTo-Json -Depth 100 -Compress
  $secretNames = @(& az containerapp secret list `
    --name $ContainerAppName `
    --resource-group $ResourceGroup `
    --query "[].name" `
    --output tsv `
    --only-show-errors) | Where-Object { $_ } | Sort-Object
  if ($LASTEXITCODE -ne 0) {
    throw "Could not read the existing Container App secret names. Deployment cannot prove that Cyber-managed authentication secrets will be preserved."
  }
  return [ordered]@{
    authHash = Get-StringHash -Value $canonicalAuth
    secretNames = $secretNames
  }
}

function Remove-LegacyTerraformOwnership {
  $stateAddresses = @(terraform state list 2>$null)
  if ($LASTEXITCODE -ne 0) {
    Write-Host "No existing Terraform resources were available for legacy ownership cleanup."
    return
  }
  foreach ($address in @("azapi_resource.easy_auth", "azurerm_role_assignment.key_vault", "azurerm_role_assignment.key_vault[0]")) {
    if ($stateAddresses -contains $address) {
      Write-Host "Removing legacy Terraform ownership of $address without changing the Azure resource..."
      terraform state rm $address
      if ($LASTEXITCODE -ne 0) { throw "Terraform could not release legacy ownership of $address." }
    }
  }
}

function Assert-SafeTerraformPlan {
  param([string]$PlanPath)
  $planJson = terraform show -json $PlanPath
  if ($LASTEXITCODE -ne 0) { throw "Terraform could not inspect the generated plan." }
  $plan = $planJson | ConvertFrom-Json -Depth 100
  foreach ($change in @($plan.resource_changes)) {
    $actions = @($change.change.actions)
    if ($change.address -match "easy_auth|authConfigs|authentication" -or $change.type -match "authConfigs") {
      throw "Deployment stopped: Terraform plan attempts to manage Cyber-owned authentication resource '$($change.address)'."
    }
    if ($change.address -eq "azurerm_container_app.studio" -and $actions -contains "delete") {
      throw "Deployment stopped: Terraform plan would delete or replace ca-scrumstudio, which could destroy externally managed authentication state."
    }
  }
}

if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
  throw "Azure CLI is required. Run this script in Azure Cloud Shell."
}
if (-not (Get-Command terraform -ErrorAction SilentlyContinue)) {
  throw "Terraform 1.7 or later is required. Azure Cloud Shell includes Terraform."
}

$repoRoot = Split-Path $PSScriptRoot -Parent
$resolvedTfVars = Join-Path $PSScriptRoot $TfVarsPath
if (-not (Test-Path -LiteralPath $resolvedTfVars)) {
  throw "Create $resolvedTfVars from terraform.tfvars.example and fill in the non-secret Azure DevOps values first. Easy Auth values do not belong in this file."
}

$tfVarsContent = Get-Content -LiteralPath $resolvedTfVars -Raw
if (-not $PSBoundParameters.ContainsKey("AdoOrg") -and $tfVarsContent -match '(?m)^\s*ado_org\s*=\s*"([^"]+)"') {
  $AdoOrg = $Matches[1]
}
if (-not $PSBoundParameters.ContainsKey("AdoProject") -and $tfVarsContent -match '(?m)^\s*ado_project\s*=\s*"([^"]+)"') {
  $AdoProject = $Matches[1]
}

& az account set --subscription $SubscriptionId --only-show-errors
if ($LASTEXITCODE -ne 0) { throw "Could not select the Azure subscription." }

Write-Host "Running the read-only deployment preflight. Easy Auth and existing secrets are Cyber-managed."
& (Join-Path $PSScriptRoot "Test-AzurePreflight.ps1") `
  -SubscriptionId $SubscriptionId `
  -ResourceGroup $ResourceGroup `
  -RegistryName $RegistryName `
  -ContainerAppName $ContainerAppName `
  -IdentityName $IdentityName `
  -StorageAccountName $StorageAccountName `
  -ReviewContainer $ReviewContainer `
  -AdoOrg $AdoOrg `
  -AdoProject $AdoProject | Out-Null

$containerApp = Invoke-AzureJson -Arguments @("containerapp", "show", "--name", $ContainerAppName, "--resource-group", $ResourceGroup)
$authenticationBefore = Get-AuthenticationBoundary -AppId $containerApp.id

$previousImage = $containerApp.properties.template.containers[0].image

$imageReference = $ExistingImage
if (-not $imageReference) {
  Write-Host "Building Scrum Studio $Release in Azure Container Registry..."
  Push-Location $repoRoot
  try {
    & az acr build --registry $RegistryName --image "scrum-studio:$Release" --file Dockerfile . --only-show-errors
    if ($LASTEXITCODE -ne 0) {
      throw "ACR cloud build failed. If public access is disabled on the private registry, IT must provide an ACR Task agent pool or approved build pipeline with VNet access."
    }
  } finally {
    Pop-Location
  }

  $manifests = & az acr manifest list-metadata --registry $RegistryName --name scrum-studio --output json --only-show-errors | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0) { throw "Could not resolve the image digest from ACR." }
  $manifest = $manifests | Where-Object { $_.tags -contains $Release } | Select-Object -First 1
  if (-not $manifest -or -not $manifest.digest) { throw "ACR did not return a digest for release $Release." }
  $loginServer = & az acr show --name $RegistryName --query loginServer --output tsv --only-show-errors
  $imageReference = "$loginServer/scrum-studio@$($manifest.digest)"
}

if ($imageReference -notmatch '@sha256:[a-fA-F0-9]{64}$') {
  throw "Deployment requires an immutable image digest, not a mutable tag."
}

Push-Location $PSScriptRoot
try {
  terraform init -reconfigure `
    -backend-config="resource_group_name=$ResourceGroup" `
    -backend-config="storage_account_name=$StorageAccountName" `
    -backend-config="container_name=$StateContainer" `
    -backend-config="key=scrum-studio.tfstate" `
    -backend-config="use_azuread_auth=true"
  if ($LASTEXITCODE -ne 0) { throw "Terraform backend initialization failed." }

  Remove-LegacyTerraformOwnership

  terraform state show azurerm_container_app.studio *> $null
  if ($LASTEXITCODE -ne 0) {
    $containerAppId = & az containerapp show --name $ContainerAppName --resource-group $ResourceGroup --query id --output tsv --only-show-errors
    terraform import -var-file=$resolvedTfVars -var="container_image=$imageReference" azurerm_container_app.studio $containerAppId
    if ($LASTEXITCODE -ne 0) { throw "Terraform could not import the existing Container App." }
  }

  $planPath = Join-Path $PSScriptRoot "local\scrum-studio.tfplan"
  terraform plan -var-file=$resolvedTfVars -var="container_image=$imageReference" -out=$planPath
  if ($LASTEXITCODE -ne 0) { throw "Terraform plan failed." }
  Assert-SafeTerraformPlan -PlanPath $planPath

  if ($AutoApprove) {
    terraform apply -auto-approve $planPath
  } else {
    terraform apply $planPath
  }
  if ($LASTEXITCODE -ne 0) { throw "Terraform apply failed." }
} finally {
  Pop-Location
}

$appInsightsConnectionString = terraform -chdir=$PSScriptRoot output -raw application_insights_connection_string
if ($LASTEXITCODE -ne 0 -or -not $appInsightsConnectionString) {
  throw "Could not resolve the Application Insights connection string from Terraform output."
}
$managedIdentityClientId = terraform -chdir=$PSScriptRoot output -raw managed_identity_client_id
if ($LASTEXITCODE -ne 0 -or -not $managedIdentityClientId) {
  throw "Could not resolve the managed identity client ID from Terraform output."
}

# Merge only Scrum Studio's runtime values. This preserves any Cyber-managed
# Easy Auth environment entries that already exist on the Container App.
& az containerapp update `
  --name $ContainerAppName `
  --resource-group $ResourceGroup `
  --set-env-vars `
    "NODE_ENV=production" `
    "PORT=3000" `
    "AZURE_CLIENT_ID=$managedIdentityClientId" `
    "ADO_ORG=$AdoOrg" `
    "ADO_PROJECT=$AdoProject" `
    "AZURE_STORAGE_ACCOUNT_URL=https://$StorageAccountName.blob.core.windows.net" `
    "AZURE_STORAGE_CONTAINER=$ReviewContainer" `
    "APPLICATIONINSIGHTS_CONNECTION_STRING=$appInsightsConnectionString" `
  --only-show-errors `
  --output none
if ($LASTEXITCODE -ne 0) {
  throw "Could not merge the required Scrum Studio runtime environment variables into the Container App."
}

$authenticationAfter = Get-AuthenticationBoundary -AppId $containerApp.id
if ($authenticationBefore.authHash -ne $authenticationAfter.authHash) {
  throw "Deployment safety violation: authConfigs/current changed during the application deployment. Stop and involve Cyber before continuing."
}
if ((@($authenticationBefore.secretNames) -join "`n") -ne (@($authenticationAfter.secretNames) -join "`n")) {
  throw "Deployment safety violation: the Container App secret-name set changed during deployment. Stop and involve Cyber before continuing."
}

Write-Host "Authentication boundary preserved. Running strict post-deployment runtime verification..."
& (Join-Path $PSScriptRoot "Test-AzurePreflight.ps1") `
  -SubscriptionId $SubscriptionId `
  -ResourceGroup $ResourceGroup `
  -RegistryName $RegistryName `
  -ContainerAppName $ContainerAppName `
  -IdentityName $IdentityName `
  -StorageAccountName $StorageAccountName `
  -ReviewContainer $ReviewContainer `
  -AdoOrg $AdoOrg `
  -AdoProject $AdoProject `
  -StrictRuntimeConfiguration | Out-Null

$deployment = [ordered]@{
  deployedAt = (Get-Date).ToUniversalTime().ToString("o")
  release = $Release
  image = $imageReference
  previousImage = $previousImage
}
$deployment | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $PSScriptRoot "local\last-deployment.json") -Encoding utf8

Write-Host "Scrum Studio deployment completed."
Write-Host "Image: $imageReference"
Write-Host "Previous image recorded for rollback: $previousImage"
terraform -chdir=$PSScriptRoot output application_url
