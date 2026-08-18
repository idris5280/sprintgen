data "azurerm_resource_group" "studio" {
  name = var.resource_group_name
}

data "azurerm_container_registry" "studio" {
  name                = var.container_registry_name
  resource_group_name = var.resource_group_name
}

data "azurerm_container_app_environment" "studio" {
  name                = var.container_app_environment_name
  resource_group_name = var.resource_group_name
}

data "azurerm_user_assigned_identity" "studio" {
  name                = var.managed_identity_name
  resource_group_name = var.resource_group_name
}

data "azurerm_storage_account" "studio" {
  name                = var.storage_account_name
  resource_group_name = var.resource_group_name
}

data "azurerm_key_vault" "studio" {
  name                = var.key_vault_name
  resource_group_name = var.resource_group_name
}

locals {
  storage_container_id = "${data.azurerm_storage_account.studio.id}/blobServices/default/containers/${var.storage_container}"
}

resource "azurerm_log_analytics_workspace" "studio" {
  name                = var.log_analytics_workspace_name
  location            = data.azurerm_resource_group.studio.location
  resource_group_name = data.azurerm_resource_group.studio.name
  sku                 = "PerGB2018"
  retention_in_days   = 30
  tags                = var.tags
}

resource "azurerm_application_insights" "studio" {
  name                = var.application_insights_name
  location            = data.azurerm_resource_group.studio.location
  resource_group_name = data.azurerm_resource_group.studio.name
  workspace_id        = azurerm_log_analytics_workspace.studio.id
  application_type    = "web"
  tags                = var.tags
}

resource "azapi_update_resource" "blob_data_protection" {
  type        = "Microsoft.Storage/storageAccounts/blobServices@2023-05-01"
  resource_id = "${data.azurerm_storage_account.studio.id}/blobServices/default"
  body = {
    properties = {
      isVersioningEnabled = true
      deleteRetentionPolicy = {
        enabled              = true
        days                 = 30
        allowPermanentDelete = false
      }
      containerDeleteRetentionPolicy = {
        enabled = true
        days    = 30
      }
    }
  }
}

resource "azurerm_role_assignment" "blob" {
  count                = var.manage_role_assignments ? 1 : 0
  scope                = local.storage_container_id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = data.azurerm_user_assigned_identity.studio.principal_id
}

resource "azurerm_role_assignment" "acr_pull" {
  count                = var.manage_role_assignments ? 1 : 0
  scope                = data.azurerm_container_registry.studio.id
  role_definition_name = "AcrPull"
  principal_id         = data.azurerm_user_assigned_identity.studio.principal_id
}

resource "azurerm_role_assignment" "key_vault" {
  count                = var.manage_role_assignments ? 1 : 0
  scope                = data.azurerm_key_vault.studio.id
  role_definition_name = "Key Vault Secrets User"
  principal_id         = data.azurerm_user_assigned_identity.studio.principal_id
}

resource "azurerm_container_app" "studio" {
  name                         = var.container_app_name
  resource_group_name          = data.azurerm_resource_group.studio.name
  container_app_environment_id = data.azurerm_container_app_environment.studio.id
  revision_mode                = "Single"
  tags                         = var.tags

  identity {
    type         = "UserAssigned"
    identity_ids = [data.azurerm_user_assigned_identity.studio.id]
  }

  registry {
    server   = data.azurerm_container_registry.studio.login_server
    identity = data.azurerm_user_assigned_identity.studio.id
  }

  ingress {
    external_enabled           = true
    allow_insecure_connections = false
    target_port                = 3000
    transport                  = "auto"

    traffic_weight {
      percentage      = 100
      latest_revision = true
    }
  }

  secret {
    name                = "easy-auth-client-secret"
    identity            = data.azurerm_user_assigned_identity.studio.id
    key_vault_secret_id = var.easy_auth_client_secret_key_vault_uri
  }

  template {
    min_replicas                     = var.min_replicas
    max_replicas                     = var.max_replicas
    termination_grace_period_seconds = 30

    http_scale_rule {
      name                = "http-concurrency"
      concurrent_requests = "20"
    }

    container {
      name   = "scrum-studio"
      image  = var.container_image
      cpu    = 1
      memory = "2Gi"

      env {
        name  = "NODE_ENV"
        value = "production"
      }
      env {
        name  = "PORT"
        value = "3000"
      }
      env {
        name  = "AZURE_CLIENT_ID"
        value = data.azurerm_user_assigned_identity.studio.client_id
      }
      env {
        name  = "ADO_ORG"
        value = var.ado_org
      }
      env {
        name  = "ADO_PROJECT"
        value = var.ado_project
      }
      env {
        name  = "AZURE_STORAGE_ACCOUNT_URL"
        value = data.azurerm_storage_account.studio.primary_blob_endpoint
      }
      env {
        name  = "AZURE_STORAGE_CONTAINER"
        value = var.storage_container
      }
      env {
        name  = "APPLICATIONINSIGHTS_CONNECTION_STRING"
        value = azurerm_application_insights.studio.connection_string
      }
      env {
        name        = "MICROSOFT_PROVIDER_AUTHENTICATION_SECRET"
        secret_name = "easy-auth-client-secret"
      }

      startup_probe {
        transport               = "HTTP"
        port                    = 3000
        path                    = "/health/live"
        interval_seconds        = 5
        timeout                 = 3
        failure_count_threshold = 24
      }

      liveness_probe {
        transport               = "HTTP"
        port                    = 3000
        path                    = "/health/live"
        interval_seconds        = 20
        timeout                 = 5
        failure_count_threshold = 3
      }

      readiness_probe {
        transport               = "HTTP"
        port                    = 3000
        path                    = "/health/ready"
        interval_seconds        = 10
        timeout                 = 5
        failure_count_threshold = 3
      }
    }
  }

  depends_on = [azapi_update_resource.blob_data_protection]
}

resource "azapi_resource" "easy_auth" {
  type      = "Microsoft.App/containerApps/authConfigs@2025-01-01"
  name      = "current"
  parent_id = azurerm_container_app.studio.id
  body = {
    properties = {
      platform = {
        enabled = true
      }
      globalValidation = {
        requireAuthentication       = true
        unauthenticatedClientAction = "RedirectToLoginPage"
        redirectToProvider          = "azureactivedirectory"
        excludedPaths               = ["/health/live", "/health/ready"]
      }
      identityProviders = {
        azureActiveDirectory = {
          registration = {
            clientId                = var.entra_client_id
            clientSecretSettingName = "MICROSOFT_PROVIDER_AUTHENTICATION_SECRET"
            openIdIssuer            = "https://login.microsoftonline.com/${var.entra_tenant_id}/v2.0"
          }
          validation = {
            allowedAudiences = [var.entra_client_id]
            defaultAuthorizationPolicy = {
              allowedPrincipals = {
                groups = [var.entra_group_object_id]
              }
            }
          }
        }
      }
      login = {
        tokenStore = {
          enabled = false
        }
      }
      httpSettings = {
        requireHttps = true
        routes = {
          apiPrefix = "/.auth"
        }
      }
    }
  }
}

output "application_url" {
  value = "https://${var.container_app_name}.${data.azurerm_container_app_environment.studio.default_domain}"
}

output "managed_identity_principal_id" {
  value = data.azurerm_user_assigned_identity.studio.principal_id
}

output "storage_container_id" {
  value = local.storage_container_id
}

output "required_admin_role_assignments" {
  value = var.manage_role_assignments ? "Managed by Terraform." : "An administrator must grant AcrPull, Storage Blob Data Contributor, and Key Vault Secrets User to ${data.azurerm_user_assigned_identity.studio.name}."
}
