variable "aws_region" {
  type    = string
  default = "<REGION>"
}

variable "aws_profile" {
  type    = string
  default = "default"
}

variable "jwt_secret" {
  type      = string
  sensitive = true
}

variable "email_user" {
  type = string
}

variable "email_pass" {
  type      = string
  sensitive = true
}

variable "firebase_project_id" {
  type = string
}

variable "google_maps_api_key" {
  type      = string
  sensitive = true
}

variable "admin_portal_origin" {
  type = string
}

variable "mobile_app_origin" {
  type = string
}


# Add a variable for your S3 bucket and CloudFront settings (already done in variables.tf)

variable "environment" {
  type        = string
  description = "Environment name (dev/stage/prod)"
  default     = "dev"
}
variable "admin_portal_bucket_name" {
  description = "S3 bucket name for the admin portal static website"
  type        = string
}
