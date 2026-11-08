/** Official rows force this provider, so a local `model_provider = "omlx"` cannot swallow GPT-5.6. */
export const OFFICIAL_CODEX_PROVIDER = "openai";

const SEP = "::";
export const CODEX_MODEL_ID = /^[\w][\w./:+-]*$/;

/** A Codex model id names its `~/.codex` provider as `provider::model`; a bare id is an official model. */
export function encodeCodexSelection(provider: string, model: string): string {
  return `${provider}${SEP}${model}`;
}

export function decodeCodexSelection(id: string | null | undefined): {
  model: string | null;
  modelProvider: string | null;
} {
  if (!id) return { model: null, modelProvider: null };
  const sep = id.indexOf(SEP);
  if (sep > 0) {
    return { model: id.slice(sep + SEP.length), modelProvider: id.slice(0, sep) };
  }
  // A bare id is official: a new cloud model must not fall through to the user's local provider.
  return { model: id, modelProvider: CODEX_MODEL_ID.test(id) ? OFFICIAL_CODEX_PROVIDER : null };
}
