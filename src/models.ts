// Model selection for the Anthropic/Claude Code bridge: free-model detection,
// Claude Code slot mapping, and resolution of model names clients send.

import type { Catalog, CatalogModel } from "./upstream.ts";

export type ClaudeAlias = "default" | "fable" | "opus" | "sonnet" | "haiku";

export const CLAUDE_ALIASES: ClaudeAlias[] = ["default", "fable", "opus", "sonnet", "haiku"];

export interface ModelChoice {
  id: string;
  name: string;
  description: string;
  multiplier: number;
  free: boolean;
}

export type ClaudeModelMap = Record<ClaudeAlias, ModelChoice>;

/** Last-resort mapping if the catalog cannot be fetched. */
const FALLBACKS: Record<ClaudeAlias, ModelChoice> = {
  default: { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", description: "DeepSeek V4.1 Flash · free unlimited", multiplier: 1, free: true },
  fable: { id: "particle", name: "Particle", description: "Particle · free unlimited", multiplier: 1, free: true },
  opus: { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", description: "DeepSeek V4.1 Flash · free unlimited", multiplier: 1, free: true },
  sonnet: { id: "glm-5.3-flash", name: "GLM 5.3 Flash", description: "GLM 5.3 Flash · free unlimited", multiplier: 1, free: true },
  haiku: { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", description: "DeepSeek V4 Flash · free unlimited", multiplier: 1, free: true },
};

/** Preferred free model for each Claude Code slot, used when available. */
const PREFERRED: Record<ClaudeAlias, string> = {
  default: "deepseek-v4.1-flash",
  fable: "particle",
  opus: "deepseek-v4.1-flash",
  sonnet: "glm-5.3-flash",
  haiku: "deepseek-v4-flash",
};

/** Catalog order fallback for each slot when its preferred model is gone. */
const POSITION: Record<ClaudeAlias, number> = { default: 0, fable: 1, opus: 0, sonnet: 2, haiku: 3 };

export function isFreeModel(m: CatalogModel): boolean {
  return m.free === true || /free unlimited/i.test(m.name);
}

export function availableModels(catalog: Catalog | null): CatalogModel[] {
  return (catalog?.models ?? []).filter((m) => !m.unavailable);
}

export function freeModels(catalog: Catalog | null): CatalogModel[] {
  return availableModels(catalog).filter(isFreeModel);
}

function cleanName(m: CatalogModel): string {
  return m.display_name || m.name.split(" · ")[0]?.trim() || m.id;
}

function describe(m: CatalogModel): string {
  const name = cleanName(m);
  if (isFreeModel(m)) return `${name} · free unlimited`;
  return `${name} · ~${m.multiplier}x usage`;
}

function toChoice(m: CatalogModel): ModelChoice {
  return {
    id: m.id,
    name: cleanName(m),
    description: describe(m),
    multiplier: m.multiplier,
    free: isFreeModel(m),
  };
}

/** Map the current catalog onto Claude Code's model slots. Free models are
 * preferred; if the lineup changes we fall back to catalog order, then to the
 * built-in defaults when the catalog is unavailable. */
export function pickClaudeModels(catalog: Catalog | null): ClaudeModelMap {
  const free = freeModels(catalog);
  const pool = free.length ? free : availableModels(catalog);

  const pick = (alias: ClaudeAlias): ModelChoice => {
    const preferred = pool.find((m) => m.id === PREFERRED[alias]);
    if (preferred) return toChoice(preferred);
    const m = pool[POSITION[alias]] ?? pool[0];
    return m ? toChoice(m) : FALLBACKS[alias];
  };

  return {
    default: pick("default"),
    fable: pick("fable"),
    opus: pick("opus"),
    sonnet: pick("sonnet"),
    haiku: pick("haiku"),
  };
}

/** Resolve a model name from an Anthropic client to a free-pi catalog id.
 * Accepts free-pi ids, `freepi/<id>`, alias names (default/opus/…), and Claude
 * family names; anything unknown falls back to the default so Claude Code
 * cannot wedge on a model id the proxy does not know. */
export function resolveModel(catalog: Catalog | null, requested?: string | null): string {
  const map = pickClaudeModels(catalog);
  const raw = (requested ?? "").trim();
  if (!raw) return map.default.id;

  const id = raw.replace(/^freepi\//i, "");
  const lower = id.toLowerCase();

  if (lower === "default" || lower === "free" || lower === "auto") return map.default.id;
  if (CLAUDE_ALIASES.includes(lower as ClaudeAlias)) return map[lower as ClaudeAlias].id;

  const available = availableModels(catalog);
  const exact = available.find((m) => m.id === id);
  if (exact) return exact.id;

  // Catalog not loaded yet (proxy just started): accept a free-pi-shaped id
  // rather than replacing it with the fallback default.
  if (!available.length && !lower.startsWith("claude-")) return id;

  if (lower.startsWith("claude-")) {
    if (lower.includes("haiku")) return map.haiku.id;
    if (lower.includes("sonnet")) return map.sonnet.id;
    if (lower.includes("opus")) return map.opus.id;
    if (lower.includes("fable")) return map.fable.id;
    return map.default.id;
  }

  // Provider-prefixed ids (e.g. deepseek/deepseek-v4.1-flash).
  const tail = id.split("/").pop() ?? id;
  const tailMatch = available.find((m) => m.id === tail);
  if (tailMatch) return tailMatch.id;

  console.warn(`[freepi-proxy] unknown model "${raw}" — using ${map.default.id}`);
  return map.default.id;
}

/** Human-readable name for a catalog id, falling back to the id itself. */
export function modelName(catalog: Catalog | null, id: string): string {
  const m = availableModels(catalog).find((x) => x.id === id);
  return m ? cleanName(m) : id;
}

/** All free models as choices, in catalog order. */
export function freeModelChoices(catalog: Catalog | null): ModelChoice[] {
  return freeModels(catalog).map(toChoice);
}

/** All available models as choices, in catalog order. */
export function allModelChoices(catalog: Catalog | null): ModelChoice[] {
  return availableModels(catalog).map(toChoice);
}

/** Which Claude slots currently point at a given model id. */
export function aliasesFor(map: ClaudeModelMap, id: string): ClaudeAlias[] {
  return CLAUDE_ALIASES.filter((a) => map[a].id === id);
}
