[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$SubscriptionId,
  [string]$ResourceGroup = "rg-scrumstudio",
  [string]$RegistryName = "acrscrumstudio",
  [string]$ContainerAppName = "ca-scrumstudio",
  [string]$IdentityName = "umi-scrumstudio",
  [string]$StorageAccountName = "scrumstudioblob",
  [string]$ReviewContainer = "scrum-studio",
  [string]$AdoOrg = "esiappdev",
  [string]$AdoProject = "Digital Transformation",
  [switch]$StrictRuntimeConfiguration,
  [string]$OutputPath = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$script:blockers = [System.Collections.Generic.List[string]]::new()
$script:warnings = [System.Collections.Generic.List[string]]::new()
$script:checks = [System.Collections.Generic.List[object]]::new()

function Add-Check {
  param(
    [string]$Name,
    [bool]$Passed,
    [string]$Detail,
    [ValidateSet("blocker", "warning")][string]$FailureLevel = "blocker"
  )

  $script:checks.Add([ordered]@{ name = $Name; passed = $Passed; detail = $Detail })
  if ($Passed) {
    Write-Host "[PASS] $Name - $Detail" -ForegroundColor Green
    return
  }

  if ($FailureLevel -eq "warning") {
    $script:warnings.Add("$Name`: $Detail")
    Write-Warning "$Name - $Detail"
  } else {
    $script:blockers.Add("$Name`: $Detail")
    Write-Host "[BLOCKED] $Name - $Detail" -ForegroundColor Red
  }
}

function Invoke-AzureJson {
  param([Parameter(Mandatory = $true)][string[]]$Arguments)
  $output = & az @Arguments --only-show-errors --output json
  if ($LASTEXITCODE -ne 0) {
    throw "Azure CLI failed: az $($Arguments -join ' ')"
  }
  return $output | ConvertFrom-Json
}

function Get-NestedValue {
  param([object]$Root, [string[]]$Path)
  $current = $Root
  foreach ($segment in $Path) {
    if ($null -eq $current) { return $null }
    $property = $current.PSObject.Properties[$segment]
    if ($null -eq $property) { return $null }
    $current = $property.Value
  }
  return $current
}

function Test-RoleAssignment {
  param([string]$PrincipalId, [string]$Scope, [string]$RoleName)
  try {
    $assignments = Invoke-AzureJson -Arguments @(
      "role", "assignment", "list",
      "--assignee-object-id", $PrincipalId,
      "--scope", $Scope,
      "--include-inherited"
    )
    return [bool]($assignments | Where-Object { $_.roleDefinitionName -eq $RoleName })
  } catch {
    $script:warnings.Add("Azure RBAC query failed for $RoleName. An Azure RBAC administrator must confirm the assignment. $($_.Exception.Message)")
    return $false
  }
}

function Get-EnvironmentMap {
  param([object]$ContainerApp)
  $map = @{}
  $containers = Get-NestedValue -Root $ContainerApp -Path @("properties", "template", "containers")
  if (-not $containers -or $containers.Count -eq 0) { return $map }
  foreach ($entry in @($containers[0].env)) {
    if (-not $entry.name) { continue }
    $map[$entry.name] = if ($entry.PSObject.Properties["value"]) {
      [string]$entry.value
    } elseif ($entry.PSObject.Properties["secretRef"]) {
      "<secret-ref:$($entry.secretRef)>"
    } else {
      ""
    }
  }
  return $map
}

if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
  throw "Azure CLI is required. Run this script from Azure Cloud Shell or a workstation with Azure CLI installed."
}

& az account set --subscription $SubscriptionId --only-show-errors
if ($LASTEXITCODE -ne 0) {
  throw "Could not select subscription $SubscriptionId. Activate the rg-scrumstudio Contributor role through PIM first."
}

Write-Host "Scrum Studio Azure deployment preflight" -ForegroundColor Cyan
Write-Host "This check is read-only and does not change Easy Auth, secrets, RBAC, or application resources."

$registry = Invoke-AzureJson -Arguments @("acr", "show", "--name", $RegistryName, "--resource-group", $ResourceGroup)
$containerApp = Invoke-AzureJson -Arguments @("containerapp", "show", "--name", $ContainerAppName, "--resource-group", $ResourceGroup)
$identity = Invoke-AzureJson -Arguments @("identity", "show", "--name", $IdentityName, "--resource-group", $ResourceGroup)
$storage = Invoke-AzureJson -Arguments @("storage", "account", "show", "--name", $StorageAccountName, "--resource-group", $ResourceGroup)
$reviewContainerId = "$($storage.id)/blobServices/default/containers/$ReviewContainer"

try {
  $authConfig = Invoke-AzureJson -Arguments @(
    "rest", "--method", "get",
    "--url", "https://management.azure.com$($containerApp.id)/authConfigs/current?api-version=2025-07-01"
  )
} catch {
  $authConfig = $null
}

$authEnabled = [bool](Get-NestedValue -Root $authConfig -Path @("properties", "platform", "enabled"))
$requireAuthentication = [bool](Get-NestedValue -Root $authConfig -Path @("properties", "globalValidation", "requireAuthentication"))
$allowedGroups = @(Get-NestedValue -Root $authConfig -Path @(
  "properties", "identityProviders", "azureActiveDirectory", "validation",
  "defaultAuthorizationPolicy", "allowedPrincipals", "groups"
)) | Where-Object { $_ }
$credentialSettingName = [string](Get-NestedValue -Root $authConfig -Path @(
  "properties", "identityProviders", "azureActiveDirectory", "registration", "clientSecretSettingName"
))

Add-Check -Name "Easy Auth enabled" -Passed ($authEnabled -and $requireAuthentication) -Detail $(
  if ($authEnabled -and $requireAuthentication) { "Platform authentication is enabled and requires authentication." }
  else { "Cyber must enable Container Apps Easy Auth and require authentication before deployment." }
)
Add-Check -Name "Authorization group restriction" -Passed ($allowedGroups.Count -gt 0) -Detail $(
  if ($allowedGroups.Count -gt 0) { "$($allowedGroups.Count) externally managed Entra group restriction(s) found." }
  else { "No allowed-principals group was found in authConfigs/current. Cyber must restore the existing group restriction." }
)

$attachedIdentityIds = @()
$userAssignedIdentities = Get-NestedValue -Root $containerApp -Path @("identity", "userAssignedIdentities")
if ($userAssignedIdentities) {
  $attachedIdentityIds = @($userAssignedIdentities.PSObject.Properties.Name)
}
$identityAttached = [bool]($attachedIdentityIds | Where-Object { $_ -ieq $identity.id })
Add-Check -Name "Managed identity attached" -Passed $identityAttached -Detail $(
  if ($identityAttached) { "$IdentityName is attached to $ContainerAppName." }
  else { "Attach $IdentityName to $ContainerAppName before deploying." }
)

$acrRole = Test-RoleAssignment -PrincipalId $identity.principalId -Scope $registry.id -RoleName "AcrPull"
Add-Check -Name "ACR pull role" -Passed $acrRole -Detail $(
  if ($acrRole) { "$IdentityName has AcrPull on $RegistryName." }
  else { "An Azure RBAC administrator must grant AcrPull to $IdentityName on $RegistryName." }
)

$blobRole = Test-RoleAssignment -PrincipalId $identity.principalId -Scope $reviewContainerId -RoleName "Storage Blob Data Contributor"
Add-Check -Name "Blob data role" -Passed $blobRole -Detail $(
  if ($blobRole) { "$IdentityName has Storage Blob Data Contributor on $ReviewContainer." }
  else { "An Azure RBAC administrator must grant Storage Blob Data Contributor to $IdentityName at $reviewContainerId (or a parent scope)." }
)

$environment = Get-EnvironmentMap -ContainerApp $containerApp
$expectedEnvironment = [ordered]@{
  NODE_ENV                 = "production"
  PORT                     = "3000"
  AZURE_CLIENT_ID          = [string]$identity.clientId
  ADO_ORG                  = $AdoOrg
  ADO_PROJECT              = $AdoProject
  AZURE_STORAGE_ACCOUNT_URL = "https://$StorageAccountName.blob.core.windows.net"
  AZURE_STORAGE_CONTAINER  = $ReviewContainer
}

foreach ($entry in $expectedEnvironment.GetEnumerator()) {
  $actual = if ($environment.ContainsKey($entry.Key)) { [string]$environment[$entry.Key] } else { "" }
  $passed = $actual -eq [string]$entry.Value
  $level = if ($StrictRuntimeConfiguration) { "blocker" } else { "warning" }
  Add-Check -Name "Environment $($entry.Key)" -Passed $passed -FailureLevel $level -Detail $(
    if ($passed) { "Configured correctly." }
    elseif (-not $actual) { "Missing. Expected '$($entry.Value)'. The application deployment must set it." }
    else { "Configured as '$actual'; expected '$($entry.Value)'." }
  )
}

$hasAppInsights = $environment.ContainsKey("APPLICATIONINSIGHTS_CONNECTION_STRING") -and [bool]$environment["APPLICATIONINSIGHTS_CONNECTION_STRING"]
Add-Check -Name "Application Insights environment" -Passed $hasAppInsights -FailureLevel $(if ($StrictRuntimeConfiguration) { "blocker" } else { "warning" }) -Detail $(
  if ($hasAppInsights) { "APPLICATIONINSIGHTS_CONNECTION_STRING is configured." }
  else { "The application deployment must configure APPLICATIONINSIGHTS_CONNECTION_STRING." }
)

$script:warnings.Add("Azure DevOps access cannot be proven by Azure RBAC alone. An Azure DevOps administrator must confirm that $IdentityName (principal $($identity.principalId)) is added to organization '$AdoOrg' and project '$AdoProject' with team, iteration, work-item, area-path, and Analytics read access.")

$report = [ordered]@{
  checkedAt = (Get-Date).ToUniversalTime().ToString("o")
  subscriptionId = $SubscriptionId
  containerApp = $ContainerAppName
  easyAuth = [ordered]@{
    enabled = $authEnabled
    requireAuthentication = $requireAuthentication
    authorizationGroupCount = $allowedGroups.Count
    credentialSettingName = $credentialSettingName
    ownership = "Cyber-managed; deployment must preserve authConfigs/current and Container App secrets."
  }
  managedIdentity = [ordered]@{
    name = $IdentityName
    clientId = $identity.clientId
    principalId = $identity.principalId
    attached = $identityAttached
  }
  checks = $script:checks
  warnings = $script:warnings
  blockerCount = $script:blockers.Count
}

if (-not $OutputPath) {
  $localDirectory = Join-Path $PSScriptRoot "local"
  New-Item -ItemType Directory -Path $localDirectory -Force | Out-Null
  $OutputPath = Join-Path $localDirectory "azure-preflight.json"
}
$report | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $OutputPath -Encoding utf8

foreach ($warning in $script:warnings) {
  Write-Warning $warning
}

Write-Host "Preflight report: $OutputPath"
if ($script:blockers.Count -gt 0) {
  throw "Azure deployment preflight found $($script:blockers.Count) blocker(s). No deployment should proceed."
}

Write-Host "Azure deployment preflight passed." -ForegroundColor Green
$report
