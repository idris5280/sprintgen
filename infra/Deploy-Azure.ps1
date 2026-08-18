[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$SubscriptionId,
  [Parameter(Mandatory = $true)]
  [string]$Release,
  [string]$ResourceGroup = "rg-scrumstudio",
  [string]$RegistryName = "acrscrumstudio",
  [string]$ContainerAppName = "ca-scrumstudio",
  [string]$StorageAccountName = "scrumstudioblob",
  [string]$StateContainer = "scrum-studio-tfstate",
  [string]$TfVarsPath = "terraform.tfvars",
  [string]$ExistingImage = "",
  [switch]$AutoApprove
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
  throw "Azure CLI is required. Run this script in Azure Cloud Shell."
}
if (-not (Get-Command terraform -ErrorAction SilentlyContinue)) {
  throw "Terraform 1.7 or later is required. Azure Cloud Shell includes Terraform."
}

$repoRoot = Split-Path $PSScriptRoot -Parent
$resolvedTfVars = Join-Path $PSScriptRoot $TfVarsPath
if (-not (Test-Path -LiteralPath $resolvedTfVars)) {
  throw "Create $resolvedTfVars from terraform.tfvars.example and fill in the non-secret Entra and ADO values first."
}

& az account set --subscription $SubscriptionId --only-show-errors
if ($LASTEXITCODE -ne 0) { throw "Could not select the Azure subscription." }

$previousImage = & az containerapp show --name $ContainerAppName --resource-group $ResourceGroup --query "properties.template.containers[0].image" --output tsv --only-show-errors
if ($LASTEXITCODE -ne 0) { throw "Could not read the existing Container App." }

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

  terraform state show azurerm_container_app.studio *> $null
  if ($LASTEXITCODE -ne 0) {
    $containerAppId = & az containerapp show --name $ContainerAppName --resource-group $ResourceGroup --query id --output tsv --only-show-errors
    terraform import -var-file=$resolvedTfVars -var="container_image=$imageReference" azurerm_container_app.studio $containerAppId
    if ($LASTEXITCODE -ne 0) { throw "Terraform could not import the existing Container App." }
  }

  $planPath = Join-Path $PSScriptRoot "local\scrum-studio.tfplan"
  terraform plan -var-file=$resolvedTfVars -var="container_image=$imageReference" -out=$planPath
  if ($LASTEXITCODE -ne 0) { throw "Terraform plan failed." }

  if ($AutoApprove) {
    terraform apply -auto-approve $planPath
  } else {
    terraform apply $planPath
  }
  if ($LASTEXITCODE -ne 0) { throw "Terraform apply failed." }
} finally {
  Pop-Location
}

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
