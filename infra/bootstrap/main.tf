# Bootstrap Terraform Configuration
# This creates the S3 bucket and DynamoDB table for Terraform state storage
# This must be run BEFORE the main Terraform configuration can use the S3 backend

resource "aws_s3_bucket" "terraform_state" {
  bucket = "logicbot-terraform-state-new"

  lifecycle {
    prevent_destroy = true
  }

  tags = {
    Name        = "LogicBot Terraform State"
    Environment = "production"
    ManagedBy   = "Terraform"
  }
}

resource "aws_s3_bucket_versioning" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_dynamodb_table" "terraform_locks" {
  name         = "logicbot-terraform-locks"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "LockID"

  attribute {
    name = "LockID"
    type = "S"
  }

  tags = {
    Name        = "LogicBot Terraform Locks"
    Environment = "production"
    ManagedBy   = "Terraform"
  }
}
