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
  default = "sascrumstudio"
}

variable "storage_container" {
  type    = string
  default = "scrum-studio"
}

variable "state_storage_account_name" {
  type        = string
  description = "Cyber-approved storage account containing the Terraform state container."
  default     = "sascrumstudio"
}

variable "state_storage_resource_group_name" {
  type        = string
  description = "Resource group containing the Cyber-approved Terraform state account."
  default     = "rg-scrumstudio"
}

variable "state_container_name" {
  type        = string
  description = "Private container used by Terraform's Azure AD backend."
  default     = "scrum-studio-tfstate"
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
  default     = "esiappdev"
}

variable "ado_project" {
  type        = string
  description = "Azure DevOps project name."
  default     = "Digital Transformation"
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
