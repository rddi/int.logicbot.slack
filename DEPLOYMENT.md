# Production Deployment Guide

This guide walks you through deploying LogicBot to AWS Lambda using Terraform and GitHub Actions.

## Prerequisites Checklist

- [ ] AWS account with appropriate permissions
- [ ] GitHub repository with code pushed
- [ ] Slack app created and configured (see main README)
- [ ] Slack Bot Token and Signing Secret available

## Step 1: Set Up AWS OIDC Provider for GitHub

1. **Create OIDC Provider** (if not already exists):
   ```bash
   aws iam create-open-id-connect-provider \
     --url https://token.actions.githubusercontent.com \
     --client-id-list sts.amazonaws.com \
     --thumbprint-list 6938fd4d98bab03faadb97b34396831e3780aea1
   ```

2. **Create IAM Role for GitHub Actions**:
   - Go to AWS Console → IAM → Roles → Create Role
   - Select "Web Identity" → Choose "token.actions.githubusercontent.com"
   - Audience: `sts.amazonaws.com`
   - Add condition: `StringLike` with key `token.actions.githubusercontent.com:sub`
   - Value: `repo:iddi/int.logicbot.slack:*`
   - Attach policies:
     - `AWSLambda_FullAccess` (or more restrictive custom policy)
     - `IAMFullAccess` (or policy allowing role/function creation)
     - `AmazonAPIGatewayAdministrator` (or API Gateway management permissions)
     - `AmazonS3FullAccess` (for Terraform state bucket)
     - `AmazonDynamoDBFullAccess` (for Terraform state locking)
   - Name the role (e.g., `github-actions-logicbot`)
   - **Copy the Role ARN** (you'll need it for GitHub secret)

## Step 2: Create Terraform State Resources

Before deploying, you need to create the S3 bucket and DynamoDB table for Terraform state storage. This ensures state persists across deployments and prevents "already exists" errors.

### Option A: Create via Terraform (Recommended)

1. **Initial bootstrap** (one-time setup):
   
   Replace `YOUR_AWS_REGION` with your actual AWS region (e.g., `us-east-1`, `eu-west-2`, `eu-west-1`).
   
   The bucket name will be automatically created as: `logicbot-terraform-state-new`
   The DynamoDB table will be automatically created as: `logicbot-terraform-locks`
   
   **Important**: Temporarily disable the backend configuration during bootstrap:
   
   ```bash
   cd infra
   # Temporarily rename backend.tf to skip backend during bootstrap
   mv backend.tf backend.tf.bak
   
   # Initialize without backend
   terraform init
   
   # Create state resources
   terraform apply -target=aws_s3_bucket.terraform_state -target=aws_dynamodb_table.terraform_locks \
     -target=aws_s3_bucket_versioning.terraform_state \
     -target=aws_s3_bucket_server_side_encryption_configuration.terraform_state \
     -target=aws_s3_bucket_public_access_block.terraform_state \
     -var="aws_region=YOUR_AWS_REGION" \
     -var="app_name=logicbot" \
     -var="slack_bot_token=dummy" \
     -var="slack_signing_secret=dummy" \
     -var="logic_channel_id_main=dummy" \
     -var="logic_channel_id_test=dummy"
   
   # Restore backend.tf
   mv backend.tf.bak backend.tf
   ```
   
   **Example** (if your region is `eu-west-2`):
   ```bash
   cd infra
   mv backend.tf backend.tf.bak
   terraform init
   terraform apply -target=aws_s3_bucket.terraform_state -target=aws_dynamodb_table.terraform_locks \
     -target=aws_s3_bucket_versioning.terraform_state \
     -target=aws_s3_bucket_server_side_encryption_configuration.terraform_state \
     -target=aws_s3_bucket_public_access_block.terraform_state \
     -var="aws_region=eu-west-2" \
     -var="app_name=logicbot" \
     -var="slack_bot_token=dummy" \
     -var="slack_signing_secret=dummy" \
     -var="logic_channel_id_main=dummy" \
     -var="logic_channel_id_test=dummy"
   mv backend.tf.bak backend.tf
   ```

2. **Migrate to S3 backend**:
   
   Replace `YOUR_AWS_REGION` with the same region you used above.
   
   ```bash
   terraform init -migrate-state \
     -backend-config="bucket=logicbot-terraform-state-new" \
     -backend-config="key=terraform.tfstate" \
     -backend-config="region=YOUR_AWS_REGION" \
     -backend-config="dynamodb_table=logicbot-terraform-locks" \
     -backend-config="encrypt=true"
   ```
   
   **Example** (if your region is `eu-west-2`):
   ```bash
   terraform init -migrate-state \
     -backend-config="bucket=logicbot-terraform-state-new" \
     -backend-config="key=terraform.tfstate" \
     -backend-config="region=eu-west-2" \
     -backend-config="dynamodb_table=logicbot-terraform-locks" \
     -backend-config="encrypt=true"
   ```

### Option B: Create Manually

1. **Create S3 bucket**:
   
   Replace `YOUR_AWS_REGION` with your actual AWS region (e.g., `us-east-1`, `eu-west-2`).
   
   ```bash
   aws s3api create-bucket \
     --bucket logicbot-terraform-state-new \
     --region YOUR_AWS_REGION \
     --create-bucket-configuration LocationConstraint=YOUR_AWS_REGION
   ```
   
   **Example** (if your region is `eu-west-2`):
   ```bash
   aws s3api create-bucket \
     --bucket logicbot-terraform-state-new \
     --region eu-west-2 \
     --create-bucket-configuration LocationConstraint=eu-west-2
   ```

2. **Enable versioning**:
   ```bash
   aws s3api put-bucket-versioning \
     --bucket logicbot-terraform-state-new \
     --versioning-configuration Status=Enabled
   ```

3. **Enable encryption**:
   ```bash
   aws s3api put-bucket-encryption \
     --bucket logicbot-terraform-state-new \
     --server-side-encryption-configuration '{
       "Rules": [{
         "ApplyServerSideEncryptionByDefault": {
           "SSEAlgorithm": "AES256"
         }
       }]
     }'
   ```

4. **Block public access**:
   ```bash
   aws s3api put-public-access-block \
     --bucket logicbot-terraform-state-new \
     --public-access-block-configuration \
       "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"
   ```

5. **Create DynamoDB table**:
   
   Replace `YOUR_AWS_REGION` with your actual AWS region.
   
   ```bash
   aws dynamodb create-table \
     --table-name logicbot-terraform-locks \
     --attribute-definitions AttributeName=LockID,AttributeType=S \
     --key-schema AttributeName=LockID,KeyType=HASH \
     --billing-mode PAY_PER_REQUEST \
     --region YOUR_AWS_REGION
   ```
   
   **Example** (if your region is `eu-west-2`):
   ```bash
   aws dynamodb create-table \
     --table-name logicbot-terraform-locks \
     --attribute-definitions AttributeName=LockID,AttributeType=S \
     --key-schema AttributeName=LockID,KeyType=HASH \
     --billing-mode PAY_PER_REQUEST \
     --region eu-west-2
   ```

**Note**: The GitHub Actions IAM role must have permissions to:
- `s3:GetObject`, `s3:PutObject`, `s3:ListBucket` on `logicbot-terraform-state-new`
- `dynamodb:GetItem`, `dynamodb:PutItem`, `dynamodb:DeleteItem` on `logicbot-terraform-locks`

## Step 3: Configure GitHub Secrets

Go to your GitHub repository → Settings → Secrets and variables → Actions → New repository secret

Add these secrets:

1. **`AWS_REGION`**
   - Value: Your AWS region (e.g., `us-east-1`, `eu-west-1`)

2. **`AWS_ROLE_TO_ASSUME`**
   - Value: The ARN from Step 1 (e.g., `arn:aws:iam::123456789012:role/github-actions-logicbot`)

3. **`SLACK_BOT_TOKEN`**
   - Value: Your Slack Bot User OAuth Token (starts with `xoxb-`)
   - Get from: Slack App → OAuth & Permissions → Bot User OAuth Token

4. **`SLACK_SIGNING_SECRET`**
   - Value: Your Slack Signing Secret
   - Get from: Slack App → Basic Information → App Credentials → Signing Secret

5. **`LOGIC_CHANNEL_ID_MAIN`**
   - Value: Main channel ID where bot operates (e.g., `C01234567`)
   - How to get: Right-click channel → View channel details → Copy Channel ID

6. **`LOGIC_CHANNEL_ID_TEST`**
   - Value: Test channel ID (e.g., `C09876543`)

7. **`LOGIC_ADMIN_USER_IDS`** (optional)
   - Value: Comma-separated user IDs (e.g., `U1234567,U2345678`)
   - How to get: Right-click user → View profile → Copy User ID (or use `/logic stats @user` after bot is running)

## Step 4: Deploy via GitHub Actions

1. **Push to main branch**:
   ```bash
   git push origin main
   ```

2. **Monitor deployment**:
   - Go to GitHub → Actions tab
   - Watch the "Deploy to AWS Lambda" workflow
   - Wait for it to complete (should take 2-3 minutes)

3. **Get Slack Request URL**:
   - In the workflow output, find the "Output Slack Request URL" step
   - Copy the URL (format: `https://xxxxx.execute-api.region.amazonaws.com/slack/events`)

## Step 5: Configure Slack App Request URLs

Go to [api.slack.com/apps](https://api.slack.com/apps) → Your App

1. **Slash Commands**:
   - Click on `/logic` command
   - Paste the Request URL from Step 3
   - Click "Save"

2. **Interactivity & Shortcuts**:
   - Enable Interactivity
   - Paste the Request URL
   - Click "Save Changes"

3. **Event Subscriptions**:
   - Enable Events
   - Paste the Request URL
   - Subscribe to Bot Events:
     - `message.channels`
     - `message.groups` (if using private channels)
     - `reaction_added`
     - `file_shared` (if using `/logic image`)
   - Click "Save Changes"

## Step 6: Verify Deployment

1. **Test in Slack**:
   - Go to your configured channel
   - Run `/logic help`
   - You should see the help message

2. **Check Lambda logs**:
   - AWS Console → Lambda → Your function → Monitor → View CloudWatch Logs
   - Look for any errors

3. **Test a round**:
   - Run `/logic What has keys but no locks?`
   - Verify the bot posts the question
   - Test solving with a reaction

## Troubleshooting

### Lambda Timeout Errors
- Increase timeout in `infra/main.tf` (currently 30 seconds)
- Check CloudWatch Logs for slow operations

### API Gateway 502/504 Errors
- Verify Lambda function is deployed correctly
- Check Lambda logs for errors
- Ensure handler is `lambda.handler`

### Slack "Invalid Request" Errors
- Verify Signing Secret matches in Lambda env vars
- Check Request URL is correct (must end with `/slack/events`)
- Ensure Slack app has correct scopes

### Slack URL Verification Fails
The Lambda handler automatically handles Slack's URL verification challenge. If verification fails:
- Check that the GET route is configured in API Gateway (should be automatic)
- Verify the Lambda handler returns `{"challenge": "<value>"}` for verification requests
- Check CloudWatch Logs for any errors during verification

### Terraform Apply Fails

#### "EntityAlreadyExists" Errors
With remote state (S3 backend), this should not occur. If you see "already exists" errors:
- Verify the S3 backend is configured correctly in the workflow
- Check that Terraform state exists in S3: `aws s3 ls s3://logicbot-terraform-state-new/`
- If resources exist but aren't in state, import them manually (see below)

#### Importing Existing Resources
If a resource exists in AWS but not in Terraform state:

```bash
cd infra
terraform init \
  -backend-config="bucket=logicbot-terraform-state-new" \
  -backend-config="key=terraform.tfstate" \
  -backend-config="region=$AWS_REGION" \
  -backend-config="dynamodb_table=logicbot-terraform-locks" \
  -backend-config="encrypt=true"

terraform import \
  -var="aws_region=$AWS_REGION" \
  -var="slack_bot_token=$SLACK_BOT_TOKEN" \
  -var="slack_signing_secret=$SLACK_SIGNING_SECRET" \
  -var="logic_channel_id_main=$LOGIC_CHANNEL_ID_MAIN" \
  -var="logic_channel_id_test=$LOGIC_CHANNEL_ID_TEST" \
  -var="logic_admin_user_ids=$LOGIC_ADMIN_USER_IDS" \
  aws_iam_role.lambda_role logicbot-lambda-role
```

#### Other Common Issues
- Check AWS credentials/permissions (including S3 and DynamoDB access)
- Verify all GitHub secrets are set
- Verify S3 bucket and DynamoDB table exist
- Check Terraform state in S3: `aws s3 ls s3://logicbot-terraform-state-new/`

## Updating the Deployment

After making code changes:

1. **Push to main branch**
2. **GitHub Actions automatically deploys**
3. **No manual steps needed** (Terraform handles updates)

## Manual Terraform Commands (Optional)

If you need to run Terraform manually:

```bash
cd infra
terraform init
terraform plan \
  -var="aws_region=$AWS_REGION" \
  -var="slack_bot_token=$SLACK_BOT_TOKEN" \
  -var="slack_signing_secret=$SLACK_SIGNING_SECRET" \
  -var="logic_channel_id_main=$LOGIC_CHANNEL_ID_MAIN" \
  -var="logic_channel_id_test=$LOGIC_CHANNEL_ID_TEST" \
  -var="logic_admin_user_ids=$LOGIC_ADMIN_USER_IDS"

terraform apply -auto-approve \
  -var="aws_region=$AWS_REGION" \
  -var="slack_bot_token=$SLACK_BOT_TOKEN" \
  -var="slack_signing_secret=$SLACK_SIGNING_SECRET" \
  -var="logic_channel_id_main=$LOGIC_CHANNEL_ID_MAIN" \
  -var="logic_channel_id_test=$LOGIC_CHANNEL_ID_TEST" \
  -var="logic_admin_user_ids=$LOGIC_ADMIN_USER_IDS"
```

## Security Best Practices

1. **Terraform State**: Remote state (S3 + DynamoDB) is now configured by default for reliable deployments
2. **Secrets Management**: For production, consider migrating to AWS Secrets Manager (see README)
3. **IAM Permissions**: Use least-privilege policies instead of full access
4. **Lambda Environment**: Rotate Slack tokens periodically
5. **State Bucket**: The S3 bucket has versioning and encryption enabled; keep it private

## Rollback

If something goes wrong:

1. **Revert code**: `git revert <commit>` and push
2. **Or manually update Lambda**: AWS Console → Lambda → Upload new deployment package
3. **Or destroy and recreate**: `terraform destroy` then re-run workflow
