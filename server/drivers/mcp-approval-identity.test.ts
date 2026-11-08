import { describe, expect, it } from "vitest";
import { claudeMcpApprovalIdentity, codexMcpApprovalIdentity } from "./mcp-approval-identity.ts";

const mounted = new Map([["endpoint_check_openmausbot2", "endpoint_check"]]);
const request = {
  serverName: "endpoint_check_openmausbot2",
  message: 'Allow the endpoint_check_openmausbot2 MCP server to run tool "echo"?',
  _meta: { codex_approval_kind: "mcp_tool_call" },
};

describe("Codex MCP approval identity", () => {
  it("maps the actual mount to its original logical name", () => {
    expect(codexMcpApprovalIdentity(request, mounted)).toEqual({ kind: "mcp", server: "endpoint_check", name: "echo" });
  });

  it.each([
    null,
    { ...request, _meta: {} },
    { ...request, _meta: { codex_approval_kind: "app_access" } },
    { ...request, serverName: "unknown" },
    { ...request, message: 'Allow the different MCP server to run tool "echo"?' },
    { ...request, message: request.message + " Harmless." },
    { ...request, message: "Please " + request.message },
    { ...request, message: request.message.replace('"echo"', '""') },
    { ...request, message: request.message.replace('"echo"', '"echo" and "delete"') },
    { ...request, message: request.message.replace("echo", "echo\n") },
    { ...request, message: request.message.replace("echo", "echo\x7f") },
  ])("refuses an untrusted approval %j", (params) => {
    expect(codexMcpApprovalIdentity(params, mounted)).toBeUndefined();
  });

  it("does not reinterpret a directory call as its target tool", () => {
    expect(codexMcpApprovalIdentity({
      ...request, message: request.message.replace('"echo"', '"call_tool"'),
      _meta: { codex_approval_kind: "mcp_tool_call", tool_params: { name: "echo", arguments: {} } },
    }, mounted)).toEqual({ kind: "mcp", server: "endpoint_check", name: "call_tool" });
  });

  it("refuses controls in actual and logical server names", () => {
    const actual = "server\n";
    expect(codexMcpApprovalIdentity({
      ...request, serverName: actual, message: `Allow the ${actual} MCP server to run tool "echo"?`,
    }, new Map([[actual, "endpoint_check"]]))).toBeUndefined();
    expect(codexMcpApprovalIdentity(request, new Map([[request.serverName, "endpoint_check\x00"]]))).toBeUndefined();
  });
});

describe("Claude MCP approval identity", () => {
  it("uses a known mount prefix without splitting server or tool names", () => {
    expect(claudeMcpApprovalIdentity("mcp__endpoint__check__echo__v2", ["endpoint__check"]))
      .toEqual({ kind: "mcp", server: "endpoint__check", name: "echo__v2" });
  });

  it.each(["echo", "mcp__unknown__echo", "mcp__endpoint_check__", "mcp__endpoint_check__echo\n", "mcp__endpoint_check__echo\x7f", undefined])("refuses unknown or malformed names %j", (tool) => {
    expect(claudeMcpApprovalIdentity(tool, ["endpoint_check"])).toBeUndefined();
  });

  it("refuses ambiguous mounted prefixes in either order", () => {
    for (const names of [["endpoint", "endpoint__check"], ["endpoint__check", "endpoint"]]) {
      expect(claudeMcpApprovalIdentity("mcp__endpoint__check__echo", names)).toBeUndefined();
    }
  });
});
