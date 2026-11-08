import { describe, expect, it } from "vitest";

import { decodeCodexSelection, OFFICIAL_CODEX_PROVIDER } from "./codex-selection.ts";

describe("decodeCodexSelection", () => {
  it("forces official rows onto the ChatGPT provider", () => {
    expect(decodeCodexSelection("gpt-5.6-sol")).toEqual({
      model: "gpt-5.6-sol",
      modelProvider: OFFICIAL_CODEX_PROVIDER,
    });
  });

  it("forces newly discovered bare ids onto the ChatGPT provider too", () => {
    expect(decodeCodexSelection("gpt-future-codex")).toEqual({
      model: "gpt-future-codex",
      modelProvider: OFFICIAL_CODEX_PROVIDER,
    });
  });

  it("splits provider-encoded custom ids", () => {
    expect(decodeCodexSelection("omlx::Qwen3.6-35B-A3B-bf16:qwen3-5-6-n-r-reasoning")).toEqual({
      model: "Qwen3.6-35B-A3B-bf16:qwen3-5-6-n-r-reasoning",
      modelProvider: "omlx",
    });
  });
});
