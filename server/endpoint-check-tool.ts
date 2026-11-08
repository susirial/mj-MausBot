import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
import { z } from "zod";

const frameSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
  params: z.object({ name: z.string().optional() }).passthrough().optional(),
}).passthrough();
const receipt = process.env.OPENMAUSBOT_CHECK_RECEIPT;
const nonce = process.env.OPENMAUSBOT_CHECK_NONCE;
if (!receipt || !nonce) throw new Error("Missing connection check receipt.");

const lines = createInterface({ input: process.stdin });
lines.on("line", line => {
  let raw: unknown;
  try { raw = JSON.parse(line); } catch { return; }
  const parsed = frameSchema.safeParse(raw);
  if (!parsed.success || parsed.data.id === undefined) return;
  const frame = parsed.data;
  const reply = (result: unknown) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: frame.id, result })}\n`);
  switch (frame.method) {
    case "initialize":
      reply({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "endpoint_check", version: "1" } });
      break;
    case "tools/list":
      reply({ tools: [{ name: "echo", description: "Return a connection-check receipt.", inputSchema: { type: "object", properties: {}, additionalProperties: false } }] });
      break;
    case "tools/call":
      if (frame.params?.name !== "echo") return;
      writeFileSync(receipt, nonce, { mode: 0o600 });
      reply({ content: [{ type: "text", text: nonce }] });
      break;
    default:
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: frame.id, error: { code: -32601, message: "Unknown method" } })}\n`);
  }
});
