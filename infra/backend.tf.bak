# Terraform Backend Configuration
# This file defines the S3 backend for remote state storage
# The backend is configured via -backend-config in the workflow to avoid hardcoding

terraform {
  backend "s3" {
    # These values are provided via -backend-config in GitHub Actions workflow
    # bucket         = "logicbot-terraform-state"
    # key            = "terraform.tfstate"
    # region         = "us-east-1"
    # dynamodb_table = "logicbot-terraform-locks"
    # encrypt        = true
  }
}
