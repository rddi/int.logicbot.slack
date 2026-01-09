variable "aws_region" {
  description = "AWS region for resources"
  type        = string
}

variable "app_name" {
  description = "Application name (used for resource naming)"
  type        = string
  default     = "logicbot"
}

variable "slack_bot_token" {
  description = "Slack Bot User OAuth Token"
  type        = string
  sensitive   = true
}

variable "slack_signing_secret" {
  description = "Slack Signing Secret"
  type        = string
  sensitive   = true
}

variable "logic_channel_id_main" {
  description = "Main channel ID where the bot operates"
  type        = string
}

variable "logic_channel_id_test" {
  description = "Test channel ID where the bot operates"
  type        = string
}

variable "logic_admin_user_ids" {
  description = "Comma-separated list of admin user IDs"
  type        = string
  default     = ""
}

variable "lambda_zip_path" {
  description = "Path to the Lambda deployment zip file"
  type        = string
  default     = "../dist/lambda.zip"
}
