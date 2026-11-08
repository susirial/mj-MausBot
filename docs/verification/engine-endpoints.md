# Independent Codex and Claude Code connections

Open **Settings → AI → API connections**. In advanced mode, use
**Settings → Engines → API connections**.

Select DeepSeek, Kimi, or a custom service. Choose Codex, Claude Code, or both.
Enter a connection name and API key, review each tool's address and model, and
save. Choosing both creates two independent instances.

The model picker lists these instances separately from official accounts.
Saving, opening settings, and refreshing the app do not send a model request.
Answer, tool, and background checks run only when clicked and may incur provider
charges. Each result applies to its model, connection revision, and CLI version.

Editing a connection keeps its key when the field is empty. Changing the service
or address requires a new key. A running connection rejects edits, preserving the
draft. Remove a connection after clearing its bot, task, and fallback references.

Official Codex and Claude Code accounts, ChatGPT plan, and existing Claude
endpoints retain their configuration. No migration is required. Each new instance
has an isolated CLI home and credentials.

## Offline protocol verification

Run from the repository root with Node 24 and pnpm 10:

```sh
node --experimental-strip-types scripts/verify-engine-endpoints.ts \
  --scenario parallel-isolation --evidence-dir /tmp/omb-endpoints/parallel

node --experimental-strip-types scripts/verify-engine-endpoints.ts \
  --scenario tool-roundtrip --evidence-dir /tmp/omb-endpoints/tools

node --experimental-strip-types scripts/verify-engine-endpoints.ts \
  --scenario background-route --evidence-dir /tmp/omb-endpoints/background

node --experimental-strip-types scripts/verify-engine-endpoints.ts \
  --scenario metadata-restart --evidence-dir /tmp/omb-endpoints/restart
```

Other scenarios are `official-regression`, `codex-deepseek`, `codex-kimi`,
`claude-deepseek`, `claude-kimi`, and `failure-states`.

Each run owns a temporary app, fake CLIs, and a loopback HTTP provider. It records
`result.json`, HTTP receipts, redacted endpoint requests, and server logs in the
specified directory, then closes its processes and removes temporary app data.
It does not use the user's app, real credentials, or remote model services.

## Complete application UI verification

Build the client, then run the real application in Chrome against its isolated
backend:

```sh
pnpm build
node --experimental-strip-types scripts/verify-engine-endpoints-ui.mjs \
  --evidence-dir /tmp/omb-endpoints/ui
```

The script creates Codex and Claude connections from settings, checks both,
selects a Codex model in the picker, sends a message, and reloads to verify the
selection and transcript. It writes `settings.png`, `picker.png`, `chat.png`, and
`result.json`. Google Chrome on macOS is the default; `OMB_CDP_CHROME` overrides
the executable path.

For a narrow form check:

```sh
OMB_ENDPOINT_BROWSER=1 pnpm exec vitest run \
  src/components/EngineEndpoints.browser.test.ts
```

## Compatibility limits

The Codex model catalog was checked with local Codex CLI 0.167.0. The fake
Claude CLI reports 2.1.296. Offline fixtures prove app routing, isolation,
persistence, and interaction; they do not certify real DeepSeek or Kimi
inference, quota, or tool support.
