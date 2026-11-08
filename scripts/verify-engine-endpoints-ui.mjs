import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { openHeadlessChrome } from "./testing/headless-chrome.ts";
import { startFakeEngineEndpoint } from "../server/testing/fake-engine-endpoint.ts";
import { launchVerificationServer } from "./control-omb.ts";
import { WELCOME_VERSION } from "../electron/onboarding-record.mjs";

const { values } = parseArgs({ options: { "evidence-dir": { type: "string" } } });
const evidenceDir = values["evidence-dir"] ?? join(tmpdir(), "omb-engine-endpoints-ui");
mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
const fixture = await launchVerificationServer({}, undefined, undefined, undefined, undefined, undefined, ["codex"], undefined,
  fileURLToPath(new URL("../dist", import.meta.url)));
const url = fixture.info.url;
const service = await startFakeEngineEndpoint();
const profile = mkdtempSync(join(tmpdir(), "omb-c3-ui-browser-"));
const syntheticKey = "fixture-only-c3-ui";
const assertions = [];
let page;
const save = (name, value) => writeFileSync(join(evidenceDir, name), value);
const api = async (method, path, body) => {
  const res = await fetch(url + path, {
    method, headers: { origin: url, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  assert(res.ok, `${path}: ${res.status} ${text}`);
  assert(!text.includes(syntheticKey), "public API hides synthetic key");
  return JSON.parse(text);
};
const click = async text => {
  const expression = `Array.from(document.querySelectorAll('button,[role=menuitem]')).find(b => b.getClientRects().length && (b.textContent.trim() === ${JSON.stringify(text)} || b.getAttribute('aria-label') === ${JSON.stringify(text)}))`;
  await page.until(`${expression} && !${expression}.disabled`, 20000);
  await page.evaluate(`${expression}.click()`);
};
const fill = async (label, value) => {
  const selector = `input[aria-label=${JSON.stringify(label)}]`;
  await page.until(`document.querySelector(${JSON.stringify(selector)})`, 20000);
  await page.evaluate(`(() => { const input = document.querySelector(${JSON.stringify(selector)}); input.focus(); input.select(); })()`);
  await page.send("Input.insertText", { text: value });
};
const settings = async () => {
  await click("You");
  await click("Settings");
  await click("AI");
  await page.until("document.querySelector('[data-engine-endpoints]')", 20000);
};
try {
  await api("PATCH", "/api/config", { language: "en", onboarding: {
    completedAt: new Date().toISOString(), version: WELCOME_VERSION,
    hintsSeen: ["metChief", "spot.composer", "spot.model", "spot.approval", "spot.connector"],
  } });
  const { bots } = await api("GET", "/api/bots");
  for (const bot of bots) await api("PATCH", `/api/bots/${bot.id}`, { welcomed: true });
  const before = await api("GET", "/api/instances");
  service.register("ui-codex", "codex", syntheticKey);
  service.register("ui-claude", "claude", syntheticKey);
  page = await openHeadlessChrome(profile);
  await page.send("Page.enable");
  await page.send("Emulation.setDeviceMetricsOverride", { width: 1494, height: 960, deviceScaleFactor: 1, mobile: false });
  await page.send("Page.navigate", { url });
  await page.until("document.querySelector('button[aria-label=\"You\"]')", 20000);
  if (await page.evaluate("Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='Not now')")) await click("Not now");
  await settings();
  await click("Add API connection");
  await page.until("document.querySelector('select[aria-label=\"Execution tool\"]')", 20000);
  await page.evaluate(`(() => { const select=document.querySelector('select[aria-label="Execution tool"]'); select.value="both"; select.dispatchEvent(new Event("change",{bubbles:true})); })()`);
  await fill("Connection name", "C3 UI DeepSeek");
  await fill("API key", syntheticKey);
  await fill("Codex address", service.url + "/ui-codex/v1");
  await fill("Claude Code address", service.url + "/ui-claude/v1");
  await click("Save");
  await page.until("document.querySelectorAll('[data-engine-endpoint]').length===2", 20000);
  assert.equal(service.requests.length, 0, "saving does not trigger a paid check");
  assertions.push("Full application settings creates separate Codex and Claude entries without automatic API calls");
  const current = await api("GET", "/api/instances");
  const connections = current.instances.filter(i => i.engineEndpoint);
  assert.equal(connections.length, 2);
  for (const old of before.instances) assert.deepEqual(current.instances.find(i => i.instanceId === old.instanceId).models, old.models);
  assertions.push("Existing official instance model catalogs remain unchanged");
  for (const connection of connections) {
    const runtime = connection.engineEndpoint.runtime;
    const wrapper = join(profile, `endpoint-${runtime}.mjs`);
    const source = new URL(`../server/testing/${runtime === "codex" ? "fake-codex-app-server.ts" : "fake-claude-cli.ts"}`, import.meta.url).href;
    writeFileSync(wrapper, `#!/usr/bin/env node\nprocess.env.${runtime === "codex" ? "FAKE_CODEX_ENDPOINT" : "FAKE_CLAUDE_ENDPOINT"}="1";\nprocess.env.${runtime === "codex" ? "FAKE_CODEX_VERSION" : "FAKE_CLAUDE_VERSION"}=${JSON.stringify(runtime === "codex" ? "codex-cli 0.167.0" : "2.1.296")};\nawait import(${JSON.stringify(source)});\n`, { mode: 0o700 });
    await api("PATCH", `/api/instances/${connection.instanceId}/engine-endpoint`, {
      expectedRevision: connection.engineEndpoint.revision, cli: wrapper,
    });
  }
  await page.send("Page.navigate", { url });
  await settings();
  await page.until("document.querySelectorAll('[data-engine-endpoint]').length===2", 20000);
  for (const connection of connections) {
    const selector = `[data-engine-endpoint="${connection.instanceId}"]`;
    await page.evaluate(`Array.from(document.querySelector(${JSON.stringify(selector)}).querySelectorAll('button')).find(b=>b.textContent==='Check answer').click()`);
    await page.until(`document.querySelector(${JSON.stringify(selector + " [data-endpoint-check=answer]")}).textContent.includes('Verified for this model')`, 30000);
  }
  assertions.push("Both explicit answer checks pass through actual backend and loopback HTTP provider");
  await page.evaluate("document.querySelector('[data-engine-endpoints]').scrollIntoView({block:'start'})");
  save("settings.png", await page.capture());
  await page.evaluate("document.querySelector('button[aria-label=\"Close settings\"]').click()");
  await click("Claude Sonnet 5");
  await page.until("document.body.textContent.includes('C3 UI DeepSeek')", 20000);
  assertions.push("Full app model picker exposes newly created independent connections");
  const codex = connections.find(i => i.engineEndpoint.runtime === "codex");
  const modelSelector = `[data-simple-provider="${codex.instanceId}"]`;
  await page.until(`document.querySelector(${JSON.stringify(modelSelector)})`, 20000);
  await page.evaluate(`document.querySelector(${JSON.stringify(modelSelector)}).scrollIntoView({block:'center'})`);
  save("picker.png", await page.capture());
  await page.evaluate(`Array.from(document.querySelector(${JSON.stringify(modelSelector)}).querySelectorAll('button')).find(b=>b.textContent.includes('DeepSeek Flash')).click()`);
  await page.until("!document.querySelector('[data-simple-model-menu]')", 10000);
  assert.equal((await api("GET", "/api/bots")).bots.find(b => b.id === bots[0].id).modelSelection.instanceId, codex.instanceId);
  assertions.push("Picking the Codex model in the full UI saves its independent instance ID");
  await page.evaluate("document.querySelector('textarea').focus()");
  await page.send("Input.insertText", { text: "Reply with a short synthetic answer." });
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await page.until("document.body.textContent.includes('endpoint answer ui-codex deepseek-flash')", 30000);
  assertions.push("A message sent from the full UI receives its Codex DeepSeek reply through the loopback service");
  await page.send("Page.navigate", { url });
  await page.until("document.body.textContent.includes('endpoint answer ui-codex deepseek-flash')", 20000);
  assert.equal((await api("GET", "/api/bots")).bots.find(b => b.id === bots[0].id).modelSelection.instanceId, codex.instanceId);
  assertions.push("Reload retains the independent model selection and conversation");
  save("chat.png", await page.capture());
  const report = { ok: true, assertions, requests: service.requests.length };
  save("result.json", JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch (error) {
  if (page) {
    save("failure.txt", await page.evaluate("document.body.innerText"));
    save("failure.png", await page.capture());
  }
  save("result.json", JSON.stringify({ ok: false, assertions, error: String(error) }, null, 2));
  throw error;
} finally {
  page?.close();
  await service.close();
  await fixture.close();
  rmSync(profile, { recursive: true, force: true });
}
