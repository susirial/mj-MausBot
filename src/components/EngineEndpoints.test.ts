// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import * as store from "@/state/store";
import { accountGroupOf } from "./EngineAccounts";
import { engineReady } from "./EngineLibrary";
import type { EndpointConnection, EndpointModel } from "../../shared/engine-endpoint";

const model: EndpointModel = { id: "fixture-model", label: "Fixture", source: "configured", inputModalities: ["text"], effortLevels: [], nativeSearch: "unknown" };
const connection = {
  version: 1, revision: 3, provider: "custom", runtime: "codex", protocol: "responses",
  baseUrl: "https://fixture.test/v1", catalog: { default: model.id, options: [model] },
  backgroundModel: model.id, webSearch: "disabled",
} satisfies EndpointConnection;
const endpointInstance = (extra: Partial<store.InstanceInfo> = {}): store.InstanceInfo => ({
  instanceId: "endpoint-fixture", displayName: "Fixture connection", driverKind: "codex",
  snapshot: { state: "available", authenticated: false }, models: { default: model.id, options: [model] },
  engineEndpoint: { ...connection, keyConfigured: true, check: { state: "unverified" }, checks: [] }, ...extra,
});

it("does not count an independent connection as an official account even with legacy authentication metadata", () => {
  expect(accountGroupOf(endpointInstance({ authentication: { method: "device-code" } }))).toBeNull();
});

it("allows a configured API connection without an official login and rejects a missing key", () => {
  expect(engineReady(endpointInstance())).toBe(true);
  expect(engineReady(endpointInstance({ engineEndpoint: { ...connection, keyConfigured: false, check: { state: "unverified" }, checks: [] } }))).toBe(false);
});

it("keeps a malformed independent connection out of official accounts and shows its unavailable reason", async () => {
  vi.spyOn(store, "api").mockResolvedValue({ presets: [] });
  const malformed = endpointInstance({
    engineEndpoint: undefined, independentEndpoint: true,
    snapshot: { state: "unavailable", reason: "Invalid endpoint catalog: missing default" },
    authentication: { method: "device-code" },
  });
  expect(accountGroupOf(malformed)).toBeNull();
  expect(engineReady(malformed)).toBe(false);
  await mount([malformed]);
  const row = container.querySelector('[data-engine-endpoint="endpoint-fixture"]');
  expect(row?.textContent).toContain("Invalid endpoint catalog: missing default");
  expect(row?.querySelector("button")).toBeNull();
});

let root: Root | undefined;
let container: HTMLDivElement;
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  container?.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mount(instances: store.InstanceInfo[] = []) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(store, "useStore").mockReturnValue({
    state: { ...store.initialState, instances }, dispatch: vi.fn(), flushBotPatches: vi.fn(),
    refreshInstances: vi.fn(), refreshModels: vi.fn(),
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const { EngineEndpoints } = await import("./EngineEndpoints");
  await act(async () => root?.render(createElement(EngineEndpoints)));
}

async function click(label: string) {
  const button = Array.from(container.querySelectorAll("button")).find((element) => element.textContent === label);
  expect(button, label).toBeDefined();
  await act(async () => button?.click());
}

async function fill(label: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  expect(input, label).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input?.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function select(label: string, value: string) {
  const element = container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);
  expect(element, label).not.toBeNull();
  await act(async () => { if (element) { element.value = value; element.dispatchEvent(new Event("change", { bubbles: true })); } });
}

it("retries an uncertain create with the original UUID and payload, and makes no automatic checks", async () => {
  const requests: Array<{ path: string; body?: string }> = [];
  vi.spyOn(store, "api").mockImplementation(async (path, init) => {
    requests.push({ path, body: typeof init?.body === "string" ? init.body : undefined });
    if (path === "/api/engine-endpoint-presets") return { presets: [] };
    if (requests.filter((entry) => entry.path === "/api/instances/engine-endpoints").length === 1) throw new Error("Network response lost");
    return { committed: true, instanceIds: ["endpoint-fixture"], instances: [endpointInstance()], loadResults: [{ instanceId: "endpoint-fixture", state: "unavailable", reason: "CLI could not load" }] };
  });
  await mount();
  await click("Add API connection");
  await fill("Connection name", "Fixture");
  await fill("API key", "synthetic-fixture-only");
  await fill("Codex address", "https://fixture.test/v1");
  await fill("Codex model ID", model.id);
  await click("Save");
  expect(container.textContent).toContain("Network response lost");
  await click("Retry save");
  const saves = requests.filter((entry) => entry.path === "/api/instances/engine-endpoints");
  expect(saves).toHaveLength(2);
  expect(saves[0]?.body).toBe(saves[1]?.body);
  expect(JSON.parse(saves[0]?.body ?? "{}").operationId).toMatch(/^[0-9a-f-]{36}$/);
  expect(container.textContent).toContain("CLI could not load");
  expect(container.querySelector('input[type="password"]')).toBeNull();
  expect(requests.some((entry) => entry.path.endsWith("/check"))).toBe(false);
});

it("retains the single-instance edit draft on a conflict and omits a blank key", async () => {
  let saved: { path: string; body?: string } | undefined;
  vi.spyOn(store, "api").mockImplementation(async (path, init) => {
    if (path === "/api/engine-endpoint-presets") return { presets: [] };
    saved = { path, body: typeof init?.body === "string" ? init.body : undefined };
    throw new Error("409 connection busy");
  });
  await mount([endpointInstance()]);
  await click("Edit");
  await fill("Connection name", "Retained draft");
  await click("Save");
  expect(saved?.path).toBe("/api/instances/endpoint-fixture/engine-endpoint");
  expect(JSON.parse(saved?.body ?? "{}")).toMatchObject({ expectedRevision: 3, displayName: "Retained draft" });
  expect(JSON.parse(saved?.body ?? "{}")).not.toHaveProperty("apiKey");
  expect(JSON.parse(saved?.body ?? "{}").endpointPatch).not.toHaveProperty("runtime");
  expect(JSON.parse(saved?.body ?? "{}").endpointPatch).not.toHaveProperty("revision");
  expect(container.querySelector<HTMLInputElement>('input[aria-label="Connection name"]')?.value).toBe("Retained draft");
  expect(container.textContent).toContain("409 connection busy");
});

it("checks only on request and keeps an answer success separate from tools and background", async () => {
  const requests: string[] = [];
  vi.spyOn(store, "api").mockImplementation(async (path) => {
    requests.push(path);
    if (path === "/api/engine-endpoint-presets") return { presets: [] };
    return { check: { state: "passed", model: model.id, kind: "answer", checkedAt: 1000, reportedModel: "fixture-reported" } };
  });
  await mount([endpointInstance()]);
  expect(requests).toEqual(["/api/engine-endpoint-presets"]);
  expect(container.textContent).toContain("may incur charges");
  await click("Check answer");
  expect(requests).toContain("/api/instances/endpoint-fixture/engine-endpoint/check");
  expect(container.querySelector('[data-endpoint-check="answer"]')?.textContent).toContain("Verified for this model");
  expect(container.querySelector('[data-endpoint-check="tools"]')?.textContent).toContain("not verified");
  expect(container.querySelector('[data-endpoint-check="background"]')?.textContent).toContain("not verified");
  expect(container.textContent).toContain("fixture-reported");
});

it("does not save an edited address without a new key", async () => {
  const api = vi.spyOn(store, "api").mockResolvedValue({ presets: [] });
  await mount([endpointInstance()]);
  await click("Edit");
  await fill("Codex address", "https://another.test/v1");
  const save = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Save");
  expect(save?.disabled).toBe(true);
  expect(api).toHaveBeenCalledTimes(1);
});

it("creates both runtimes in one request using server presets", async () => {
  let body: Record<string, unknown> | undefined;
  const claude: EndpointConnection = {
    ...connection, runtime: "claude", protocol: "anthropic",
    roleModels: { opus: model.id, sonnet: model.id, haiku: model.id, fable: model.id, subagent: model.id },
  };
  vi.spyOn(store, "api").mockImplementation(async (path, init) => {
    if (path === "/api/engine-endpoint-presets") return { presets: [
      { id: "codex-deepseek", label: "Codex", endpoint: { ...connection, provider: "deepseek" }, sources: [] },
      { id: "claude-deepseek", label: "Claude", endpoint: { ...claude, provider: "deepseek" }, sources: [] },
    ] };
    body = JSON.parse(String(init?.body));
    return { committed: true, instanceIds: [], instances: [], loadResults: [] };
  });
  await mount();
  await click("Add API connection");
  await select("Execution tool", "both");
  await fill("Connection name", "Both");
  await fill("API key", "synthetic-fixture-only");
  await click("Save");
  expect(body).toMatchObject({ provider: "deepseek", connections: [{ runtime: "codex" }, { runtime: "claude" }] });
  expect(body?.connections).toHaveLength(2);
});

it("requires confirmation before deleting through the existing instance API", async () => {
  const requests: string[] = [];
  vi.spyOn(store, "api").mockImplementation(async (path) => {
    requests.push(path);
    if (path === "/api/engine-endpoint-presets") return { presets: [] };
    return { instances: [] };
  });
  await mount([endpointInstance()]);
  const remove = container.querySelector<HTMLButtonElement>('button[aria-label="Remove Fixture connection"]');
  await act(async () => remove?.click());
  expect(requests).toEqual(["/api/engine-endpoint-presets"]);
  expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain("provider files will be kept");
  const confirm = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')).find((button) => button.textContent === "Remove");
  await act(async () => confirm?.click());
  expect(requests).toEqual(["/api/engine-endpoint-presets", "/api/instances/endpoint-fixture"]);
});

it("locks duplicate submissions while the first save is pending", async () => {
  let finish: ((value: unknown) => void) | undefined;
  let saves = 0;
  vi.spyOn(store, "api").mockImplementation(async (path) => {
    if (path === "/api/engine-endpoint-presets") return { presets: [] };
    saves++;
    return new Promise((resolve) => { finish = resolve; });
  });
  await mount([endpointInstance()]);
  await click("Edit");
  const form = container.querySelector("form");
  await act(async () => {
    form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  expect(saves).toBe(1);
  expect(container.querySelector('input[type="password"]')?.closest("fieldset")?.disabled).toBe(true);
  await act(async () => finish?.({ instances: [endpointInstance()] }));
});
