import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import axios from "axios";

const API_URL = process.env.API_URL;
if (!API_URL) throw new Error("API_URL environment variable is required");

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
    const { data } = await axios.get<StockItem>(`${API_URL}/stock/${productId}`);
    const status = data.count < 10 ? "LOW STOCK — reorder needed" : "OK";
    return {
      content: [{ type: "text", text: `Product ${productId} | Count: ${data.count} | Status: ${status}` }],
    };
  }
);

server.tool(
  "list_low_stock",
  "List all products with stock below a threshold",
  { threshold: z.number().int().min(0).default(10).describe("Max acceptable stock level") },
  async ({ threshold }) => {
    const { data } = await axios.get<{ items: StockItem[] }>(`${API_URL}/stock?maxCount=${threshold}`);

    if (data.items.length === 0) {
      return { content: [{ type: "text", text: "All products are adequately stocked." }] };
    }

    const rows = data.items
      .map((i) => `• ${i.id} (${i.name ?? "unknown"}): ${i.count} units`)
      .join("\n");

    return {
      content: [{ type: "text", text: `Low-stock products (< ${threshold} units):\n${rows}` }],
    };
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
