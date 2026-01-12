# IAM Role for Lambda
resource "aws_iam_role" "lambda_role" {
  name = "${var.app_name}-lambda-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "lambda.amazonaws.com"
        }
      }
    ]
  })
}

# Basic Lambda execution policy (CloudWatch Logs)
resource "aws_iam_role_policy_attachment" "lambda_basic" {
  role       = aws_iam_role.lambda_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# Lambda Function
resource "aws_lambda_function" "logicbot" {
  filename         = var.lambda_zip_path
  function_name    = var.app_name
  role            = aws_iam_role.lambda_role.arn
  handler         = "lambda.handler"
  source_code_hash = filebase64sha256(var.lambda_zip_path)
  runtime         = "nodejs20.x"
  timeout         = 30
  memory_size     = 256

  environment {
    variables = {
      SLACK_BOT_TOKEN        = var.slack_bot_token
      SLACK_SIGNING_SECRET   = var.slack_signing_secret
      LOGIC_CHANNEL_ID_MAIN  = var.logic_channel_id_main
      LOGIC_CHANNEL_ID_TEST  = var.logic_channel_id_test
      LOGIC_ADMIN_USER_IDS   = var.logic_admin_user_ids
    }
  }
}

# API Gateway v2 HTTP API
resource "aws_apigatewayv2_api" "logicbot" {
  name          = var.app_name
  protocol_type = "HTTP"
  description   = "API Gateway for Logic Bot Slack events"
}

# API Gateway Integration
resource "aws_apigatewayv2_integration" "lambda" {
  api_id           = aws_apigatewayv2_api.logicbot.id
  integration_type = "AWS_PROXY"
  integration_uri  = aws_lambda_function.logicbot.invoke_arn
}

# API Gateway Routes
# POST route for Slack events
resource "aws_apigatewayv2_route" "slack_events_post" {
  api_id    = aws_apigatewayv2_api.logicbot.id
  route_key = "POST /slack/events"
  target    = "integrations/${aws_apigatewayv2_integration.lambda.id}"
}

# API Gateway Stage
resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.logicbot.id
  name        = "$default"
  auto_deploy = true
}

# Lambda Permission for API Gateway
resource "aws_lambda_permission" "apigw" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.logicbot.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.logicbot.execution_arn}/*/*"
}
