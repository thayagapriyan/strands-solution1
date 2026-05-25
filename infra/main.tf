terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  # Values are passed at init time: terraform init -backend-config=backend.hcl
  # In CI, GitHub Actions variables TF_STATE_BUCKET and TF_STATE_LOCK_TABLE are used.
  # Run infra/bootstrap first to create the bucket and lock table.
  backend "s3" {}
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = var.project_name
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}

locals {
  dist_path = "${path.module}/../dist"

  # Sample inventory data. count uses ignore_changes so live stock isn't reset on re-apply.
  seed_items = {
    "SKU-001" = { name = "Widget Pro", count = 150, location = "A-01", category = "Components" }
    "SKU-002" = { name = "Bolt Set M8", count = 8, location = "B-12", category = "Fasteners" }
    "SKU-003" = { name = "Safety Gloves L", count = 45, location = "C-03", category = "PPE" }
    "SKU-004" = { name = "Power Cable 5m", count = 3, location = "D-07", category = "Electrical" }
    "SKU-005" = { name = "Shelf Bracket Heavy", count = 72, location = "A-15", category = "Hardware" }
    "SKU-006" = { name = "Safety Vest XL", count = 6, location = "C-08", category = "PPE" }
    "SKU-007" = { name = "Packing Tape Roll", count = 200, location = "E-02", category = "Packaging" }
    "SKU-008" = { name = "Forklift Battery", count = 2, location = "F-01", category = "Equipment" }
  }
}

# ── DynamoDB ──────────────────────────────────────────────────

resource "aws_dynamodb_table" "inventory" {
  name         = "${var.project_name}-inventory"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "id"

  attribute {
    name = "id"
    type = "S"
  }

  point_in_time_recovery {
    enabled = true
  }
}

resource "aws_dynamodb_table_item" "seed" {
  for_each   = local.seed_items
  table_name = aws_dynamodb_table.inventory.name
  hash_key   = aws_dynamodb_table.inventory.hash_key

  item = jsonencode({
    id       = { S = each.key }
    name     = { S = each.value.name }
    count    = { N = tostring(each.value.count) }
    location = { S = each.value.location }
    category = { S = each.value.category }
  })

  lifecycle {
    # Don't reset live stock counts when re-applying infrastructure changes
    ignore_changes = [item]
  }
}

# ── Data API Lambda ───────────────────────────────────────────

resource "aws_lambda_function" "api" {
  function_name    = "${var.project_name}-inventory-api"
  role             = aws_iam_role.api_lambda_role.arn
  handler          = "index.handler"
  runtime          = "nodejs18.x"
  filename         = "${local.dist_path}/api.zip"
  source_code_hash = fileexists("${local.dist_path}/api.zip") ? filebase64sha256("${local.dist_path}/api.zip") : ""
  timeout          = 10
  memory_size      = 256

  environment {
    variables = {
      TABLE_NAME = aws_dynamodb_table.inventory.name
    }
  }
}

resource "aws_lambda_function_url" "api_url" {
  function_name      = aws_lambda_function.api.function_name
  authorization_type = "AWS_IAM"
}

resource "aws_cloudwatch_log_group" "api_logs" {
  name              = "/aws/lambda/${aws_lambda_function.api.function_name}"
  retention_in_days = 7
}

# ── Strands Agent Lambda ──────────────────────────────────────

resource "aws_lambda_function" "agent" {
  function_name    = "${var.project_name}-strands-agent"
  role             = aws_iam_role.agent_lambda_role.arn
  handler          = "index.handler"
  runtime          = "nodejs18.x"
  filename         = "${local.dist_path}/agent.zip"
  source_code_hash = fileexists("${local.dist_path}/agent.zip") ? filebase64sha256("${local.dist_path}/agent.zip") : ""
  timeout          = 60
  memory_size      = 512

  environment {
    variables = {
      API_URL           = aws_lambda_function_url.api_url.function_url
      ANTHROPIC_API_KEY = var.anthropic_api_key
    }
  }
}

resource "aws_cloudwatch_log_group" "agent_logs" {
  name              = "/aws/lambda/${aws_lambda_function.agent.function_name}"
  retention_in_days = 7
}

resource "aws_lambda_permission" "bedrock_invoke_agent" {
  statement_id  = "AllowBedrockInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.agent.function_name
  principal     = "bedrock.amazonaws.com"
}

# ── Bedrock AgentCore ─────────────────────────────────────────

resource "aws_bedrockagent_agent" "strands_agent" {
  agent_name              = "${var.project_name}-agent"
  foundation_model        = "us.anthropic.claude-3-5-sonnet-20241022-v2:0"
  agent_resource_role_arn = aws_iam_role.bedrock_agent_role.arn
  instruction             = "You manage warehouse inventory. Always use tools to retrieve real stock data before answering."
}

resource "aws_bedrockagent_agent_action_group" "inventory_actions" {
  action_group_name = "InventoryActions"
  agent_id          = aws_bedrockagent_agent.strands_agent.agent_id
  agent_version     = "DRAFT"
  description       = "Tools for querying and managing warehouse stock levels"

  action_group_executor {
    lambda = aws_lambda_function.agent.arn
  }

  function_schema {
    member_functions {
      functions {
        name        = "query_warehouse"
        description = "Answer a natural-language question about warehouse stock levels by invoking the Strands agent Lambda."

        parameters {
          map_block_key = "query"
          type          = "string"
          description   = "The natural-language question about inventory (e.g. 'Is SKU-001 in stock?')."
          required      = true
        }
      }
    }
  }
}
