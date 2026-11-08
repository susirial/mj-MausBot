import type { ToolIdentity } from "../../shared/tool-scope.ts";
import { containsControlCharacter, plainRecord } from "./codex-app-approval.ts";

export function codexMcpApprovalIdentity(params: unknown, mounted: ReadonlyMap<string, string>): ToolIdentity | undefined {
  const request = plainRecord(params);
  if (!request || plainRecord(request._meta)?.codex_approval_kind !== "mcp_tool_call") return undefined;
  const actual = request.serverName;
  const message = request.message;
  if (typeof actual !== "string" || typeof message !== "string" || containsControlCharacter(message) || containsControlCharacter(actual)) return undefined;
  const server = mounted.get(actual);
  if (!server || containsControlCharacter(server)) return undefined;
  const prefix = `Allow the ${actual} MCP server to run tool "`;
  if (!message.startsWith(prefix) || !message.endsWith('"?')) return undefined;
  const name = message.slice(prefix.length, -2);
  if (!name || name.includes('"')) return undefined;
  return { kind: "mcp", server, name };
}

export function claudeMcpApprovalIdentity(tool: unknown, mounted: readonly string[]): ToolIdentity | undefined {
  if (typeof tool !== "string" || containsControlCharacter(tool)) return undefined;
  let identity: ToolIdentity | undefined;
  for (const server of mounted) {
    if (!server || containsControlCharacter(server)) continue;
    const prefix = `mcp__${server}__`;
    if (!tool.startsWith(prefix) || tool.length === prefix.length) continue;
    if (identity) return undefined;
    identity = { kind: "mcp", server, name: tool.slice(prefix.length) };
  }
  return identity;
}
