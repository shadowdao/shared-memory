import { tools, toolMap, type ToolResult } from "./tools";
import type { UserContext } from "./context";

/**
 * Minimal JSON-RPC 2.0 dispatcher that implements the MCP wire protocol over
 * HTTP. We intentionally don't depend on the SDK's `StreamableHTTPServerTransport`
 * here because Next.js App Router uses Web `Request`/`Response`, not Node's
 * `IncomingMessage`/`ServerResponse`, and a hand-rolled handler is simpler than
 * a Node-stream shim. The protocol surface we cover for Phase 1 is:
 *   - `initialize`            — handshake
 *   - `notifications/initialized` — ack (no response)
 *   - `tools/list`            — enumerate tools
 *   - `tools/call`            — invoke a tool
 *   - `ping`                  — liveness
 *
 * If we later need server-initiated events (notifications, sampling), we'll
 * graduate to SSE responses; for now the protocol works as plain POST/JSON.
 */

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = {
  name: "shared-memory",
  version: "0.1.0",
};

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
}

interface JsonRpcError {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: { code: number; message: string; data?: unknown };
}

type JsonRpcResponse = JsonRpcSuccess | JsonRpcError;

// JSON-RPC standard codes; MCP also defines server-error codes from -32000.
const RPC = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

function makeError(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcError {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined && { data }) } };
}

function makeSuccess(id: JsonRpcId, result: unknown): JsonRpcSuccess {
  return { jsonrpc: "2.0", id, result };
}

function isNotification(req: JsonRpcRequest): boolean {
  return req.id === undefined;
}

export async function dispatchMcpMessage(
  message: unknown,
  ctx: UserContext,
): Promise<JsonRpcResponse | null> {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return makeError(null, RPC.INVALID_REQUEST, "request must be a JSON object");
  }

  const req = message as JsonRpcRequest;
  if (req.jsonrpc !== "2.0" || typeof req.method !== "string") {
    return makeError(req.id ?? null, RPC.INVALID_REQUEST, "invalid jsonrpc envelope");
  }

  const id = req.id ?? null;
  const notification = isNotification(req);

  try {
    switch (req.method) {
      case "initialize":
        return makeSuccess(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
        });

      case "notifications/initialized":
        // No response for notifications.
        return null;

      case "ping":
        return makeSuccess(id, {});

      case "tools/list":
        return makeSuccess(id, {
          tools: tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        });

      case "tools/call": {
        const params = (req.params ?? {}) as { name?: string; arguments?: unknown };
        if (!params.name) {
          return makeError(id, RPC.INVALID_PARAMS, "tools/call requires `name`");
        }
        const tool = toolMap[params.name];
        if (!tool) {
          return makeError(id, RPC.METHOD_NOT_FOUND, `unknown tool: ${params.name}`);
        }
        const result: ToolResult = await tool.handler(params.arguments ?? {}, ctx);
        return makeSuccess(id, result);
      }

      default:
        if (notification) return null; // ignore unknown notifications
        return makeError(id, RPC.METHOD_NOT_FOUND, `unknown method: ${req.method}`);
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : "internal error";
    return notification ? null : makeError(id, RPC.INTERNAL_ERROR, message);
  }
}
