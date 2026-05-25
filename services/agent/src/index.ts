import { Agent, McpClient } from "@strands-agents/sdk";
import { AnthropicModel } from "@strands-agents/sdk/models/anthropic";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

interface AgentEvent {
  query: string;
}

interface AgentResponse {
  statusCode: number;
  body: string;
}

const SYSTEM_PROMPT = `You are a warehouse management AI assistant.

Rules:
- Always call a tool to fetch real data — never guess or estimate stock levels.
- State the exact count, the status (OK or LOW STOCK), and the product name.
- If any product is low on stock (< 10 units), recommend restocking it.
- Be concise and factual.`;

export const handler = async (event: AgentEvent): Promise<AgentResponse> => {
  if (!event.query?.trim()) {
    return { statusCode: 400, body: JSON.stringify({ error: "query field is required" }) };
  }

  const mcpClient = new McpClient({
    transport: new StdioClientTransport({
      command: "node",
      // MCP server is packaged alongside this Lambda under /var/task/mcp-server/
      args: ["/var/task/mcp-server/index.js"],
      env: { ...(process.env as Record<string, string>), API_URL: process.env.API_URL ?? "" },
    }),
  });

  const model = new AnthropicModel({
    modelId: "claude-3-5-sonnet-20241022",
    apiKey: process.env.ANTHROPIC_API_KEY,
  });

  const agent = new Agent({
    model,
    tools: [mcpClient],
    systemPrompt: SYSTEM_PROMPT,
  });

  const result = await agent.invoke(event.query);
  const answer = result.lastMessage.content
    .filter((block) => "text" in block)
    .map((block) => (block as { text: string }).text)
    .join("");

  await mcpClient.disconnect();

  return { statusCode: 200, body: JSON.stringify({ answer }) };
};
