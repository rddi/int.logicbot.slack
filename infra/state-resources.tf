# S3 Bucket and DynamoDB Table for Terraform State
# These resources must be created BEFORE using the S3 backend
# Run: terraform apply -target=aws_s3_bucket.terraform_state -target=aws_dynamodb_table.terraform_locks
# Then configure the backend and run terraform init -migrate-state

resource "aws_s3_bucket" "terraform_state" {
  bucket = "${var.app_name}-terraform-state"

  lifecycle {
    prevent_destroy = true
  }

  tags = {
    Name        = "${var.app_name} Terraform State"
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
  name         = "${var.app_name}-terraform-locks"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "LockID"

  attribute {
    name = "LockID"
    type = "S"
  }

  tags = {
    Name        = "${var.app_name} Terraform Locks"
    Environment = "production"
    ManagedBy   = "Terraform"
  }
}
