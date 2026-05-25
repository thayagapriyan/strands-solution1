# Architecture

End-to-end logic flow of the Warewise (Strands + MCP + Inventory API) solution.

## High-level diagram

```
┌──────────────────────────────────────────────────────────────────────┐
│                          USER / CLIENT                               │
│                  (REST API call: "Is SKU-001 in stock?")             │
└────────────────────────────────┬─────────────────────────────────────┘
                                 │
                                 ▼
              ┌─────────────────────────────────────┐
              │     AWS BEDROCK AGENT (optional     │
              │     entry point — Claude Sonnet 4.5)│
              │  Action group: "query_warehouse"    │
              └─────────────────┬───────────────────┘
                                │  (or invoked directly)
                                ▼
        ┌──────────────────────────────────────────────────┐
        │   LAMBDA #1: strands-agent  (nodejs20.x, ESM)    │
        │   services/agent/src/index.ts                    │
        │                                                  │
        │   handler(event.query) →                         │
        │     1. spawn child process (stdio)               │
        │     2. build Strands Agent w/ AnthropicModel     │
        │     3. agent.invoke(query)                       │
        │     4. return { statusCode, body: { answer } }   │
        └──────┬──────────────────────────────┬────────────┘
               │                              │
               │ (1) stdio pipe               │ (2) HTTPS
               │     child process            │     Anthropic API
               ▼                              ▼
   ┌─────────────────────────────┐   ┌─────────────────────────────┐
   │  MCP SERVER (child proc)    │   │   ANTHROPIC API (cloud)     │
   │  /var/task/mcp-server/      │   │   claude-sonnet-4-6         │
   │     index.js  (CJS)         │   │                             │
   │                             │   │  - receives query +         │
   │  Exposes 2 tools:           │   │    tool schemas             │
   │   • check_stock(productId)  │   │  - decides to call tool     │
   │   • list_low_stock(thresh)  │   │  - returns tool_use blocks  │
   │                             │   │  - receives tool_result     │
   │  Reads tool calls from      │   │  - returns final text       │
   │  stdin, writes results to   │   └─────────────────────────────┘
   │  stdout (JSON-RPC over MCP) │
   └──────────────┬──────────────┘
                  │  AWS SDK: lambda.send(InvokeCommand)
                  │  Payload: { path: "/stock/{id}",
                  │             queryStringParameters: {...} | null }
                  ▼
   ┌──────────────────────────────────────────────┐
   │  LAMBDA #2: inventory-api  (nodejs20.x)      │
   │  services/inventory-api/src/index.ts         │
   │                                              │
   │  Two invocation paths exist:                 │
   │   A) Direct invoke (used by the agent above) │
   │   B) Function URL HTTPS (AWS_IAM auth) ←─── used by Postman/curl
   │                                              │
   │   /stock/{id}     → DynamoDB GetItem         │
   │   /stock?maxCount → DynamoDB Scan            │
   └──────────────────────┬───────────────────────┘
                          │
                          ▼
              ┌────────────────────────┐
              │  DynamoDB              │
              │  warewise-inventory    │
              │  PK = id (SKU-xxx)     │
              │  attrs: name, count,   │
              │         location, cat. │
              └────────────────────────┘
```

## Logic flow — one request, step-by-step

1. **Caller** sends `{"query": "Is SKU-001 in stock?"}` to the agent Lambda (either directly via `aws lambda invoke`, or through the Bedrock Agent action group in [infra/main.tf](infra/main.tf)).

2. **Agent Lambda warm-up** ([services/agent/src/index.ts](services/agent/src/index.ts)):
   - Constructs an `McpClient` whose transport spawns `node /var/task/mcp-server/index.js` as a child process. `API_URL` is forwarded into the child's env.
   - Constructs an `AnthropicModel` with the configured Claude model and the `ANTHROPIC_API_KEY` env var.
   - Wires them into a Strands `Agent` along with the system prompt ("warehouse assistant — always call tools, never guess").

3. **MCP handshake**: Strands SDK opens the stdio pipe to the child. The child ([services/mcp-server/src/index.ts](services/mcp-server/src/index.ts)) calls `server.connect(new StdioServerTransport())` and the two sides exchange tool-list metadata. The agent now knows about `check_stock` and `list_low_stock`.

4. **`agent.invoke(query)`** — the agent loop begins:
   - **Turn 1:** sends `{system prompt, user query, tool schemas}` to the Anthropic API. Claude returns a `tool_use` block: `check_stock({productId: "SKU-001"})`.
   - **Tool dispatch:** Strands routes the `tool_use` over the MCP stdio pipe to the child. The child's `check_stock` handler invokes the inventory Lambda directly with the AWS SDK: `lambda.send(new InvokeCommand({ FunctionName: API_FUNCTION_NAME, Payload: '{"path":"/stock/SKU-001","queryStringParameters":null}' }))`.

5. **Inventory API Lambda** ([services/inventory-api/src/index.ts](services/inventory-api/src/index.ts)):
   - Handler receives the `APIGatewayProxyEvent`-shaped payload (same shape whether invoked directly or via the Function URL), matches path `/stock/SKU-001`, calls DynamoDB `GetItem` on `warewise-inventory`, returns `{statusCode: 200, body: "{...}"}`.

6. **Back up the chain:** MCP server formats the result as `Product SKU-001 | Count: 150 | Status: OK`, writes it to stdout. Strands wraps it as a `tool_result` content block.

7. **Turn 2 to Anthropic:** Strands sends the conversation including the `tool_result`. Claude composes the final natural-language answer: *"SKU-001 (Widget Pro) has 150 units in stock — OK."*

8. **Agent returns** the text in `{statusCode: 200, body: {"answer": "..."}}`. `mcpClient.disconnect()` kills the child process.

## Build & deploy pipeline

How the pieces get to `/var/task/` inside the Lambda containers.

```
   GitHub push  ──► .github/workflows/deploy.yml
                       │
                       ▼
   ┌─────────────────────────────────────────────────┐
   │ Job 1: build (matrix)                           │
   │   - npm ci + tsc per service → dist/            │
   ├─────────────────────────────────────────────────┤
   │ Job 2: package                                  │
   │   - api.zip      = inventory-api/dist           │
   │   - agent.zip    = agent/dist                   │
   │                  + agent/node_modules           │
   │                  + mcp-server/dist  (nested)    │
   │                  + mcp-server/node_modules      │
   │                  + {"type":"commonjs"} override │
   │                    for the nested mcp-server    │
   │                    (parent agent is ESM)        │
   ├─────────────────────────────────────────────────┤
   │ Job 3: terraform apply → updates both Lambdas   │
   ├─────────────────────────────────────────────────┤
   │ Job 4: smoke test → aws lambda invoke           │
   └─────────────────────────────────────────────────┘
```

## Why two Lambdas + a child process

- **Separation of concerns:** the inventory API is a plain CRUD-over-DynamoDB service. Anything can call it (other agents, dashboards, manual tools). It has no LLM knowledge.
- **MCP as the tool boundary:** the agent doesn't know about HTTP, DynamoDB, or SKUs — it only knows two MCP tools. Swap DynamoDB for SQL tomorrow and only the MCP server changes.
- **Why a child process at all (not just `axios` in the agent)?** Because the MCP protocol is the contract Strands consumes. If you later move the MCP server out to its own host (or use one written by someone else), the agent code doesn't change.

## Environment wiring

| Variable | Set in | Consumed by |
|---|---|---|
| `ANTHROPIC_API_KEY` | Terraform `var.anthropic_api_key` → agent Lambda env ([infra/main.tf](infra/main.tf)) | Strands AnthropicModel |
| `API_FUNCTION_NAME` | Inventory Lambda's name → agent Lambda env → forwarded to MCP child ([services/agent/src/index.ts](services/agent/src/index.ts)) | MCP server's `LambdaClient.invoke` call |
| `TABLE_NAME` | DynamoDB table name → inventory-api env ([infra/main.tf](infra/main.tf)) | Inventory API DDB client |

## How to test each piece

### 1. Agent Lambda (end-to-end via Postman)

**POST** `https://lambda.us-east-1.amazonaws.com/2015-03-31/functions/warewise-strands-agent/invocations`

- Auth tab → type **AWS Signature**
  - AccessKey / SecretKey: your IAM user keys (or session creds)
  - AWS Region: `us-east-1`
  - Service Name: `lambda`
- Headers: `Content-Type: application/x-amz-json-1.0`
- Body (raw / JSON):
  ```json
  { "query": "Is SKU-001 in stock?" }
  ```

Response shape:
```json
{ "statusCode": 200, "body": "{\"answer\":\"SKU-001 (Widget Pro) has 150 units in stock — OK.\"}" }
```

CLI equivalent:
```bash
aws lambda invoke \
  --function-name warewise-strands-agent \
  --payload '{"query":"Is SKU-001 in stock?"}' \
  --cli-binary-format raw-in-base64-out \
  response.json && cat response.json
```

### 2. Inventory API directly (bypass the agent)

**Option A — Function URL (REST, IAM-signed).** Get the URL with:
```bash
aws lambda get-function-url-config --function-name warewise-inventory-api --query FunctionUrl --output text
```

**GET** `{FUNCTION_URL}/stock/SKU-001`

- Auth tab → **AWS Signature**
  - Service Name: `lambda`
  - Region: `us-east-1`
  - Same access/secret as above

Response: `{"id":"SKU-001","name":"Widget Pro","count":150,...}`

For low-stock list: **GET** `{FUNCTION_URL}/stock?maxCount=10`

**Option B — Direct Lambda invoke (mirrors what the MCP server does).** POST to `https://lambda.us-east-1.amazonaws.com/2015-03-31/functions/warewise-inventory-api/invocations` with AWS Signature auth and body:
```json
{ "path": "/stock/SKU-001", "queryStringParameters": null }
```
or for the low-stock list:
```json
{ "path": "/stock", "queryStringParameters": { "maxCount": "10" } }
```

CLI:
```bash
aws lambda invoke \
  --function-name warewise-inventory-api \
  --payload '{"path":"/stock/SKU-001","queryStringParameters":null}' \
  --cli-binary-format raw-in-base64-out \
  response.json && cat response.json
```

## Known issues / follow-ups

- **Model IDs need periodic refresh:** the Anthropic API retires old model IDs (e.g. `claude-3-5-sonnet-20241022` started returning 404 once Claude 4.x rolled out). When you see a `not_found_error` for the model, bump to the current latest in [services/agent/src/index.ts](services/agent/src/index.ts).
