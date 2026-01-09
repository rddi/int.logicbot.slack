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
   - Value: `repo:YOUR_GITHUB_ORG/YOUR_REPO_NAME:*`
   - Attach policies:
     - `AWSLambda_FullAccess` (or more restrictive custom policy)
     - `IAMFullAccess` (or policy allowing role/function creation)
     - `AmazonAPIGatewayAdministrator` (or API Gateway management permissions)
   - Name the role (e.g., `github-actions-logicbot`)
   - **Copy the Role ARN** (you'll need it for GitHub secret)

## Step 2: Configure GitHub Secrets

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

## Step 3: Deploy via GitHub Actions

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

## Step 4: Configure Slack App Request URLs

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

## Step 5: Verify Deployment

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

### Terraform Apply Fails

#### "EntityAlreadyExists" Error for IAM Role
If you see an error like `Role with name logicbot-lambda-role already exists`, the IAM role exists in AWS but not in Terraform state. Import it manually:

```bash
cd infra
terraform init
terraform import \
  -var="aws_region=$AWS_REGION" \
  -var="slack_bot_token=$SLACK_BOT_TOKEN" \
  -var="slack_signing_secret=$SLACK_SIGNING_SECRET" \
  -var="logic_channel_id_main=$LOGIC_CHANNEL_ID_MAIN" \
  -var="logic_channel_id_test=$LOGIC_CHANNEL_ID_TEST" \
  -var="logic_admin_user_ids=$LOGIC_ADMIN_USER_IDS" \
  aws_iam_role.lambda_role logicbot-lambda-role
```

Then re-run `terraform apply`.

#### Other Common Issues
- Check AWS credentials/permissions
- Verify all GitHub secrets are set
- Check Terraform state (if re-running, may need `terraform init`)

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

1. **Terraform State**: Consider using remote state (S3 + DynamoDB) for team collaboration
2. **Secrets Management**: For production, consider migrating to AWS Secrets Manager (see README)
3. **IAM Permissions**: Use least-privilege policies instead of full access
4. **Lambda Environment**: Rotate Slack tokens periodically

## Rollback

If something goes wrong:

1. **Revert code**: `git revert <commit>` and push
2. **Or manually update Lambda**: AWS Console → Lambda → Upload new deployment package
3. **Or destroy and recreate**: `terraform destroy` then re-run workflow
