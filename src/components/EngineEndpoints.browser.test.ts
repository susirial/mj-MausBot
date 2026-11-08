import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "vite";
import { expect, it } from "vitest";
import { openHeadlessChrome, type HeadlessPage } from "../../scripts/testing/headless-chrome";

// Opt in on machines with Chrome. Only the fixture middleware receives API calls.
it.skipIf(process.env.OMB_ENDPOINT_BROWSER !== "1")("renders and saves the real endpoint form in Chrome without an automatic check", async () => {
  const profile = await mkdtemp(join(tmpdir(), "omb-endpoint-browser-"));
  const requests: string[] = [];
  const entry = `
    import React from "react";
    import {createRoot} from "react-dom/client";
    import {EngineEndpoints} from "/src/components/EngineEndpoints.tsx";
    import {BotEditorStore,initialState} from "/src/state/store.tsx";
    import "/src/styles.css";
    createRoot(document.getElementById("root")).render(
      React.createElement(BotEditorStore,{value:{
        state:initialState,dispatch:()=>{},flushBotPatches:()=>{},
        refreshInstances:async()=>{},refreshModels:async()=>{}
      }}, React.createElement("main", {className:"mx-auto max-w-xl p-6"}, React.createElement(EngineEndpoints)))
    );
  `;
  const root = process.cwd();
  const server = await createServer({
    root, logLevel: "error",
    server: { host: "127.0.0.1", port: 0, fs: { allow: [root, realpathSync(join(root, "node_modules"))] } },
    plugins: [{
      name: "endpoint-browser-fixture",
      enforce: "pre",
      resolveId(id) {
        if (id === "endpoint-browser-entry") return "\0endpoint-browser-entry";
      },
      load(id) {
        if (id === "\0endpoint-browser-entry") return entry;
      },
      configureServer(vite) {
        vite.middlewares.use((req, res, next) => {
          if (req.url === "/__endpoint.html") {
            void vite.transformIndexHtml(req.url, '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/@id/endpoint-browser-entry"></script></body></html>')
              .then((html) => { res.setHeader("content-type", "text/html"); res.end(html); });
          } else if (req.url?.startsWith("/api/")) {
            requests.push(`${req.method} ${req.url}`);
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify(req.url === "/api/engine-endpoint-presets" ? { presets: [] }
              : { committed: true, instanceIds: ["fixture"], instances: [], loadResults: [
                { instanceId: "fixture", state: "unavailable", reason: "Fixture CLI unavailable" },
              ] }));
          } else next();
        });
      },
    }],
  });
  let page: HeadlessPage | undefined;
  try {
    await server.listen();
    page = await openHeadlessChrome(profile);
    await page.send("Page.enable");
    await page.send("Page.addScriptToEvaluateOnNewDocument", { source: `
      window.fixtureErrors = [];
      addEventListener("error", event => window.fixtureErrors.push(event.message));
      addEventListener("unhandledrejection", event => window.fixtureErrors.push(String(event.reason)));
    ` });
    await page.send("Emulation.setDeviceMetricsOverride", { width: 430, height: 960, deviceScaleFactor: 1, mobile: false });
    const navigation = await page.send("Page.navigate", { url: new URL("/__endpoint.html", server.resolvedUrls!.local[0]).href });
    expect(navigation.errorText).toBeUndefined();
    try {
      await page.until("Array.from(document.querySelectorAll('button')).some(b => b.textContent === 'Add API connection' && !b.disabled)", 15_000);
    } catch (cause) {
      throw new Error(`${String(cause)}: ${JSON.stringify(await page.evaluate("({url:location.href,errors:window.fixtureErrors,body:document.body.innerText.slice(0,500)})"))}`);
    }
    await page.evaluate("Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Add API connection').click()");
    await page.until("document.querySelector('input[aria-label=\"Connection name\"]')");
    const controls = await page.evaluate("Array.from(document.querySelectorAll('input')).map(e => e.getAttribute('aria-label'))");
    expect(controls).toContain("Codex address");
    for (const [label, value] of [
      ["Connection name", "Browser fixture"], ["API key", "synthetic-fixture-only"],
      ["Codex address", "https://fixture.test/v1"], ["Codex model ID", "fixture-model"],
    ]) {
      await page.evaluate(`(() => {
        const input = document.querySelector('input[aria-label="${label}"]');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(input,${JSON.stringify(value)});
        input.dispatchEvent(new Event("input",{bubbles:true}));
      })()`);
    }
    await page.until("Array.from(document.querySelectorAll('button')).some(b => b.textContent === 'Save' && !b.disabled)");
    expect(await page.evaluate("document.documentElement.scrollWidth <= innerWidth")).toBe(true);
    const evidence = process.env.OMB_ENDPOINT_SCREENSHOT;
    if (evidence) await writeFile(evidence, await page.capture());
    await page.evaluate("Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Save').click()");
    await page.until("document.body.textContent.includes('Fixture CLI unavailable')");
    expect(await page.evaluate("document.querySelector('input[type=password]') === null")).toBe(true);
    expect(requests).toEqual(["GET /api/engine-endpoint-presets", "POST /api/instances/engine-endpoints"]);
  } finally {
    page?.close();
    await server.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 120_000);
