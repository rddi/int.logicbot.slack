output "slack_request_url" {
  description = "Slack Request URL to configure in Slack App settings"
  value       = "${aws_apigatewayv2_api.logicbot.api_endpoint}/slack/events"
}

output "api_endpoint" {
  description = "API Gateway endpoint URL"
  value       = aws_apigatewayv2_api.logicbot.api_endpoint
}

output "lambda_function_name" {
  description = "Lambda function name"
  value       = aws_lambda_function.logicbot.function_name
}
