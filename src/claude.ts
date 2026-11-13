#!/usr/bin/env node
// Build a Claude Code settings profile that points at freepi-proxy.
//
// `freepi-proxy claude` runs this, captures the JSON, and passes it to
// `claude --settings '<json>'`. Printing settings (rather than writing a file)
// keeps the user's ~/.claude/settings.json untouched.

import { DASHBOARD_URL, PORT } from "./config.ts";
import { CLAUDE_ALIASES } from "./models.ts";
import type { ClaudeAlias, ClaudeModelMap, ModelChoice } from "./models.ts";

const BASE = (process.env.FREEPI_PROXY_URL || `http://127.0.0.1:${process.env.FREEPI_PROXY_PORT || PORT}`)
  .replace(/\/+$/, "");

interface ClaudeConfig {
  baseUrl: string;
  models: ClaudeModelMap;
  free: ModelChoice[];
  all: ModelChoice[];
}

interface Args {
  list: boolean;
  help: boolean;
  overrides: Partial<Record<ClaudeAlias, string>>;
}

function need(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a model id`);
  return value;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { list: false, help: false, overrides: {} };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--list") {
      args.list = true;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else if (arg === "--model") {
      args.overrides.default = need(argv, ++i, arg);
    } else if (arg.startsWith("--model=")) {
      args.overrides.default = arg.slice("--model=".length);
    } else if (arg.startsWith("--") && arg.includes("=")) {
      const [flag, ...rest] = arg.split("=");
      const alias = (flag ?? "").slice(2) as ClaudeAlias;
      if (!CLAUDE_ALIASES.includes(alias) || alias === "default") {
        throw new Error(`unknown option: ${flag}`);
      }
      args.overrides[alias] = rest.join("=");
    } else if (arg.startsWith("--")) {
      const alias = arg.slice(2) as ClaudeAlias;
      if (!CLAUDE_ALIASES.includes(alias) || alias === "default") {
        throw new Error(`unknown option: ${arg}`);
      }
      args.overrides[alias] = need(argv, ++i, arg);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return args;
}

async function fetchConfig(): Promise<ClaudeConfig> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/api/claude/config`, { signal: AbortSignal.timeout(8_000) });
  } catch (e) {
    throw new Error(
      `cannot reach the proxy at ${BASE} (${e instanceof Error ? e.message : String(e)}). ` +
      "Start it with: freepi-proxy start -d",
    );
  }
  if (!res.ok) throw new Error(`proxy returned HTTP ${res.status} for /api/claude/config`);
  return await res.json() as ClaudeConfig;
}

function choiceFor(config: ClaudeConfig, requested: string): ModelChoice {
  const id = requested.replace(/^freepi\//i, "").trim();
  if (!id) throw new Error("model id cannot be empty");
  const known = [...config.all, ...config.free, ...Object.values(config.models)]
    .find((m) => m.id === id);
  if (known) return known;
  if (!config.all.length) {
    // Catalog not loaded yet: let the id through rather than blocking launch.
    return { id, name: id, description: `${id} · free-pi`, multiplier: 1, free: false };
  }
  throw new Error(`unknown model "${requested}". Run: freepi-proxy claude --list`);
}

function buildEnv(config: ClaudeConfig, models: ClaudeModelMap): Record<string, string> {
  const env: Record<string, string> = {
    ANTHROPIC_BASE_URL: (config.baseUrl || DASHBOARD_URL).replace(/\/+$/, ""),
    ANTHROPIC_AUTH_TOKEN: "freepi-local",
    ANTHROPIC_MODEL: models.default.id,
    ANTHROPIC_CUSTOM_MODEL_OPTION: models.default.id,
    ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: models.default.name,
    ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION: models.default.description,
    ANTHROPIC_SMALL_FAST_MODEL: models.haiku.id,
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: "200000",
  };
  for (const alias of CLAUDE_ALIASES) {
    if (alias === "default") continue;
    const key = alias.toUpperCase();
    env[`ANTHROPIC_DEFAULT_${key}_MODEL`] = models[alias].id;
    env[`ANTHROPIC_DEFAULT_${key}_MODEL_NAME`] = models[alias].name;
    env[`ANTHROPIC_DEFAULT_${key}_MODEL_DESCRIPTION`] = models[alias].description;
  }
  return env;
}

function printList(config: ClaudeConfig): void {
  const map = config.models;
  console.log("free-pi models for Claude Code\n");
  console.log("Free unlimited:");
  for (const model of config.free) {
    const slots = CLAUDE_ALIASES.filter((alias) => map[alias].id === model.id);
    const suffix = slots.length ? `  → ${slots.join(", ")}` : "";
    console.log(`  ${model.id.padEnd(30)} ${model.name}${suffix}`);
  }

  const paid = config.all.filter((m) => !m.free);
  if (paid.length) {
    console.log("\nOther available models (select with --model ID):");
    for (const model of paid) console.log(`  ${model.id.padEnd(30)} ${model.description}`);
  }

  console.log("\nCurrent mapping:");
  for (const alias of CLAUDE_ALIASES) {
    console.log(`  ${alias.padEnd(8)} → ${map[alias].id}  (${map[alias].name})`);
  }
  console.log("\nChange a slot: freepi-proxy claude --model ID | --fable ID | --opus ID | --sonnet ID | --haiku ID");
}

function printHelp(): void {
  console.log(`Usage: freepi-proxy claude [options] [-- <claude args>]

Launches Claude Code against the local freepi-proxy using the latest free-pi
models. The proxy is started automatically if it is not running.

Options:
  --model ID     default model (also used by Claude Code's main slot)
  --fable ID     model for the Fable slot
  --opus ID      model for the Opus slot
  --sonnet ID    model for the Sonnet slot
  --haiku ID     model for the Haiku / small-fast slot
  --list         list free models and the current mapping
  -h, --help     show this help

Anything else is passed to Claude Code. Use -- before Claude Code flags that
could collide with the options above (for example: freepi-proxy claude -- -p "hi").`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const config = await fetchConfig();
  if (args.list) {
    printList(config);
    return;
  }

  const models: ClaudeModelMap = { ...config.models };
  for (const alias of CLAUDE_ALIASES) {
    const requested = args.overrides[alias];
    if (requested) models[alias] = choiceFor(config, requested);
  }

  process.stdout.write(JSON.stringify({ env: buildEnv(config, models) }));
}

main().catch((error: unknown) => {
  console.error(`freepi-proxy claude: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
