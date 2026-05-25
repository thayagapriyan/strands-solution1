import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";

const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE_NAME = process.env.TABLE_NAME ?? "InventoryTable";

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const path = event.path ?? "";
  const stockById = path.match(/^\/stock\/([^/]+)$/);

  if (stockById) {
    return getStock(stockById[1]);
  }
  if (path === "/stock") {
    const maxCount = parseInt(event.queryStringParameters?.maxCount ?? "10", 10);
    return listLowStock(maxCount);
  }

  return respond(404, { error: "Route not found" });
};

async function getStock(productId: string): Promise<APIGatewayProxyResult> {
  const result = await docClient.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { id: productId } })
  );

  if (!result.Item) {
    return respond(404, { error: "Product not found" });
  }
  return respond(200, result.Item);
}

async function listLowStock(threshold: number): Promise<APIGatewayProxyResult> {
  const result = await docClient.send(
    new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: "#cnt < :threshold",
      ExpressionAttributeNames: { "#cnt": "count" },
      ExpressionAttributeValues: { ":threshold": threshold },
    })
  );

  return respond(200, { items: result.Items ?? [] });
}

function respond(statusCode: number, body: unknown): APIGatewayProxyResult {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}
