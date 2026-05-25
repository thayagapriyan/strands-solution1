import { Agent, McpTool } from "@aws/strands";

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

  const mcpTools = await McpTool.fromServer({
    command: "node",
    // MCP server is packaged alongside this Lambda under /var/task/mcp-server/
    args: ["/var/task/mcp-server/index.js"],
    env: {
      ...process.env,
      API_URL: process.env.API_URL ?? "",
    },
  });

  const agent = new Agent({
    model: "anthropic.claude-3-5-sonnet-20241022-v2:0",
    apiKey: process.env.ANTHROPIC_API_KEY,
    tools: [...mcpTools],
    systemPrompt: SYSTEM_PROMPT,
  });

  const answer = await agent.process(event.query);
  return { statusCode: 200, body: JSON.stringify({ answer }) };
};
