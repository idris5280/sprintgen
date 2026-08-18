variable "subscription_id" {
  type        = string
  description = "Azure subscription containing the existing Scrum Studio resources."
}

variable "resource_group_name" {
  type        = string
  description = "Existing Scrum Studio resource group."
  default     = "rg-scrumstudio"
}

variable "container_registry_name" {
  type    = string
  default = "acrscrumstudio"
}

variable "container_app_environment_name" {
  type    = string
  default = "cae-scrumstudio"
}

variable "container_app_name" {
  type    = string
  default = "ca-scrumstudio"
}

variable "managed_identity_name" {
  type    = string
  default = "umi-scrumstudio"
}

variable "storage_account_name" {
  type    = string
  default = "scrumstudioblob"
}

variable "storage_container" {
  type    = string
  default = "scrum-studio"
}

variable "container_image" {
  type        = string
  description = "Immutable ACR image reference, including its sha256 digest."
  validation {
    condition     = can(regex("@sha256:[a-fA-F0-9]{64}$", var.container_image))
    error_message = "container_image must be an immutable image digest such as acr.azurecr.io/scrum-studio@sha256:..."
  }
}

variable "ado_org" {
  type        = string
  description = "Azure DevOps organization name."
}

variable "ado_project" {
  type        = string
  description = "Azure DevOps project name."
  default     = "Digital Transformation"
}

variable "entra_client_id" {
  type        = string
  description = "Client ID of the Entra app registration used by Container Apps Easy Auth."
}

variable "entra_tenant_id" {
  type        = string
  description = "Company Microsoft Entra tenant ID."
}

variable "entra_group_object_id" {
  type        = string
  description = "Object ID of the Scrum Studio Users Entra security group."
}

variable "key_vault_name" {
  type        = string
  description = "Existing Key Vault containing the Easy Auth client credential."
}

variable "easy_auth_client_secret_key_vault_uri" {
  type        = string
  description = "Versioned or versionless Key Vault secret URI. This is not the secret value."
  validation {
    condition     = can(regex("^https://[a-zA-Z0-9-]+\\.vault\\.azure\\.net/secrets/[a-zA-Z0-9-]+(/[a-zA-Z0-9]+)?$", var.easy_auth_client_secret_key_vault_uri))
    error_message = "Provide a Key Vault secret URI, not an Entra client secret value."
  }
}

variable "manage_role_assignments" {
  type        = bool
  description = "Set true only when Terraform is run by an Owner, RBAC Administrator, or User Access Administrator."
  default     = false
}

variable "log_analytics_workspace_name" {
  type    = string
  default = "law-scrumstudio"
}

variable "application_insights_name" {
  type    = string
  default = "appi-scrumstudio"
}

variable "min_replicas" {
  type    = number
  default = 1
}

variable "max_replicas" {
  type    = number
  default = 3
}

variable "tags" {
  type = map(string)
  default = {
    Application = "Scrum Studio"
    Environment = "Pilot"
    ManagedBy   = "Terraform"
  }
}
