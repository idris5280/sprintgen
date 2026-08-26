[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$SubscriptionId,
  [string]$ResourceGroup = "rg-scrumstudio",
  [string]$RegistryName = "acrscrumstudio",
  [string]$ContainerAppName = "ca-scrumstudio",
  [string]$IdentityName = "umi-scrumstudio",
  [string]$StorageAccountName = "sascrumstudio",
  [string]$ReviewContainer = "scrum-studio",
  [string]$StateStorageAccountName = "sascrumstudio",
  [string]$StateStorageResourceGroup = "",
  [string]$StateContainer = "scrum-studio",
  [string]$AdoOrg = "esiappdev",
  [string]$AdoProject = "Digital Transformation",
  [switch]$StrictRuntimeConfiguration,
  [string]$OutputPath = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
if (-not $StateStorageResourceGroup) { $StateStorageResourceGroup = $ResourceGroup }

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

function Get-ContainerInfo {
  param([string]$StorageId, [string]$Name)
  $id = "$StorageId/blobServices/default/containers/$Name"
  try {
    $resource = Invoke-AzureJson -Arguments @(
      "resource", "show", "--ids", $id, "--api-version", "2023-05-01"
    )
    $publicAccess = [string](Get-NestedValue -Root $resource -Path @("properties", "publicAccess"))
    return [ordered]@{
      found = $true
      id = $id
      private = (-not $publicAccess -or $publicAccess -eq "None")
      publicAccess = $publicAccess
    }
  } catch {
    return [ordered]@{ found = $false; id = $id; private = $false; publicAccess = "" }
  }
}

function Get-AnonymousAccessResult {
  param([string]$Uri)
  $handler = [System.Net.Http.HttpClientHandler]::new()
  $handler.AllowAutoRedirect = $false
  $client = [System.Net.Http.HttpClient]::new($handler)
  $client.Timeout = [TimeSpan]::FromSeconds(20)
  try {
    $response = $client.GetAsync($Uri).GetAwaiter().GetResult()
    $status = [int]$response.StatusCode
    $location = if ($response.Headers.Location) { [string]$response.Headers.Location } else { "" }
    $isAuthRedirect = $status -ge 300 -and $status -lt 400 -and (
      $location -match "(?i)/\.auth/" -or $location -match "(?i)login\.microsoftonline\.com"
    )
    return [ordered]@{
      checked = $true
      status = $status
      location = $location
      protected = ($status -in @(401, 403) -or $isAuthRedirect)
      error = ""
    }
  } catch {
    return [ordered]@{ checked = $false; status = 0; location = ""; protected = $false; error = $_.Exception.Message }
  } finally {
    $client.Dispose()
    $handler.Dispose()
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
$stateStorage = if ($StateStorageAccountName -eq $StorageAccountName -and $StateStorageResourceGroup -eq $ResourceGroup) {
  $storage
} else {
  Invoke-AzureJson -Arguments @("storage", "account", "show", "--name", $StateStorageAccountName, "--resource-group", $StateStorageResourceGroup)
}
$reviewContainerInfo = Get-ContainerInfo -StorageId $storage.id -Name $ReviewContainer
$stateContainerInfo = if ($stateStorage.id -eq $storage.id -and $StateContainer -eq $ReviewContainer) {
  $reviewContainerInfo
} else {
  Get-ContainerInfo -StorageId $stateStorage.id -Name $StateContainer
}

Add-Check -Name "Review Blob container" -Passed ($reviewContainerInfo.found -and $reviewContainerInfo.private) -Detail $(
  if (-not $reviewContainerInfo.found) { "Cyber must provision private container '$ReviewContainer' in $StorageAccountName." }
  elseif (-not $reviewContainerInfo.private) { "Container '$ReviewContainer' permits public access ('$($reviewContainerInfo.publicAccess)'). Cyber must make it private." }
  else { "Cyber-managed container '$ReviewContainer' exists and is private." }
)
Add-Check -Name "Terraform state container" -Passed ($stateContainerInfo.found -and $stateContainerInfo.private) -Detail $(
  if (-not $stateContainerInfo.found) { "Cyber must provision private backend container '$StateContainer' in $StateStorageAccountName or provide the approved backend." }
  elseif (-not $stateContainerInfo.private) { "State container '$StateContainer' permits public access ('$($stateContainerInfo.publicAccess)'). Cyber must make it private." }
  else { "Private backend container '$StateContainer' exists in $StateStorageAccountName; state uses blob key 'terraform/scrum-studio.tfstate'." }
)

$stateAccess = $false
if ($stateContainerInfo.found) {
  & az storage blob list --account-name $StateStorageAccountName --container-name $StateContainer --auth-mode login --num-results 1 --only-show-errors --output none 2>$null
  $stateAccess = $LASTEXITCODE -eq 0
}
Add-Check -Name "Terraform state access" -Passed $stateAccess -Detail $(
  if ($stateAccess) { "The deployment identity can access the Azure AD Terraform backend." }
  else { "The deployment identity cannot read '$StateContainer' in $StateStorageAccountName. Cyber must grant backend access or provide an approved backend." }
)

try {
  $authConfig = Invoke-AzureJson -Arguments @(
    "containerapp", "auth", "show",
    "--name", $ContainerAppName,
    "--resource-group", $ResourceGroup
  )
} catch {
  $cliAuthError = $_.Exception.Message
  try {
    $authConfig = Invoke-AzureJson -Arguments @(
      "rest", "--method", "get",
      "--url", "https://management.azure.com$($containerApp.id)/authConfigs/current?api-version=2025-07-01"
    )
  } catch {
    throw "Could not read Cyber-managed Easy Auth. Azure CLI: $cliAuthError REST fallback: $($_.Exception.Message) Ask Cyber to confirm that your deployment account can read authConfigs/current."
  }
}

$authProperties = if ($authConfig.PSObject.Properties["properties"]) { $authConfig.properties } else { $authConfig }
$authEnabled = [bool](Get-NestedValue -Root $authProperties -Path @("platform", "enabled"))
$requireAuthentication = [bool](Get-NestedValue -Root $authProperties -Path @("globalValidation", "requireAuthentication"))
$unauthenticatedAction = [string](Get-NestedValue -Root $authProperties -Path @("globalValidation", "unauthenticatedClientAction"))
$allowedGroups = @(@(Get-NestedValue -Root $authProperties -Path @(
    "identityProviders", "azureActiveDirectory", "validation",
    "defaultAuthorizationPolicy", "allowedPrincipals", "groups"
  )) | Where-Object { $_ })
$credentialSettingName = [string](Get-NestedValue -Root $authProperties -Path @(
  "identityProviders", "azureActiveDirectory", "registration", "clientSecretSettingName"
))

$protectedAction = $unauthenticatedAction -in @("RedirectToLoginPage", "Return401", "Return403")
Add-Check -Name "Easy Auth enabled" -Passed ($authEnabled -and ($requireAuthentication -or $protectedAction)) -Detail $(
  if ($authEnabled -and ($requireAuthentication -or $protectedAction)) { "Platform authentication is enabled and challenges unauthenticated users." }
  else { "Cyber must configure Container Apps Easy Auth to reject or redirect unauthenticated users before deployment." }
)
Add-Check -Name "Authorization group visibility" -Passed ($allowedGroups.Count -gt 0) -FailureLevel "warning" -Detail $(
  if ($allowedGroups.Count -gt 0) { "$($allowedGroups.Count) externally managed Entra group restriction(s) found." }
  else { "No group list is exposed in authConfigs/current. Cyber confirmed that access is enforced externally through Entra, so this is informational." }
)

$fqdn = [string](Get-NestedValue -Root $containerApp -Path @("properties", "configuration", "ingress", "fqdn"))
$anonymousAccess = if ($fqdn) { Get-AnonymousAccessResult -Uri "https://$fqdn/" } else {
  [ordered]@{ checked = $false; status = 0; location = ""; protected = $false; error = "Container App FQDN is missing." }
}
Add-Check -Name "Anonymous access denied" -Passed $anonymousAccess.protected -FailureLevel $(if ($StrictRuntimeConfiguration) { "blocker" } else { "warning" }) -Detail $(
  if ($anonymousAccess.protected) { "Anonymous request received HTTP $($anonymousAccess.status) and was rejected or redirected to sign-in." }
  elseif ($anonymousAccess.checked) { "Anonymous request received HTTP $($anonymousAccess.status). Cyber must ensure the application is not publicly accessible without sign-in." }
  else { "Could not verify anonymous access: $($anonymousAccess.error)" }
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

$blobRole = $reviewContainerInfo.found -and (Test-RoleAssignment -PrincipalId $identity.principalId -Scope $reviewContainerInfo.id -RoleName "Storage Blob Data Contributor")
Add-Check -Name "Blob data role" -Passed $blobRole -Detail $(
  if ($blobRole) { "$IdentityName has Storage Blob Data Contributor on $ReviewContainer." }
  else { "Cyber must grant Storage Blob Data Contributor to $IdentityName on '$ReviewContainer' or a parent scope." }
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

$script:warnings.Add("Cyber confirmed that $IdentityName is in the '$AdoProject' Readers group in '$AdoOrg'. Complete a Team -> Sprint -> Work Areas smoke test after deployment because Azure Resource Manager cannot validate Azure DevOps permissions.")

$report = [ordered]@{
  checkedAt = (Get-Date).ToUniversalTime().ToString("o")
  subscriptionId = $SubscriptionId
  containerApp = $ContainerAppName
  easyAuth = [ordered]@{
    enabled = $authEnabled
    requireAuthentication = $requireAuthentication
    unauthenticatedClientAction = $unauthenticatedAction
    authorizationGroupCount = $allowedGroups.Count
    anonymousStatus = $anonymousAccess.status
    credentialSettingName = $credentialSettingName
    ownership = "Cyber-managed; deployment must preserve authConfigs/current and Container App secrets."
  }
  managedIdentity = [ordered]@{
    name = $IdentityName
    clientId = $identity.clientId
    principalId = $identity.principalId
    attached = $identityAttached
  }
  storage = [ordered]@{
    account = $StorageAccountName
    reviewContainer = $ReviewContainer
    stateAccount = $StateStorageAccountName
    stateContainer = $StateContainer
    ownership = "Cyber-managed; application deployment only discovers and validates these resources."
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
