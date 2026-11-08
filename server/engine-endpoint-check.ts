import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EndpointCheckKind, EndpointCheckResult } from "../shared/engine-endpoint.ts";
import type { ProviderInstance } from "./contracts.ts";
import { AGENTS_NODE_FLAG, resolveProxy } from "./proxy-paths.ts";
import { redactSecretsInText } from "./redact.ts";

export function endpointCheckFailure(message: string): Extract<EndpointCheckResult, { state: "failed" }>["reason"] {
  if (/401|unauthori[sz]ed|invalid[_ ](?:api[_ ]?)?key|authentication/i.test(message)) return "credentials";
  if (/model[_ -]not[_ -]found|unknown model|model.{0,30}(?:not found|unavailable)/i.test(message)) return "model";
  if (/\b404\b/i.test(message)) return "protocol";
  if (/429|rate.limit|quota/i.test(message)) return "rate_limit";
  if (/timeout|timed out/i.test(message)) return "timeout";
  if (/protocol|unsupported|tool/i.test(message)) return "protocol";
  return "other";
}

export async function checkEngineEndpoint(input: {
  instance: ProviderInstance; revision: number; model: string; kind: EndpointCheckKind; timeoutMs?: number;
}): Promise<EndpointCheckResult> {
  const { instance, model, kind } = input;
  const timeoutMs = input.timeoutMs ?? 90_000;
  const failed = (message: string): EndpointCheckResult => ({
    state: "failed", model, kind, checkedAt: Date.now(), reason: endpointCheckFailure(message),
    message: redactSecretsInText(message.replace(/\s+/g, " ").trim()).slice(0, 300),
  });
  const passed = (): EndpointCheckResult => ({ state: "passed", model, kind, checkedAt: Date.now() });
  const stop = new AbortController();
  if (kind === "background") {
    const call = instance.generateMemoryText ?? instance.generateText;
    if (!call) return failed("Background protocol is unsupported by this engine.");
    let timer: NodeJS.Timeout | undefined;
    try {
      const answer = await Promise.race([
        call.call(instance, "Reply with the single word OK.", { model, signal: stop.signal, timeoutMs }),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { stop.abort(); reject(new Error("Connection check timed out.")); }, timeoutMs); timer.unref?.(); }),
      ]);
      return answer.trim() ? passed() : failed("The engine returned no answer.");
    } catch (error) { return failed(error instanceof Error ? error.message : "Background check failed."); }
    finally { clearTimeout(timer); }
  }
  const directory = mkdtempSync(join(tmpdir(), "omb-endpoint-check-"));
  const receipt = join(directory, "tool-receipt");
  const nonce = randomUUID();
  const threadId = endpointCheckThreadId();
  try {
    return await new Promise<EndpointCheckResult>((resolve) => {
      let answer = "", error = "", settled = false;
      let unsubscribe = () => {};
      const finish = (result: EndpointCheckResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        stop.abort();
        void instance.adapter.interruptTurn(threadId).catch(() => {});
        Promise.resolve(instance.adapter.closeSession?.(threadId)).then(
          () => resolve(result),
          () => resolve(failed("The check's native session could not be stopped. Check this connection before retrying.")),
        );
      };
      const timer = setTimeout(() => finish(failed("Connection check timed out.")), timeoutMs);
      timer.unref?.();
      unsubscribe = instance.adapter.onEvent(event => {
        if (event.threadId !== threadId || settled) return;
        if (event.type === "runtime.error") error = event.message;
        if (event.type === "item.completed" && event.itemType === "assistant_text" && !event.synthetic) answer += event.text;
        if (event.type === "request.opened") {
          const safeTool = kind === "tools" && /^(?:mcp__)?endpoint_check(?:__|[./])echo$/i.test(event.tool);
          void instance.adapter.respondToRequest(threadId, event.requestId ?? "", { behavior: safeTool ? "allow" : "deny" }).catch(() => {});
        }
        if (event.type === "turn.completed") {
          if (!event.ok || error) return finish(failed(error || "The engine could not complete the check."));
          const toolRan = existsSync(receipt) && readFileSync(receipt, "utf8") === nonce;
          if (kind === "tools" && (!toolRan || !answer.includes(nonce))) return finish(failed("Tool protocol check did not complete a tool call and final answer."));
          finish(answer.trim() ? passed() : failed("The engine returned no answer."));
        }
      });
      Promise.resolve().then(() => instance.adapter.sendTurn({
        threadId, model, cwd: directory, sessionReset: true, approvalMode: "ask",
        toolScope: { allow: kind === "tools" ? ["native:*", "mcp:endpoint_check:echo"] : ["native:*"] },
        text: kind === "tools" ? "Call endpoint_check.echo once, then reply with the exact text returned by that tool." : "Reply with the single word OK.",
        ...(kind === "tools" ? { integrations: { custom: { endpoint_check: {
          command: process.execPath, args: ["--experimental-strip-types", resolveProxy("endpoint-check-tool")],
          env: { ...AGENTS_NODE_FLAG, OPENMAUSBOT_CHECK_RECEIPT: receipt, OPENMAUSBOT_CHECK_NONCE: nonce },
        } } } } : {}),
      })).catch(cause => finish(failed(cause instanceof Error ? cause.message : "Connection check failed.")));
    });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

export const endpointCheckThreadId = () => `endpoint-check-${randomUUID()}`;

export class EngineEndpointChecks {
  private readonly results = new Map<string, EndpointCheckResult>();
  private readonly running = new Map<string, Promise<EndpointCheckResult>>();

  private key(instanceId: string, revision: number, version: string | null | undefined, model: string, kind: EndpointCheckKind): string {
    return JSON.stringify([instanceId, revision, version ?? "", model, kind]);
  }

  info(instanceId: string, revision: number, version: string | null | undefined): EndpointCheckResult[] {
    const prefix = JSON.stringify([instanceId, revision, version ?? ""]).slice(0, -1) + ",";
    return [...this.results].filter(([key]) => key.startsWith(prefix)).map(([, value]) => value);
  }

  clear(instanceId: string): void {
    const prefix = JSON.stringify([instanceId]).slice(0, -1) + ",";
    for (const key of this.results.keys()) if (key.startsWith(prefix)) this.results.delete(key);
  }

  async run(input: Parameters<typeof checkEngineEndpoint>[0]): Promise<EndpointCheckResult> {
    const version = (await input.instance.snapshot()).version;
    const key = this.key(input.instance.instanceId, input.revision, version, input.model, input.kind);
    const existing = this.running.get(key);
    if (existing) return existing;
    this.results.set(key, { state: "checking", model: input.model, kind: input.kind });
    const run = checkEngineEndpoint(input).then(result => {
      this.results.set(key, result);
      if (this.results.size > 256) {
        const first = this.results.keys().next().value;
        if (first) this.results.delete(first);
      }
      return result;
    }).finally(() => { this.running.delete(key); });
    this.running.set(key, run);
    return run;
  }
}
