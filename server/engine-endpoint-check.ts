import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EndpointCheckCode, EndpointCheckKind, EndpointCheckResult } from "../shared/engine-endpoint.ts";
import type { ProviderInstance, RequestOutcome } from "./contracts.ts";
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

type CheckInput = {
  instance: ProviderInstance; revision: number; model: string; kind: EndpointCheckKind; timeoutMs?: number;
};
type CheckEvidence = {
  approvals: Array<{ tool: string; server?: string; decision: "allow" | "deny"; outcome?: RequestOutcome | "error" }>;
  receipt: "absent" | "matched" | "mismatched" | "unreadable";
  answerEcho: boolean;
};
const TOOL_FAILURES = {
  mcp_startup_failed: "The check tool could not start.",
  tool_denied: "The check did not allow the requested tool call.",
  tool_approval_failed: "The engine could not receive the check tool approval.",
  tool_unsupported: "The engine could not route a tool call during the check.",
  tool_not_called: "The turn ended without a check tool receipt.",
  tool_receipt_mismatch: "The check tool did not produce the expected receipt.",
  tool_answer_missing: "The tool ran, but the assistant answer did not include its returned text.",
} satisfies Record<EndpointCheckCode, string>;
const UNSUPPORTED_NOTICES = new Set([
  "chat.notice.codexUnsupportedOne", "chat.notice.codexUnsupportedMany", "chat.notice.codexUnsupportedMore",
]);

export async function checkEngineEndpoint(input: CheckInput): Promise<EndpointCheckResult> {
  const checkId = endpointCheckThreadId();
  const started = Date.now();
  const evidence: CheckEvidence = { approvals: [], receipt: "absent", answerEcho: false };
  const result = await runEndpointCheck(input, checkId, evidence);
  console.info(`[endpoint-check] ${JSON.stringify({
    checkId, instanceId: redactSecretsInText(input.instance.instanceId).slice(0, 160),
    revision: input.revision, runtime: input.instance.driverKind,
    model: redactSecretsInText(input.model).slice(0, 160), kind: input.kind, state: result.state,
    ...(result.state === "failed" ? { reason: result.reason, code: result.code } : {}),
    durationMs: Date.now() - started,
    ...(input.kind === "tools" ? evidence : {}),
  })}`);
  return result;
}

async function runEndpointCheck(input: CheckInput, threadId: string, evidence: CheckEvidence): Promise<EndpointCheckResult> {
  const { instance, model, kind } = input;
  const timeoutMs = input.timeoutMs ?? 90_000;
  const failed = (message: string, code?: EndpointCheckCode): EndpointCheckResult => ({
    state: "failed", model, kind, checkedAt: Date.now(), checkId: threadId,
    reason: code ? code === "tool_unsupported" ? "protocol" : "other" : endpointCheckFailure(message),
    ...(code ? { code } : {}),
    message: redactSecretsInText(message.replace(/\s+/g, " ").trim()).slice(0, 300),
  });
  const toolFailed = (code: EndpointCheckCode) => failed(TOOL_FAILURES[code], code);
  const passed = (): EndpointCheckResult => ({ state: "passed", model, kind, checkedAt: Date.now(), checkId: threadId });
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
  try {
    return await new Promise<EndpointCheckResult>((resolve) => {
      let answer = "", error = "", settled = false;
      let completing = false;
      let toolFailure: EndpointCheckCode | undefined;
      const approvals = new Map<string, Promise<void>>();
      let unsubscribe = () => {};
      const captureToolEvidence = () => {
        if (kind !== "tools") return;
        evidence.answerEcho = answer.includes(nonce);
        try {
          evidence.receipt = !existsSync(receipt) ? "absent"
            : readFileSync(receipt, "utf8") === nonce ? "matched" : "mismatched";
        } catch { evidence.receipt = "unreadable"; }
      };
      const finish = (result: EndpointCheckResult) => {
        if (settled) return;
        captureToolEvidence();
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
      const complete = (ok: boolean) => {
        if (settled) return;
        captureToolEvidence();
        if (!ok || error) {
          const reason = endpointCheckFailure(error);
          if (toolFailure && !["credentials", "model", "rate_limit", "timeout"].includes(reason)) return finish(toolFailed(toolFailure));
          return finish(failed(error || "The engine could not complete the check."));
        }
        if (kind === "tools" && (evidence.receipt !== "matched" || !evidence.answerEcho)) {
          return finish(toolFailed(toolFailure ?? (evidence.receipt === "absent" ? "tool_not_called"
            : evidence.receipt !== "matched" ? "tool_receipt_mismatch" : "tool_answer_missing")));
        }
        finish(answer.trim() ? passed() : failed("The engine returned no answer."));
      };
      unsubscribe = instance.adapter.onEvent(event => {
        if (event.threadId !== threadId || settled || completing) return;
        if (event.type === "runtime.error") error = event.message;
        if (kind === "tools" && (event.type === "session.started" || event.type === "runtime.notice")
          && event.mcpFailed?.includes("endpoint_check")) toolFailure ??= "mcp_startup_failed";
        if (kind === "tools" && event.type === "runtime.notice" && event.text && UNSUPPORTED_NOTICES.has(event.text.key)) toolFailure ??= "tool_unsupported";
        if (event.type === "item.completed" && event.itemType === "assistant_text" && !event.synthetic) answer += event.text;
        if (event.type === "request.opened") {
          const identity = event.toolIdentity;
          const safeTool = kind === "tools" && event.requestType === "permission" && event.origin !== "output"
            && !event.requiresExplicitApproval && event.approvalScope === undefined
            && identity?.kind === "mcp" && identity.server === "endpoint_check" && identity.name === "echo";
          if (!safeTool && kind === "tools") toolFailure ??= "tool_denied";
          const requestId = event.requestId;
          if (!requestId) { if (kind === "tools") toolFailure ??= "tool_approval_failed"; return; }
          if (approvals.has(requestId)) return;
          const approval: CheckEvidence["approvals"][number] = {
            tool: redactSecretsInText(event.tool).replace(/\s+/g, " ").slice(0, 160),
            ...(identity?.kind === "mcp" ? { server: redactSecretsInText(identity.server).slice(0, 160) } : {}),
            decision: safeTool ? "allow" : "deny",
          };
          if (evidence.approvals.length < 16) evidence.approvals.push(approval);
          approvals.set(requestId, Promise.resolve().then(() => instance.adapter.respondToRequest(threadId, requestId, { behavior: approval.decision })).then(
            outcome => {
              approval.outcome = outcome;
              if (safeTool && outcome !== "allowed-once") toolFailure ??= "tool_approval_failed";
            },
            () => { approval.outcome = "error"; if (kind === "tools") toolFailure ??= "tool_approval_failed"; },
          ));
        }
        if (event.type === "turn.completed") {
          completing = true;
          void Promise.all(approvals.values()).then(() => complete(event.ok));
        }
      });
      Promise.resolve().then(() => instance.adapter.sendTurn({
        threadId, model, cwd: directory, sessionReset: true, approvalMode: "ask",
        toolScope: { allow: kind === "tools" ? ["native:*", "mcp:endpoint_check:echo"] : ["native:*"] },
        text: kind === "tools" ? `Call ${instance.driverKind === "claudeAgent" ? "mcp__endpoint_check__echo" : "endpoint_check.echo"} once, then reply with the exact text returned by that tool.` : "Reply with the single word OK.",
        ...(kind === "tools" ? { preloadMcpServers: ["endpoint_check"] } : {}),
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
