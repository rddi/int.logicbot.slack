# Logic Slack Bot

A production-ready Slack bot for managing lateral-thinking puzzles using the Slack Events API and Bolt for JS.

**🚀 Quick Deploy**: See [DEPLOYMENT.md](./DEPLOYMENT.md) for step-by-step production deployment instructions.

## What the Bot Does

The Logic Bot helps manage puzzle-solving rounds in Slack threads:

- **Round Management**: Each round is a Slack thread. Multiple rounds can run concurrently.
- **OP System**: The user who runs `/logic` in a thread becomes the OP (Original Poster) for that round.
- **Solving Mechanism**: The OP reacts with :yes: to a guess message, then confirms via ephemeral buttons.
- **Scoreboard**: Automatic point tracking with a pinned scoreboard message per channel.
- **Admin Controls**: Admins can manually adjust scores.
- **Auto-Nudge**: Warns users when they guess in already-solved rounds.

## Prerequisites

- Node.js 18 or higher
- A Slack workspace where you can create apps
- ngrok (for local development)

## Creating the Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps)
2. Click **"Create New App"** → **"From scratch"**
3. Name your app (e.g., "Logic Bot") and select your workspace
4. Click **"Create App"**

## Required OAuth Scopes

Navigate to **OAuth & Permissions** in the sidebar and add these **Bot Token Scopes**:

### Required Scopes

- `app_mentions:read` - Read mentions
- `channels:history` - View messages in public channels
- `channels:read` - View basic information about public channels
- `chat:write` - Send messages
- `commands` - Add slash commands
- `groups:history` - View messages in private channels (if using private channels)
- `groups:read` - View basic information about private channels (if using private channels)
- `im:history` - View messages in DMs (if needed)
- `im:read` - View basic information about DMs (if needed)
- `mpim:history` - View messages in group DMs (if needed)
- `mpim:read` - View basic information about group DMs (if needed)
- `pins:read` - View pinned messages
- `pins:write` - Pin/unpin messages
- `reactions:read` - View reactions
- `users:read` - View people in the workspace

### Optional Scopes (for better UX)

- `users:read.email` - View email addresses (if needed)

## Event Subscriptions

1. Go to **Event Subscriptions** in the sidebar
2. Enable **"Enable Events"**
3. Set your **Request URL** (for local dev, use your ngrok URL + `/slack/events`)
4. Subscribe to **Bot Events**:
   - `message.channels` - Listen to messages in public channels
   - `message.groups` - Listen to messages in private channels (if using private channels)
   - `reaction_added` - Listen to reaction events

5. Click **"Save Changes"**

## Slash Command Setup

1. Go to **Slash Commands** in the sidebar
2. Click **"Create New Command"**
3. Configure:
   - **Command**: `/logic`
   - **Request URL**: Your ngrok URL + `/slack/events` (same as Events API)
   - **Short Description**: "Manage lateral-thinking puzzle rounds"
   - **Usage Hint**: `help | scoreboard | stats [@user]`
4. Click **"Save"**

## Installing the App

1. Go to **OAuth & Permissions** in the sidebar
2. Scroll to **"Install App to Workspace"**
3. Click **"Install to Workspace"**
4. Review permissions and click **"Allow"**
5. Copy the **Bot User OAuth Token** (starts with `xoxb-`)

## Local Development Setup

### 1. Clone and Install

```bash
git clone <your-repo-url>
cd logic-slack-bot
npm install
```

### 2. Configure Environment Variables

Create a `.env` file in the root directory:

```bash
cp .env.example .env
```

Edit `.env` with your values:

```env
# Slack App Credentials
SLACK_BOT_TOKEN=xoxb-your-bot-token-here
SLACK_SIGNING_SECRET=your-signing-secret-here

# Channel IDs (where the bot operates)
LOGIC_CHANNEL_ID_MAIN=C1234567890
LOGIC_CHANNEL_ID_TEST=C0987654321

# Admin User IDs (comma-separated, no spaces)
LOGIC_ADMIN_USER_IDS=U1234567890,U0987654321

# Server Configuration
PORT=3000
```

### 3. Get Your Channel IDs

1. Open Slack in your browser
2. Navigate to the channel
3. Look at the URL: `https://workspace.slack.com/archives/C1234567890`
4. The channel ID is the part after `/archives/` (e.g., `C1234567890`)

### 4. Get Your User ID

1. Right-click on your profile in Slack
2. Click **"Copy member ID"** (or use the Slack API)
3. Use this ID in `LOGIC_ADMIN_USER_IDS`

### 5. Get Your Signing Secret

1. Go to **Basic Information** in your Slack app settings
2. Scroll to **"App Credentials"**
3. Copy the **Signing Secret**

### 6. Set Up ngrok

```bash
# Install ngrok (if not already installed)
# macOS: brew install ngrok
# Or download from https://ngrok.com/

# Start ngrok tunnel
ngrok http 3000
```

Copy the HTTPS URL (e.g., `https://abc123.ngrok.io`)

### 7. Update Slack App URLs

1. Go to **Event Subscriptions** in your Slack app
2. Set **Request URL** to: `https://abc123.ngrok.io/slack/events`
3. Go to **Slash Commands** → `/logic`
4. Set **Request URL** to: `https://abc123.ngrok.io/slack/events`
5. Save changes

### 8. Build and Run

```bash
# Build TypeScript
npm run build

# Run the bot
npm start

# Or run in development mode (with auto-reload)
npm run dev
```

The bot should now be running and responding to commands!

## Configuring Admins

Admins are defined in the `.env` file:

```env
LOGIC_ADMIN_USER_IDS=U1234567890,U0987654321
```

- Comma-separated list of user IDs (no spaces)
- Admins can use: `/logic setscore @user 10`, `/logic addpoint @user`, `/logic removepoint @user`
- Non-admins receive an ephemeral error if they try these commands

## Deployment

### Option 1: Heroku

1. Create a Heroku app:
   ```bash
   heroku create logic-slack-bot
   ```

2. Set environment variables:
   ```bash
   heroku config:set SLACK_BOT_TOKEN=xoxb-...
   heroku config:set SLACK_SIGNING_SECRET=...
   heroku config:set LOGIC_CHANNEL_ID_MAIN=C...
   heroku config:set LOGIC_CHANNEL_ID_TEST=C...
   heroku config:set LOGIC_ADMIN_USER_IDS=U...
   heroku config:set PORT=3000
   ```

3. Deploy:
   ```bash
   git push heroku main
   ```

4. Update Slack app URLs to your Heroku URL: `https://your-app.herokuapp.com/slack/events`

### Option 2: VPS / Cloud Server

1. Set up Node.js 18+ on your server
2. Clone the repository
3. Set environment variables
4. Use PM2 or systemd to run the bot:
   ```bash
   npm install -g pm2
   npm run build
   pm2 start dist/index.js --name logic-bot
   ```

5. Set up a reverse proxy (nginx) or use the bot directly on a port
6. Update Slack app URLs to your server URL


## Usage

### Starting a Round

1. Create a thread in an allowed channel
2. Run `/logic` in that thread
3. You become the OP for that round

### Solving a Round

1. Someone posts a guess in the thread
2. OP reacts with :yes: to the guess message
3. Bot sends OP an ephemeral confirmation with buttons
4. OP clicks "Confirm"
5. Bot awards 1 point to the guess author and posts "Solved ✅"

### Commands

- `/logic <question>` - Start a new round with your question
- `/logic help` - Show help message
- `/logic scoreboard` - View scoreboard
- `/logic stats` - Show your stats
- `/logic stats @user` - Show stats for a user

**Note:** If your question includes images, use `/logic <question>` first, then post your images directly in the thread that gets created.

### Admin Commands

- `/logic setscore @user 10` - Set a user's score
- `/logic addpoint @user` - Add 1 point to a user
- `/logic removepoint @user` - Remove 1 point from a user

## Deployment (AWS Lambda + Terraform)

The bot can be deployed to AWS Lambda using Terraform and GitHub Actions CI/CD.

### Prerequisites

1. **AWS Account** with appropriate permissions
2. **GitHub OIDC Setup** for AWS authentication (no long-lived keys needed)
3. **GitHub Secrets** configured (see below)

### GitHub Secrets Required

Configure these secrets in your GitHub repository settings:

- `AWS_REGION` - AWS region (e.g., `us-east-1`)
- `AWS_ROLE_TO_ASSUME` - ARN of IAM role for GitHub OIDC (see setup below)
- `SLACK_BOT_TOKEN` - Slack Bot User OAuth Token (starts with `xoxb-`)
- `SLACK_SIGNING_SECRET` - Slack Signing Secret
- `LOGIC_CHANNEL_ID_MAIN` - Main channel ID where bot operates
- `LOGIC_CHANNEL_ID_TEST` - Test channel ID where bot operates
- `LOGIC_ADMIN_USER_IDS` - Comma-separated admin user IDs (optional)

### Setting up GitHub OIDC for AWS

1. Create an IAM role in AWS with trust policy allowing GitHub OIDC:
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Principal": {
           "Federated": "arn:aws:iam::ACCOUNT_ID:oidc-provider/token.actions.githubusercontent.com"
         },
         "Action": "sts:AssumeRoleWithWebIdentity",
         "Condition": {
           "StringEquals": {
             "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
           },
           "StringLike": {
             "token.actions.githubusercontent.com:sub": "repo:YOUR_GITHUB_ORG/YOUR_REPO:*"
           }
         }
       }
     ]
   }
   ```

2. Attach policies allowing:
   - Lambda function creation/update
   - API Gateway creation/update
   - IAM role creation/update
   - CloudWatch Logs

3. Copy the role ARN to `AWS_ROLE_TO_ASSUME` secret

### Deployment Process

1. Push to `main` branch triggers GitHub Actions workflow
2. Workflow:
   - Builds TypeScript
   - Creates Lambda deployment zip (`dist/lambda.zip`)
   - Runs Terraform to deploy infrastructure
   - Outputs the Slack Request URL

3. **Configure Slack App**:
   - Copy the `slack_request_url` from Terraform output
   - Paste into Slack App settings:
     - **Slash Commands**: Request URL
     - **Interactivity & Shortcuts**: Request URL
     - **Event Subscriptions**: Request URL

### Security Note

**Current Implementation (Simple)**: Secrets are stored as Lambda environment variables. This is acceptable for small internal bots, but note that:
- Secrets appear in Terraform state files (mark as sensitive in variables)
- Secrets are visible in AWS Lambda console
- Consider using AWS Secrets Manager or SSM Parameter Store for production (see below)

**Better Approach (Production)**: Store secrets in AWS Secrets Manager or SSM Parameter Store:
1. Create secrets in AWS Secrets Manager
2. Update Terraform to reference secrets instead of variables
3. Add IAM permissions for Lambda to read secrets
4. Update Lambda code to fetch secrets at runtime

### Local Development

For local development, the bot still runs as a server:

```bash
npm run dev
```

The code automatically detects Lambda vs server mode using `AWS_LAMBDA_FUNCTION_NAME` environment variable.

### Infrastructure Files

- `infra/versions.tf` - Terraform provider configuration
- `infra/variables.tf` - Input variables
- `infra/main.tf` - Lambda, API Gateway, IAM resources
- `infra/outputs.tf` - Outputs including Slack Request URL

## Architecture

### Storage Model

- **Round State**: Stored in bot control messages within threads
  - Format: `[logic_round v1] op=U123 status=OPEN threadTs=1234567890.123456 channelId=C123`
  - Updated when rounds are solved

- **Scoreboard**: Stored as JSON in pinned bot messages
  - One pinned message per channel
  - Updated using `chat.update`
  - Format: JSON with `scores` object and `lastUpdated` timestamp

### Channel Filtering

The bot only operates in channels specified by:
- `LOGIC_CHANNEL_ID_MAIN`
- `LOGIC_CHANNEL_ID_TEST`

All other channels are ignored.

## Troubleshooting

### Bot not responding

1. Check that the bot is running: `npm start`
2. Verify ngrok is running and the URL matches Slack app settings
3. Check environment variables are set correctly
4. Review bot logs for errors

### Commands not working

1. Ensure the slash command is installed in your workspace
2. Check that you're in an allowed channel
3. Verify the Request URL in Slack app settings matches your server

### Scoreboard not updating

1. Check that the bot has `pins:write` permission
2. Verify the bot can post messages in the channel
3. Check logs for errors when updating scoreboard

## License

MIT

