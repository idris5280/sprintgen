[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$SubscriptionId,
  [string]$ResourceGroup = "rg-scrumstudio",
  [string]$RegistryName = "acrscrumstudio",
  [string]$ContainerAppName = "ca-scrumstudio",
  [string]$EnvironmentName = "cae-scrumstudio",
  [string]$IdentityName = "umi-scrumstudio",
  [string]$StorageAccountName = "scrumstudioblob",
  [string]$ReviewContainer = "scrum-studio",
  [string]$StateContainer = "scrum-studio-tfstate",
  [string]$AdoOrg = "esiappdev",
  [string]$AdoProject = "Digital Transformation"
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

function Ensure-PrivateContainer {
  param([string]$StorageId, [string]$Name)
  $id = "$StorageId/blobServices/default/containers/$Name"
  & az resource show --ids $id --api-version 2023-05-01 --only-show-errors --output none 2>$null
  if ($LASTEXITCODE -eq 0) {
    Write-Host "Found private container: $Name"
    return $id
  }

  Write-Host "Creating private container: $Name"
  $body = '{"properties":{"publicAccess":"None"}}'
  & az rest --method put --url "https://management.azure.com$id`?api-version=2023-05-01" --body $body --only-show-errors --output none
  if ($LASTEXITCODE -ne 0) {
    throw "Could not create Blob container $Name. Ask an Azure administrator to create it privately."
  }
  return $id
}

if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
  throw "Azure CLI is required. Run this script from Azure Cloud Shell or a workstation with Azure CLI installed."
}

& az account set --subscription $SubscriptionId --only-show-errors
if ($LASTEXITCODE -ne 0) {
  throw "Could not select the Azure subscription. Activate the rg-scrumstudio Contributor role through PIM first."
}

$resourceGroupInfo = Invoke-AzureJson -Arguments @("group", "show", "--name", $ResourceGroup)
$registry = Invoke-AzureJson -Arguments @("acr", "show", "--name", $RegistryName, "--resource-group", $ResourceGroup)
$containerApp = Invoke-AzureJson -Arguments @("containerapp", "show", "--name", $ContainerAppName, "--resource-group", $ResourceGroup)
$environment = Invoke-AzureJson -Arguments @("containerapp", "env", "show", "--name", $EnvironmentName, "--resource-group", $ResourceGroup)
$identity = Invoke-AzureJson -Arguments @("identity", "show", "--name", $IdentityName, "--resource-group", $ResourceGroup)
$storage = Invoke-AzureJson -Arguments @("storage", "account", "show", "--name", $StorageAccountName, "--resource-group", $ResourceGroup)

$reviewContainerId = Ensure-PrivateContainer -StorageId $storage.id -Name $ReviewContainer
$stateContainerId = Ensure-PrivateContainer -StorageId $storage.id -Name $StateContainer

$localDirectory = Join-Path $PSScriptRoot "local"
New-Item -ItemType Directory -Path $localDirectory -Force | Out-Null
$discoveryPath = Join-Path $localDirectory "azure-resources.json"

$result = [ordered]@{
  subscriptionId = $SubscriptionId
  resourceGroup = $resourceGroupInfo.name
  location = $resourceGroupInfo.location
  registry = [ordered]@{
    id = $registry.id
    name = $registry.name
    loginServer = $registry.loginServer
    publicNetworkAccess = $registry.publicNetworkAccess
  }
  containerApp = [ordered]@{
    id = $containerApp.id
    name = $containerApp.name
    fqdn = $containerApp.properties.configuration.ingress.fqdn
    currentImage = $containerApp.properties.template.containers[0].image
  }
  environmentId = $environment.id
  managedIdentity = [ordered]@{
    id = $identity.id
    clientId = $identity.clientId
    principalId = $identity.principalId
  }
  storage = [ordered]@{
    id = $storage.id
    accountUrl = "https://$StorageAccountName.blob.core.windows.net"
    reviewContainerId = $reviewContainerId
    stateContainerId = $stateContainerId
  }
}

$result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $discoveryPath -Encoding utf8
Write-Host "Azure resource discovery completed."
Write-Host "Non-secret discovery details: $discoveryPath"

Write-Host "Running the read-only authentication, identity, and RBAC preflight..."
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

Write-Host "Next: complete terraform.tfvars with non-secret application values, resolve any preflight warnings with the appropriate administrator, then run Deploy-Azure.ps1."
