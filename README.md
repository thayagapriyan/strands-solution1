# StrandCore Inventory Pilot

An AI-powered warehouse management system built on a four-layer architecture: AWS DynamoDB + Lambda (data), MCP Server (protocol adapter), AWS Strands SDK Agent (reasoning), and Terraform (infrastructure-as-code).

---

## Architecture Overview

```
User Query
    │
    ▼
┌─────────────────────────────┐
│  Layer 3: Strands Agent     │  ← "The Brain"
│  (Claude 3.5 Sonnet)        │
│  AWS Lambda (Node.js)       │
└──────────┬──────────────────┘
           │ spawns / calls
           ▼
┌─────────────────────────────┐
│  Layer 2: MCP Server        │  ← "The Adapter"
│  Model Context Protocol     │
│  Wraps REST into tools      │
└──────────┬──────────────────┘
           │ HTTP calls
           ▼
┌─────────────────────────────┐
│  Layer 1: Data API Lambda   │  ← "The Gateway"
│  REST endpoint              │
│  Node.js / TypeScript       │
└──────────┬──────────────────┘
           │ reads/writes
           ▼
┌─────────────────────────────┐
│  AWS DynamoDB               │  ← "The Store"
│  InventoryTable             │
└─────────────────────────────┘

         All provisioned by
┌─────────────────────────────┐
│  Layer 4: Terraform         │  ← "The Blueprint"
└─────────────────────────────┘
```

---

## Project Structure

```
strands-solution1/
├── services/
│   ├── inventory-api/          # Layer 1 — Data REST API
│   │   ├── index.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── mcp-server/             # Layer 2 — MCP Wrapper
│   │   ├── index.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   └── agent/                  # Layer 3 — Strands Agent
│       ├── index.ts
│       ├── package.json
│       └── tsconfig.json
├── infra/                      # Layer 4 — Terraform
│   ├── main.tf
│   ├── iam.tf
│   ├── variables.tf
│   └── outputs.tf
└── README.md
```

---

## Prerequisites

| Tool | Version | Purpose |
|------|---------|---------|
| Node.js | 18.x | Lambda runtime |
| TypeScript | 5.x | Source language |
| AWS CLI | v2 | Deployment |
| Terraform | 1.6+ | Infrastructure |
| AWS Account | — | DynamoDB, Lambda, Bedrock |

Bedrock model access must be enabled for `anthropic.claude-3-5-sonnet-v1:0` in your AWS region.

---

## Layer 1 — Data API (Lambda + DynamoDB)

Private REST gateway that reads inventory from DynamoDB. Never exposed publicly — only the MCP server calls it.

**File:** [services/inventory-api/index.ts](services/inventory-api/index.ts)

```typescript
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);

export const handler = async (event: any) => {
  const productId = event.pathParameters?.id;
  if (!productId) {
    return { statusCode: 400, body: JSON.stringify({ error: "Missing product ID" }) };
  }

  const result = await docClient.send(new GetCommand({
    TableName: process.env.TABLE_NAME ?? "InventoryTable",
    Key: { id: productId }
  }));

  return {
    statusCode: result.Item ? 200 : 404,
    body: JSON.stringify(result.Item ?? { error: "Not found" })
  };
};
```

**DynamoDB schema:**

| Attribute | Type | Role |
|-----------|------|------|
| `id`      | String | Partition key (product SKU) |
| `name`    | String | Product name |
| `count`   | Number | Current stock level |
| `location`| String | Warehouse bin |

---

## Layer 2 — MCP Server (Protocol Adapter)

Wraps the REST API into [Model Context Protocol](https://modelcontextprotocol.io) tools so the Strands agent can discover and call them without knowing HTTP details.

**File:** [services/mcp-server/index.ts](services/mcp-server/index.ts)

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import axios from "axios";

const server = new McpServer({ name: "InventoryMCP", version: "1.0.0" });

const API_URL = process.env.API_URL;

server.tool(
  "check_stock",
  "Check current stock levels for a product by its ID",
  { productId: z.string().describe("The product SKU to query") },
  async ({ productId }) => {
    const { data } = await axios.get(`${API_URL}/stock/${productId}`);
    const count = data.count ?? 0;
    const status = count < 10 ? "LOW STOCK" : "OK";
    return {
      content: [{
        type: "text",
        text: `Product ${productId} | Stock: ${count} | Status: ${status}`
      }]
    };
  }
);

server.tool(
  "list_low_stock",
  "List all products with stock below a given threshold",
  { threshold: z.number().default(10).describe("Minimum acceptable stock level") },
  async ({ threshold }) => {
    const { data } = await axios.get(`${API_URL}/stock?maxCount=${threshold}`);
    const items = data.items ?? [];
    const summary = items.map((i: any) => `${i.id}: ${i.count}`).join("\n");
    return {
      content: [{
        type: "text",
        text: items.length ? `Low stock items:\n${summary}` : "All stock levels are healthy."
      }]
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
```

---

## Layer 3 — Strands Agent (The Brain)

Loads MCP tools at runtime and uses Claude 3.5 Sonnet to reason over natural-language warehouse queries.

**File:** [services/agent/index.ts](services/agent/index.ts)

```typescript
import { Agent, McpTool } from '@aws/strands';

export const handler = async (event: { query: string }) => {
  const mcpTools = await McpTool.fromServer({
    command: "node",
    args: ["/var/task/mcp-server/index.js"],
    env: { API_URL: process.env.API_URL ?? "" }
  });

  const agent = new Agent({
    model: 'anthropic.claude-3-5-sonnet',
    apiKey: process.env.ANTHROPIC_API_KEY,
    tools: [...mcpTools],
    systemPrompt: `You are a warehouse manager AI. Use your tools to answer stock queries accurately.
Always state the stock count and whether it is LOW or OK.
If stock is low, recommend restocking.`
  });

  const response = await agent.process(event.query);
  return { statusCode: 200, body: JSON.stringify({ answer: response }) };
};
```

---

## Layer 4 — Terraform Infrastructure

**File:** [infra/main.tf](infra/main.tf)

```hcl
# DynamoDB Table
resource "aws_dynamodb_table" "inventory" {
  name         = "InventoryTable"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "id"
  attribute { name = "id"; type = "S" }

  tags = { Project = "StrandCoreInventoryPilot" }
}

# Data API Lambda
resource "aws_lambda_function" "api" {
  function_name = "inventory-api"
  role          = aws_iam_role.lambda_role.arn
  handler       = "index.handler"
  runtime       = "nodejs18.x"
  filename      = "${path.module}/../dist/api.zip"

  environment {
    variables = { TABLE_NAME = aws_dynamodb_table.inventory.name }
  }
}

# Lambda Function URL (private — no auth header = 403)
resource "aws_lambda_function_url" "api_url" {
  function_name      = aws_lambda_function.api.function_name
  authorization_type = "AWS_IAM"
}

# Strands Agent Lambda
resource "aws_lambda_function" "agent" {
  function_name = "strands-agent"
  role          = aws_iam_role.agent_role.arn
  handler       = "index.handler"
  runtime       = "nodejs18.x"
  filename      = "${path.module}/../dist/agent.zip"
  timeout       = 60

  environment {
    variables = {
      API_URL            = aws_lambda_function_url.api_url.function_url
      ANTHROPIC_API_KEY  = var.anthropic_api_key
    }
  }
}

# Bedrock AgentCore Deployment
resource "aws_bedrockagent_agent" "strands_agent" {
  agent_name       = "StrandCoreInventoryPilot"
  foundation_model = "anthropic.claude-3-5-sonnet-v1:0"
  role_arn         = aws_iam_role.bedrock_agent_role.arn
  instruction      = "Manage warehouse inventory. Always use tools to look up real data before answering."

  action_group {
    action_group_name = "InventoryActions"
    action_group_executor {
      lambda = aws_lambda_function.agent.arn
    }
    description = "Tools for querying and managing warehouse stock levels"
  }
}
```

**File:** [infra/iam.tf](infra/iam.tf)

```hcl
# Lambda execution role (Data API)
resource "aws_iam_role" "lambda_role" {
  name               = "inventory-api-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy" "lambda_dynamodb" {
  role = aws_iam_role.lambda_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:Scan"]
      Resource = aws_dynamodb_table.inventory.arn
    }]
  })
}

# Agent Lambda role
resource "aws_iam_role" "agent_role" {
  name               = "strands-agent-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy" "agent_bedrock" {
  role = aws_iam_role.agent_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["bedrock:InvokeModel"]
        Resource = "arn:aws:bedrock:*::foundation-model/anthropic.claude-3-5-sonnet-v1:0"
      },
      {
        Effect   = "Allow"
        Action   = ["lambda:InvokeFunction"]
        Resource = aws_lambda_function.api.arn
      }
    ]
  })
}

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}
```

---

## CI / CD (GitHub Actions)

Two workflows live in [.github/workflows/](.github/workflows/):

| Workflow | Trigger | What it does |
|----------|---------|--------------|
| [ci.yml](.github/workflows/ci.yml) | Every PR + push to `main` | Type-check, lint, `terraform validate` |
| [deploy.yml](.github/workflows/deploy.yml) | Push to `main` or manual dispatch | Build → package ZIPs → `terraform apply` → smoke test |

### Required GitHub Secrets & Variables

Go to **Settings → Secrets and variables → Actions** and add:

| Name | Kind | Description |
|------|------|-------------|
| `ANTHROPIC_API_KEY` | Secret | Claude API key |
| `AWS_ACCESS_KEY_ID` | Secret | IAM key (skip if using OIDC) |
| `AWS_SECRET_ACCESS_KEY` | Secret | IAM secret (skip if using OIDC) |
| `AWS_ROLE_ARN` | Variable | IAM role for OIDC auth (recommended) |
| `AWS_REGION` | Variable | e.g. `us-east-1` |

**OIDC (recommended over long-lived keys):** Set `AWS_ROLE_ARN` in Variables and add this trust policy to the IAM role:

```json
{
  "Effect": "Allow",
  "Principal": { "Federated": "arn:aws:iam::<ACCOUNT_ID>:oidc-provider/token.actions.githubusercontent.com" },
  "Action": "sts:AssumeRoleWithWebIdentity",
  "Condition": {
    "StringEquals": { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
    "StringLike": { "token.actions.githubusercontent.com:sub": "repo:<ORG>/<REPO>:*" }
  }
}
```

### Terraform Remote State (required for CI)

Add this backend block to [infra/main.tf](infra/main.tf) before running the pipeline:

```hcl
terraform {
  backend "s3" {
    bucket         = "<your-tfstate-bucket>"
    key            = "warewise/terraform.tfstate"
    region         = "us-east-1"
    dynamodb_table = "<your-lock-table>"   # prevents concurrent applies
    encrypt        = true
  }
}
```

### Manual deploy with dry-run

The deploy workflow supports `workflow_dispatch` with two inputs:
- **environment** — `production` or `staging`
- **dry_run** — runs `terraform plan` only, skips apply and smoke test

---

## Local Build & Deploy

```bash
# 1. Install dependencies for all services
cd services/inventory-api && npm install
cd ../mcp-server && npm install
cd ../agent && npm install

# 2. Compile TypeScript
cd ../../
npx tsc -p services/inventory-api/tsconfig.json
npx tsc -p services/mcp-server/tsconfig.json
npx tsc -p services/agent/tsconfig.json

# 3. Package for Lambda (the agent bundle must include the compiled MCP server)
mkdir -p dist
zip -j dist/api.zip services/inventory-api/dist/index.js
zip -r dist/agent.zip services/agent/dist/ services/mcp-server/dist/

# 4. Deploy infrastructure
cd infra
terraform init
terraform plan -var="anthropic_api_key=$ANTHROPIC_API_KEY"
terraform apply -var="anthropic_api_key=$ANTHROPIC_API_KEY"
```

---

## Testing

**Direct agent invocation via AWS CLI:**

```bash
aws lambda invoke \
  --function-name strands-agent \
  --payload '{"query": "How many units of product SKU-123 are left?"}' \
  response.json && cat response.json
```

**Expected response:**

```json
{
  "statusCode": 200,
  "body": "{\"answer\": \"Product SKU-123 currently has 47 units in stock. Status: OK.\"}"
}
```

**Low-stock scenario:**

```bash
aws lambda invoke \
  --function-name strands-agent \
  --payload '{"query": "Which products need restocking?"}' \
  response.json && cat response.json
```

---

## Environment Variables

| Variable | Service | Description |
|----------|---------|-------------|
| `TABLE_NAME` | inventory-api | DynamoDB table name |
| `API_URL` | mcp-server, agent | Lambda function URL for the Data API |
| `ANTHROPIC_API_KEY` | agent | Claude API key for Strands |

---

## Key Design Decisions

- **MCP as the integration layer** — the agent never knows HTTP. It only sees named tools. Swapping the backend (DynamoDB → RDS, REST → GraphQL) requires only changing the MCP server, not the agent.
- **Lambda Function URL with IAM auth** — the Data API is not on API Gateway. It uses a private function URL that only the agent Lambda role can call, keeping blast radius minimal.
- **Strands agent runs inside Lambda** — no persistent server to manage. The agent Lambda is invoked on demand via Bedrock AgentCore, and the MCP server is spawned as a subprocess per invocation.
- **Terraform manages Bedrock AgentCore** — the `aws_bedrockagent_agent` resource ties the Strands Lambda to Bedrock's managed agent runtime, giving you versioning, aliases, and CloudWatch tracing for free.

---

## License

MIT
