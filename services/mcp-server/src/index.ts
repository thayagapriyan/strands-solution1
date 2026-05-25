import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import axios from "axios";
import { SignatureV4 } from "@aws-sdk/signature-v4";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { Sha256 } from "@aws-crypto/sha256-js";
import { HttpRequest } from "@smithy/protocol-http";

const API_URL = process.env.API_URL?.replace(/\/+$/, "");
if (!API_URL) throw new Error("API_URL environment variable is required");

const signer = new SignatureV4({
  service: "lambda",
  region: process.env.AWS_REGION ?? "us-east-1",
  credentials: defaultProvider(),
  sha256: Sha256,
});

async function signedGet<T>(url: string): Promise<T> {
  const u = new URL(url);
  const query: Record<string, string> = {};
  u.searchParams.forEach((value, key) => {
    query[key] = value;
  });

  const signed = await signer.sign(
    new HttpRequest({
      method: "GET",
      protocol: u.protocol,
      hostname: u.hostname,
      path: u.pathname,
      query,
      headers: { host: u.hostname },
    })
  );

  console.error(
    "[mcp] signing:",
    JSON.stringify({
      url,
      region: process.env.AWS_REGION,
      pathname: u.pathname,
      query,
      signedHeaders: Object.keys(signed.headers),
      hasAccessKey: !!process.env.AWS_ACCESS_KEY_ID,
      hasSessionToken: !!process.env.AWS_SESSION_TOKEN,
    })
  );

  const response = await axios.get<T>(url, {
    headers: signed.headers as Record<string, string>,
    validateStatus: () => true,
  });

  console.error(
    "[mcp] response:",
    JSON.stringify({
      url,
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      data: response.data,
    })
  );

  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      `Inventory API ${response.status}: ${JSON.stringify(response.data)}`
    );
  }
  return response.data;
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
    const data = await signedGet<StockItem>(`${API_URL}/stock/${productId}`);
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
    const data = await signedGet<{ items: StockItem[] }>(`${API_URL}/stock?maxCount=${threshold}`);

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
