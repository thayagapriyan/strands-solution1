import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";

const API_FUNCTION_NAME = process.env.API_FUNCTION_NAME;
if (!API_FUNCTION_NAME) throw new Error("API_FUNCTION_NAME environment variable is required");

const lambda = new LambdaClient({});

interface ApiResponse {
  statusCode: number;
  body: string;
}

async function callApi<T>(
  path: string,
  queryStringParameters: Record<string, string> | null = null
): Promise<T> {
  const payload = JSON.stringify({ path, queryStringParameters });

  const result = await lambda.send(
    new InvokeCommand({
      FunctionName: API_FUNCTION_NAME,
      InvocationType: "RequestResponse",
      Payload: payload,
    })
  );

  const rawPayload = result.Payload ? Buffer.from(result.Payload).toString("utf-8") : "";

  if (result.FunctionError) {
    throw new Error(`Inventory Lambda ${result.FunctionError}: ${rawPayload}`);
  }

  const apiResp = JSON.parse(rawPayload) as ApiResponse;
  if (apiResp.statusCode < 200 || apiResp.statusCode >= 300) {
    throw new Error(`Inventory API ${apiResp.statusCode}: ${apiResp.body}`);
  }
  return JSON.parse(apiResp.body) as T;
}

interface StockItem {
  id: string;
  name: string;
  count: number;
}

const server = new McpServer({ name: "InventoryMCP", version: "1.0.0" });

server.tool(
  "check_stock",
  "Check current stock level for a product by its SKU",
  { productId: z.string().describe("The product SKU to query") },
  async ({ productId }) => {
    try {
      const data = await callApi<StockItem>(`/stock/${productId}`);
      const status = data.count < 10 ? "LOW STOCK — reorder needed" : "OK";
      return {
        content: [{ type: "text", text: `Product ${productId} | Count: ${data.count} | Status: ${status}` }],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text", text: `TOOL_ERROR: ${msg}` }] };
    }
  }
);

server.tool(
  "list_low_stock",
  "List all products with stock below a threshold",
  { threshold: z.number().int().min(0).default(10).describe("Max acceptable stock level") },
  async ({ threshold }) => {
    try {
      const data = await callApi<{ items: StockItem[] }>("/stock", { maxCount: String(threshold) });

      if (data.items.length === 0) {
        return { content: [{ type: "text", text: "All products are adequately stocked." }] };
      }

      const rows = data.items
        .map((i) => `• ${i.id} (${i.name ?? "unknown"}): ${i.count} units`)
        .join("\n");

      return {
        content: [{ type: "text", text: `Low-stock products (< ${threshold} units):\n${rows}` }],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text", text: `TOOL_ERROR: ${msg}` }] };
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("MCP server fatal error:", err);
  process.exit(1);
});
