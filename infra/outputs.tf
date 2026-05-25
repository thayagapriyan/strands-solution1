output "api_function_url" {
  description = "Private IAM-authenticated Lambda function URL for the inventory API"
  value       = aws_lambda_function_url.api_url.function_url
}

output "agent_function_arn" {
  description = "ARN of the Strands agent Lambda"
  value       = aws_lambda_function.agent.arn
}

output "agent_function_name" {
  description = "Name of the Strands agent Lambda (used by the smoke test)"
  value       = aws_lambda_function.agent.function_name
}

output "bedrock_agent_id" {
  description = "Bedrock AgentCore agent ID"
  value       = aws_bedrockagent_agent.strands_agent.agent_id
}

output "dynamodb_table_name" {
  description = "Name of the DynamoDB inventory table"
  value       = aws_dynamodb_table.inventory.name
}
