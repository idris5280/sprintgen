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
  default     = "esiappdev"
}

variable "ado_project" {
  type        = string
  description = "Azure DevOps project name."
  default     = "Digital Transformation"
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
