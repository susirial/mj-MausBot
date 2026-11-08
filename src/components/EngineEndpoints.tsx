import { useEffect, useRef, useState, type ReactNode } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { EndpointConnection, EndpointCheckKind, EndpointCheckResult, EndpointModel, EndpointProvider, EndpointRuntime } from "../../shared/engine-endpoint";
import { api, ApiError, useStore, type InstanceInfo } from "@/state/store";
import { ENDPOINT_STATUS_COPY, endpointCheckFor, endpointModelStatus, endpointServiceLabel } from "@/lib/engine-connection-status";
import { t } from "@/lib/i18n";
import { Select } from "./Select";
import { ConfirmDialog } from "./ConfirmDialog";
import { KEY_FIELD } from "./keys/KeyRow";

type Preset = { id: string; label: string; endpoint: EndpointConnection; sources: string[] };
type LoadResult = { instanceId: string; state: "loaded" | "unavailable"; reason?: string };
type SaveResult = { committed?: true; instances: InstanceInfo[]; loadResults?: LoadResult[] };
const RUNTIMES: EndpointRuntime[] = ["codex", "claude"];
const ROLES = ["opus", "sonnet", "haiku", "fable", "subagent"] as const;
const CHECKS: EndpointCheckKind[] = ["answer", "tools", "background"];
const runtimeLabel = (runtime: EndpointRuntime) => runtime === "codex" ? "Codex" : "Claude Code";
const messageOf = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

function blankModel(): EndpointModel {
  return { id: "", label: "", source: "configured", inputModalities: ["text"], effortLevels: [], nativeSearch: "unknown" };
}

function initialConnection(runtime: EndpointRuntime, provider: EndpointProvider, presets: Preset[]): EndpointConnection {
  const preset = presets.find((entry) => entry.endpoint.provider === provider && entry.endpoint.runtime === runtime);
  if (preset) return structuredClone(preset.endpoint);
  const base = {
    version: 1, revision: 1, provider, baseUrl: "", catalog: { default: "", options: [blankModel()] }, backgroundModel: "",
  } as const;
  return runtime === "codex"
    ? { ...base, runtime, protocol: "responses", webSearch: "disabled", catalog: { default: "", options: [blankModel()] } }
    : { ...base, runtime, protocol: "anthropic", catalog: { default: "", options: [blankModel()] },
      roleModels: { opus: "", sonnet: "", haiku: "", fable: "", subagent: "" } };
}

function validConnection(endpoint: EndpointConnection): boolean {
  try {
    const url = new URL(endpoint.baseUrl);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return false;
  } catch { return false; }
  const options = endpoint.catalog.options;
  const ids = new Set(options.map((model) => model.id));
  if (!options.length || ids.size !== options.length || options.some((model) => !model.id.trim() || model.id.length > 160
    || Array.from(model.id).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
    || (model.contextWindow !== undefined && (!Number.isInteger(model.contextWindow) || model.contextWindow <= 0)))) return false;
  if (!ids.has(endpoint.catalog.default) || !ids.has(endpoint.backgroundModel)) return false;
  const selected = options.find((model) => model.id === endpoint.catalog.default);
  if (endpoint.defaultEffort && !selected?.effortLevels.includes(endpoint.defaultEffort)) return false;
  if (endpoint.runtime === "codex") return endpoint.webSearch !== "live" || selected?.nativeSearch === "supported";
  if (!Object.values(endpoint.roleModels).every((id) => ids.has(id))) return false;
  return endpoint.autoCompactTokens === undefined || Boolean(selected?.contextWindow
    && Number.isInteger(endpoint.autoCompactTokens) && endpoint.autoCompactTokens > 0 && endpoint.autoCompactTokens < selected.contextWindow);
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="flex min-w-0 flex-col gap-1 text-[12px] font-medium text-ink">{label}{children}</label>;
}

function ConnectionFields({ endpoint, onChange }: { endpoint: EndpointConnection; onChange: (next: EndpointConnection) => void }) {
  const runtime = runtimeLabel(endpoint.runtime);
  const options = endpoint.catalog.options;
  const selected = options.find((model) => model.id === endpoint.catalog.default);
  const modelSelect = (label: string, value: string, change: (id: string) => void) => (
    <Field key={label} label={label}><Select aria-label={`${runtime} ${label}`} value={value} onChange={(event) => change(event.target.value)}>
      {options.map((model, index) => <option key={index} value={model.id}>{model.label || model.id}</option>)}
    </Select></Field>
  );
  const changeModel = (index: number, patch: Partial<EndpointModel>) => {
    const old = options[index];
    if (!old) return;
    const updated = { ...old, ...patch, source: "configured" as const };
    const next = { ...endpoint, catalog: { ...endpoint.catalog, options: options.map((model, position) => position === index ? updated : model) } };
    if (patch.id !== undefined && patch.id !== old.id) {
      if (next.catalog.default === old.id) next.catalog.default = patch.id;
      if (next.backgroundModel === old.id) next.backgroundModel = patch.id;
      if (next.runtime === "claude") {
        const id = patch.id;
        const roles = next.roleModels;
        next.roleModels = {
          opus: roles.opus === old.id ? id : roles.opus, sonnet: roles.sonnet === old.id ? id : roles.sonnet,
          haiku: roles.haiku === old.id ? id : roles.haiku, fable: roles.fable === old.id ? id : roles.fable,
          subagent: roles.subagent === old.id ? id : roles.subagent,
        };
      }
    }
    onChange(next);
  };
  return <fieldset className="min-w-0 space-y-2 rounded-xl border border-hairline/50 p-3">
    <legend className="px-1 text-[13px] font-medium text-ink">{runtime}</legend>
    <Field label={t("engineEndpoints.address", { runtime })}>
      <input className={KEY_FIELD} aria-label={t("engineEndpoints.address", { runtime })} type="url" maxLength={2048}
        value={endpoint.baseUrl} onChange={(event) => onChange({ ...endpoint, baseUrl: event.target.value })} required />
    </Field>
    {modelSelect(t("engineEndpoints.default", { runtime }), endpoint.catalog.default, (id) => onChange({
      ...endpoint, defaultEffort: undefined, catalog: { ...endpoint.catalog, default: id },
      ...endpoint.runtime === "codex" ? { webSearch: "disabled" } : {},
    }))}
    {options.length === 1 && <Field label={t("engineEndpoints.modelId", { runtime })}>
      <input className={KEY_FIELD} aria-label={t("engineEndpoints.modelId", { runtime })} maxLength={160}
        value={options[0]?.id ?? ""} onChange={(event) => changeModel(0, { id: event.target.value })} required />
    </Field>}
    <details className="text-[12px] text-ink-secondary">
      <summary className="cursor-pointer py-1 hover:text-ink">{t("engineEndpoints.advanced")}</summary>
      <div className="mt-2 space-y-2">
        {modelSelect(t("engineEndpoints.background"), endpoint.backgroundModel, (id) => onChange({ ...endpoint, backgroundModel: id }))}
        {endpoint.runtime === "claude" && ROLES.map((role) => modelSelect(t("engineEndpoints.role", { role }), endpoint.roleModels[role],
          (id) => onChange({ ...endpoint, roleModels: { ...endpoint.roleModels, [role]: id } })))}
        <Field label={t("engineEndpoints.effort")}><Select value={endpoint.defaultEffort ?? ""} aria-label={`${runtime} ${t("engineEndpoints.effort")}`}
          onChange={(event) => onChange({ ...endpoint, defaultEffort: selected?.effortLevels.find((level) => level === event.target.value) })}>
          <option value="">{t("model.effort.default")}</option>
          {selected?.effortLevels.map((level) => <option key={level} value={level}>{level}</option>)}
        </Select></Field>
        {endpoint.runtime === "codex" ? <Field label={t("engineEndpoints.search")}><Select value={endpoint.webSearch}
          onChange={(event) => onChange({ ...endpoint, webSearch: event.target.value === "live" ? "live" : "disabled" })}>
          <option value="disabled">{t("engineEndpoints.searchOff")}</option>
          <option value="live" disabled={selected?.nativeSearch !== "supported"}>{t("engineEndpoints.searchLive")}</option>
        </Select></Field> : <Field label={t("engineEndpoints.compact")}><input type="number" className={KEY_FIELD}
          aria-label={`${runtime} ${t("engineEndpoints.compact")}`} disabled={!selected?.contextWindow}
          min={1} max={selected?.contextWindow ? selected.contextWindow - 1 : undefined} value={endpoint.autoCompactTokens ?? ""}
          onChange={(event) => onChange({ ...endpoint, autoCompactTokens: event.target.value ? Number(event.target.value) : undefined })} /></Field>}
        {options.map((model, index) => <div key={index} className="space-y-2 rounded-lg border border-hairline/40 p-2">
          <Field label={t("engineEndpoints.modelId", { runtime })}><input className={KEY_FIELD}
            aria-label={`${runtime} ${t("engineEndpoints.modelId", { runtime })} ${index + 1}`} maxLength={160} value={model.id}
            onChange={(event) => changeModel(index, { id: event.target.value })} /></Field>
          <Field label={t("engineEndpoints.modelLabel")}><input className={KEY_FIELD} value={model.label} maxLength={160}
            onChange={(event) => changeModel(index, { label: event.target.value })} /></Field>
          <Field label={t("engineEndpoints.context")}><input type="number" min={1} className={KEY_FIELD} value={model.contextWindow ?? ""}
            onChange={(event) => changeModel(index, { contextWindow: event.target.value ? Number(event.target.value) : undefined })} /></Field>
          <button type="button" className="ui-button text-danger" disabled={options.length === 1}
            onClick={() => onChange({ ...endpoint, catalog: { ...endpoint.catalog, options: options.filter((_, position) => position !== index) } })}>
            {t("engineEndpoints.removeModel")}
          </button>
        </div>)}
        <button type="button" className="ui-button" onClick={() => onChange({ ...endpoint,
          catalog: { ...endpoint.catalog, options: [...options, blankModel()] } })}>{t("engineEndpoints.addModel")}</button>
      </div>
    </details>
  </fieldset>;
}

function EndpointForm({ instance, presets, onDone, onSaved }: {
  instance?: InstanceInfo; presets: Preset[]; onDone: () => void; onSaved: (result: SaveResult) => void;
}) {
  const existing = instance?.engineEndpoint;
  const [name, setName] = useState(instance?.displayName ?? "");
  const [key, setKey] = useState("");
  const [provider, setProvider] = useState<EndpointProvider>(existing?.provider ?? (presets.length ? "deepseek" : "custom"));
  const [runtime, setRuntime] = useState<EndpointRuntime | "both">(existing?.runtime ?? "codex");
  const [connections, setConnections] = useState<EndpointConnection[]>(() => {
    if (!existing) return RUNTIMES.map((tool) => initialConnection(tool, presets.length ? "deepseek" : "custom", presets));
    const { keyConfigured: _key, check: _check, checks: _checks, ...configuration } = existing;
    return [structuredClone(configuration)];
  });
  const [cli, setCli] = useState(instance?.cli ?? "");
  const [revision] = useState(existing?.revision);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(false);
  const request = useRef<{ path: string; method: "POST" | "PATCH"; body: string } | null>(null);
  const savingRef = useRef(false);
  const selected = connections.filter((connection) => runtime === "both" || connection.runtime === runtime);
  const addressChanged = existing && selected.some((connection) => connection.provider !== existing.provider
    || connection.baseUrl.replace(/\/+$/, "") !== existing.baseUrl.replace(/\/+$/, ""));
  const ready = name.trim() && selected.every(validConnection) && (instance && !addressChanged || key.trim());
  const locked = saving || retry;
  const save = async () => {
    if (savingRef.current || (!retry && !ready)) return;
    savingRef.current = true;
    setSaving(true);
    setError("");
    if (!request.current || instance) {
      const normalized = selected.map((endpoint): EndpointConnection => ({
        ...endpoint, catalog: { ...endpoint.catalog, options: endpoint.catalog.options.map((model) => ({ ...model, label: model.label || model.id })) },
      }));
      if (instance && normalized[0]) {
        const { runtime: _runtime, revision: _revision, ...endpointPatch } = normalized[0];
        request.current = {
          path: `/api/instances/${encodeURIComponent(instance.instanceId)}/engine-endpoint`, method: "PATCH",
          body: JSON.stringify({ expectedRevision: revision, endpointPatch, displayName: name.trim(),
            ...(cli !== (instance.cli ?? "") ? { cli } : {}), ...(key.trim() ? { apiKey: key.trim() } : {}) }),
        };
      } else {
        request.current = {
          path: "/api/instances/engine-endpoints", method: "POST",
          body: JSON.stringify({ operationId: crypto.randomUUID(), displayName: name.trim(), provider, apiKey: key.trim(),
            connections: normalized.map((endpoint) => ({ ...endpoint, revision: 1 })) }),
        };
      }
    }
    try {
      const result = await api<SaveResult>(request.current.path, { method: request.current.method, body: request.current.body });
      setKey("");
      request.current = null;
      onSaved(result);
      onDone();
    } catch (cause) {
      setError(cause instanceof ApiError && cause.status === 409 ? `${t("engineEndpoints.conflict")} ${cause.message}` : messageOf(cause));
      if (!instance) setRetry(true);
    } finally { savingRef.current = false; setSaving(false); }
  };
  return <form data-engine-endpoint-form={instance?.instanceId ?? "new"} className="space-y-3 rounded-xl border border-hairline/50 bg-inset p-3"
    onSubmit={(event) => { event.preventDefault(); void save(); }}>
    <fieldset disabled={locked} className="min-w-0 space-y-3">
      <Field label={t("engineEndpoints.provider")}><Select aria-label={t("engineEndpoints.provider")} value={provider} onChange={(event) => {
        const next = event.target.value;
        if (next !== "deepseek" && next !== "kimi" && next !== "custom") return;
        setProvider(next);
        if (instance) setConnections((current) => current.map((endpoint) => ({ ...endpoint, provider: next })));
        else setConnections(RUNTIMES.map((tool) => initialConnection(tool, next, presets)));
      }}>
        <option value="deepseek" disabled={!instance && !presets.some((preset) => preset.endpoint.provider === "deepseek")}>DeepSeek</option>
        <option value="kimi" disabled={!instance && !presets.some((preset) => preset.endpoint.provider === "kimi")}>Kimi</option>
        <option value="custom">{t("engineEndpoints.custom")}</option>
      </Select></Field>
      {!instance && <Field label={t("engineEndpoints.runtime")}><Select aria-label={t("engineEndpoints.runtime")} value={runtime} onChange={(event) => {
        const value = event.target.value;
        if (value === "codex" || value === "claude" || value === "both") setRuntime(value);
      }}><option value="codex">Codex</option><option value="claude">Claude Code</option><option value="both">{t("engineEndpoints.both")}</option></Select></Field>}
      <Field label={t("engineEndpoints.name")}><input className={KEY_FIELD} aria-label={t("engineEndpoints.name")} maxLength={80}
        value={name} onChange={(event) => setName(event.target.value)} required autoFocus /></Field>
      <Field label={t("engineEndpoints.key")}><input className={KEY_FIELD} type="password" aria-label={t("engineEndpoints.key")}
        value={key} onChange={(event) => setKey(event.target.value)} maxLength={4096} autoComplete="off"
        placeholder={instance ? t("engineEndpoints.keyKeep") : ""} /></Field>
      {instance && <p className="text-[12px] text-ink-secondary">{t("engineEndpoints.editHint")}</p>}
      {selected.map((endpoint) => <ConnectionFields key={endpoint.runtime} endpoint={endpoint}
        onChange={(next) => setConnections((current) => current.map((value) => value.runtime === next.runtime ? next : value))} />)}
      {instance && <Field label={t("engineEndpoints.cli")}><input className={KEY_FIELD} value={cli} maxLength={2048}
        onChange={(event) => setCli(event.target.value)} aria-label={t("engineEndpoints.cli")} /></Field>}
    </fieldset>
    {!ready && name && <p className="text-[12px] text-ink-secondary">{t("engineEndpoints.invalid")}</p>}
    {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
    {retry && <p className="text-[12px] text-ink-secondary">{t("engineEndpoints.retryHint")}</p>}
    <div className="flex justify-end gap-2">
      <button type="button" className="ui-button" disabled={saving} onClick={() => { setKey(""); request.current = null; onDone(); }}>{t("common.cancel")}</button>
      <button type="submit" className="ui-button bg-accent text-white" disabled={saving || (!retry && !ready)}>
        {saving ? t("common.checking") : t(retry ? "engineEndpoints.retry" : "common.save")}
      </button>
    </div>
  </form>;
}

function EndpointRow({ instance, onEdit, onSaved, readOnly, editorOpen }: {
  instance: InstanceInfo; onEdit: () => void; onSaved: (result: SaveResult) => void; readOnly: boolean; editorOpen: boolean;
}) {
  const { state } = useStore();
  const endpoint = instance.engineEndpoint;
  const [model, setModel] = useState(endpoint?.catalog.default ?? "");
  const [localChecks, setLocalChecks] = useState<EndpointCheckResult[]>([]);
  const [checking, setChecking] = useState<EndpointCheckKind | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState("");
  const busy = useRef(false);
  const checkIdentity = useRef("");
  checkIdentity.current = `${endpoint?.revision}\n${instance.snapshot.version}`;
  useEffect(() => { setLocalChecks([]); }, [endpoint?.revision, instance.snapshot.version]);
  if (!endpoint) return <li data-engine-endpoint={instance.instanceId} className="space-y-2 px-3 py-3">
    <p className="text-[13px] font-medium text-ink">{instance.displayName}</p>
    <p role="status" className="break-words text-[12px] text-warning">
      {instance.snapshot.reason || t("engineEndpoints.status.cli")}
    </p>
  </li>;
  const usedBy = state.bots.filter((bot) => bot.modelSelection.instanceId === instance.instanceId
    || bot.fallback?.some((selection) => selection.instanceId === instance.instanceId)
    || bot.tasks?.some((task) => task.modelSelection?.instanceId === instance.instanceId)).length;
  const checkFor = (kind: EndpointCheckKind): EndpointCheckResult => localChecks.find((check) => check.state !== "unverified" && check.model === model && check.kind === kind)
    ?? endpointCheckFor(instance, model, kind);
  const runCheck = async (kind: EndpointCheckKind) => {
    if (busy.current) return;
    busy.current = true;
    setChecking(kind);
    setError("");
    const identity = checkIdentity.current;
    try {
      const { check } = await api<{ check: EndpointCheckResult }>(`/api/instances/${encodeURIComponent(instance.instanceId)}/engine-endpoint/check`, {
        method: "POST", body: JSON.stringify({ model, kind }),
      });
      if (checkIdentity.current === identity) setLocalChecks((current) => [
        ...current.filter((result) => result.state === "unverified" || result.model !== model || result.kind !== kind), check,
      ]);
    } catch (cause) { setError(messageOf(cause)); }
    finally { busy.current = false; setChecking(null); }
  };
  const remove = async () => {
    if (busy.current) return;
    busy.current = true;
    setRemoving(true);
    setError("");
    try {
      onSaved(await api<SaveResult>(`/api/instances/${encodeURIComponent(instance.instanceId)}`, { method: "DELETE" }));
      setConfirming(false);
    } catch (cause) { setError(messageOf(cause)); setConfirming(false); }
    finally { busy.current = false; setRemoving(false); }
  };
  return <li data-engine-endpoint={instance.instanceId} className="space-y-2 px-3 py-3">
    <div className="flex flex-wrap items-center gap-2">
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium text-ink">{instance.displayName}</p>
        <p className="text-[12px] text-ink-secondary">{endpointServiceLabel(instance)}</p>
        <p className="break-all font-mono text-[11px] text-ink-secondary">{endpoint.baseUrl}</p>
      </div>
      {!readOnly && <>
        <button type="button" className="ui-button" disabled={editorOpen || checking !== null || removing} onClick={onEdit}>{t("claudeEndpoints.edit")}</button>
        <button type="button" className="ui-button text-danger" disabled={editorOpen || checking !== null || removing || usedBy > 0}
          aria-label={t("claudeEndpoints.remove", { name: instance.displayName })} onClick={() => setConfirming(true)}><Trash2 size={14} /></button>
      </>}
    </div>
    {instance.snapshot.state === "unavailable" && <p role="status" className="text-[12px] text-warning">{t("engineEndpoints.savedUnavailable")} {instance.snapshot.reason}</p>}
    {usedBy > 0 && <p className="text-[12px] text-ink-secondary">{t("accounts.inUse", { count: String(usedBy) })}</p>}
    <Field label={t("engineEndpoints.checkModel")}><Select aria-label={t("engineEndpoints.checkModel")} value={model}
      disabled={checking !== null || removing} onChange={(event) => setModel(event.target.value)}>
      {!endpoint.catalog.options.some((option) => option.id === model) && <option value={model} disabled>{model}</option>}
      {endpoint.catalog.options.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
    </Select></Field>
    <p className="text-[12px] text-ink-secondary">{t("engineEndpoints.checkCost")}</p>
    <div className="flex flex-wrap gap-2">
      {CHECKS.map((kind) => {
        const result = checking === kind ? { state: "checking", model, kind } as const : checkFor(kind);
        const status = endpointModelStatus(instance, model, result);
        return <div key={kind} className="min-w-0 space-y-1">
          {!readOnly && <button type="button" className="ui-button" disabled={editorOpen || checking !== null || removing
            || !endpointModelStatus(instance, model, { state: "unverified" }).canSelect} onClick={() => void runCheck(kind)}>{t(`engineEndpoints.check.${kind}`)}</button>}
          <p data-endpoint-check={kind} role="status" className="text-[11px] text-ink-secondary">{t(`engineEndpoints.check.${kind}`)} · {t(ENDPOINT_STATUS_COPY[status.kind])}</p>
          {result.state === "failed" && <p className="max-w-sm break-words text-[12px] text-danger">{result.message}</p>}
          {result.state === "passed" && <p className="text-[11px] text-ink-secondary">{new Date(result.checkedAt).toLocaleString()}
            {result.reportedModel && ` · ${t("engineEndpoints.reported", { model: result.reportedModel })}`}</p>}
        </div>;
      })}
    </div>
    {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
    <ConfirmDialog open={confirming} title={t("accounts.removeTitle", { name: instance.displayName })} body={t("engineEndpoints.removeBody")}
      confirmLabel={t("accounts.remove")} pending={removing} tone="neutral" onCancel={() => { if (!removing) setConfirming(false); }} onConfirm={() => void remove()} />
  </li>;
}

export function EngineEndpoints({ readOnly = false }: { readOnly?: boolean }) {
  const { state, dispatch } = useStore();
  const [presets, setPresets] = useState<Preset[]>([]);
  const [presetError, setPresetError] = useState("");
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<SaveResult | null>(null);
  const endpoints = state.instances.filter((instance) => instance.engineEndpoint || instance.independentEndpoint);
  useEffect(() => {
    if (readOnly) { setLoading(false); return; }
    let alive = true;
    api<{ presets: Preset[] }>("/api/engine-endpoint-presets")
      .then((result) => { if (alive) setPresets(result.presets); })
      .catch((cause) => { if (alive) setPresetError(messageOf(cause)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [readOnly]);
  const saved = (result: SaveResult) => {
    dispatch({ type: "instances", instances: result.instances });
    setReceipt(result);
  };
  if (readOnly && !endpoints.length) return null;
  return <section data-engine-endpoints className="space-y-3">
    <h2 className="text-[13px] font-medium text-ink">{t("engineEndpoints.title")}</h2>
    <p className="text-[12px] leading-relaxed text-ink-secondary">{t("engineEndpoints.hint")}</p>
    {presetError && <p role="alert" className="text-[12px] text-danger">{presetError}</p>}
    {receipt && <div role="status" className="text-[12px] text-ink-secondary">
      <p>{t("engineEndpoints.saved")}</p>
      {receipt.loadResults?.filter((result) => result.state === "unavailable").map((result) =>
        <p key={result.instanceId} className="text-warning">{t("engineEndpoints.savedUnavailable")} · {result.instanceId} · {result.reason}</p>)}
    </div>}
    {!endpoints.length && <p className="text-[12px] text-ink-secondary">{t("engineEndpoints.empty")}</p>}
    <ul className="divide-y divide-hairline/40 rounded-xl border border-hairline/50 bg-panel/40">
      {endpoints.map((instance) => open === instance.instanceId && !instance.readOnly && !readOnly
        ? <li key={instance.instanceId} className="p-3"><EndpointForm instance={instance} presets={presets} onDone={() => setOpen(null)} onSaved={saved} /></li>
        : <EndpointRow key={instance.instanceId} instance={instance} onEdit={() => setOpen(instance.instanceId)} onSaved={saved}
          editorOpen={open !== null} readOnly={readOnly || Boolean(instance.readOnly || instance.managed || instance.policy)} />)}
    </ul>
    {!readOnly && (open === "new" ? <EndpointForm presets={presets} onDone={() => setOpen(null)} onSaved={saved} />
      : <button type="button" className="ui-button flex items-center gap-1.5" disabled={loading || open !== null}
        onClick={() => { setReceipt(null); setOpen("new"); }}><Plus size={14} />{t("engineEndpoints.add")}</button>)}
  </section>;
}
