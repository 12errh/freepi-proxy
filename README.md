# freepi-proxy

A **zero-dependency** local proxy, dashboard, chat UI, and MCP server for
[free-pi](https://freepi.ai) (ad-supported, community-funded inference).

- **OpenAI-compatible** completions at `/v1` — point any agent that speaks the OpenAI API at it
- **Anthropic-compatible** Messages API at `/v1/messages` — Claude Code works through `freepi-proxy claude`
- **MCP server** at `/mcp` — `generate_image`, `web_search`, `docs_lookup`, `check_usage`
- **Dashboard** at `/` — credits/allowance, burn & request log, model catalog, and a built-in **Chat** page
- **Auth handled for you** — GitHub device-flow login in the UI; reuses the same credential file as `free-pi-cli`

> **Unofficial.** This project is not affiliated with free-pi/freepi.ai. It talks to the same backend
> the `free-pi-cli` uses; upstream behavior and client checks can change.

## Requirements

- **Node.js ≥ 22.19** *or* **Bun** — no `npm install`, no build step
- A free-pi account (created via the dashboard login or `npx free-pi-cli@latest`)

## Quick start

```sh
# foreground
node src/main.ts

# or background via the launcher
./freepi-proxy start -d

# Bun
bun src/main.ts
```

Then open **http://127.0.0.1:8452** and log in (GitHub device flow). The token is stored at
`~/.free-pi/agent/credentials.json` (mode `0600`, shared with `free-pi-cli`).

The proxy binds to **`127.0.0.1` only** and requires no API key of its own.

## CLI (`freepi-proxy`)

The `freepi-proxy` launcher (symlink it somewhere on your `PATH`, e.g. `~/.local/bin/freepi-proxy`):

| Command | What it does |
|---|---|
| `freepi-proxy start` | Run in the foreground (Ctrl+C to stop) |
| `freepi-proxy start -d` | Start in the background |
| `freepi-proxy stop` / `restart` | Stop or restart the background proxy |
| `freepi-proxy status` | Running state + account/credits summary |
| `freepi-proxy logs [-f] [n]` | Show/follow the log (`~/.freepi-proxy/proxy.log`) |
| `freepi-proxy open` | Open the dashboard in your browser |
| `freepi-proxy models` | List models from the live catalog |
| `freepi-proxy claude` | Launch Claude Code in the current project using free-pi models |

## Connect an agent (OpenAI-compatible)

Point any OpenAI-format client at the proxy and use **any non-empty** API key (the proxy injects your real JWT):

```sh
OPENAI_BASE_URL=http://127.0.0.1:8452/v1
OPENAI_API_KEY=local
```

Model IDs come from the live catalog (e.g. `glm-5.3-flash`, `deepseek-v4-flash`, `gpt-6-luna`,
`solar-pro-4`, `gemma-4-uncensored`). The dashboard **Models** tab and `freepi-proxy models` show the current list, multipliers, and availability.

### OpenCode

Example global config (`~/.config/opencode/opencode.json`) using the proxy as an OpenAI-compatible provider plus the MCP tools:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "freepi/glm-5.3-flash",
  "providers": {
    "freepi": {
      "name": "free-pi (via local proxy)",
      "package": "@opencode/ai/providers/openai-compatible",
      "settings": { "baseURL": "http://127.0.0.1:8452/v1", "apiKey": "local" },
      "models": {
        "glm-5.3-flash": { "name": "GLM 5.3 Flash · 1.5x", "limit": { "context": 1048576, "output": 8192 } },
        "deepseek-v4-flash": { "name": "DeepSeek V4 Flash · 1x", "limit": { "context": 1048576, "output": 8192 } },
        "gpt-6-luna": { "name": "GPT-6 Luna · 2x", "limit": { "context": 1048576, "output": 8192 } }
      }
    }
  },
  "mcp": {
    "freepi-tools": { "type": "remote", "url": "http://127.0.0.1:8452/mcp", "enabled": true }
  }
}
```

> OpenCode v2 may report "missing bearer token" if no credential is present — the `apiKey: "local"` setting above satisfies it. You can generate a fuller model list (all non-premium/available models) from the live catalog; the dashboard shows the current catalog.

### Claude Code

Claude Code speaks the **Anthropic Messages API**, and the proxy now translates it to the same
OpenAI-compatible backend. Launch Claude Code from your project:

```sh
freepi-proxy claude
```

The command starts the proxy if needed, builds a temporary Claude Code settings profile, and runs
`claude` in the current directory. Your `~/.claude/settings.json` is left untouched.

The latest free models are mapped onto Claude Code's model slots:

| Claude Code slot | free-pi model |
|---|---|
| default / Opus | `deepseek-v4.1-flash` |
| Fable | `particle` |
| Sonnet | `glm-5.3-flash` |
| Haiku / small-fast | `deepseek-v4-flash` |

The mapping is chosen from the live catalog, so if the free lineup changes the proxy picks the
available free models instead.

```sh
freepi-proxy claude --list                 # free models + current mapping
freepi-proxy claude --model glm-5.3-flash  # change the default/main model
freepi-proxy claude --sonnet solar-pro-4   # change one slot
freepi-proxy claude -- -p "say hi"         # pass flags through to Claude Code
```

Any Anthropic-format client can also use `http://127.0.0.1:8452` as its base URL; the proxy
serves `/v1/messages` and `/v1/messages/count_tokens`.

## MCP tools

The proxy exposes a Streamable-HTTP MCP server at `http://127.0.0.1:8452/mcp`:

| Tool | What it does |
|---|---|
| `generate_image` | Generates an image and saves it under `./images/` (returns the path — the model cannot see the image) |
| `web_search` | Live web search |
| `docs_lookup` | Look up library/framework documentation |
| `check_usage` | Read-only allowance/credits snapshot |

Tool calls are metered against your daily allowance.

## Dashboard & Chat

The dashboard (a single, self-contained HTML file with no external requests) has four tabs:

- **Overview** — credits remaining, daily cap, refill time, burn chart, and an ad panel (see below)
- **Activity** — paginated request log (model, tokens, estimated credits, status)
- **Models** — live catalog with multipliers and availability
- **Chat** — talk to any model directly: streaming responses, markdown + code-copy, temperature/max-tokens/system prompt, regenerate/export, and models grouped into **Best value**, **Standard**, **Uncensored/Abliterated**, **Premium/Heavy**, and **Unavailable**

Chat conversations persist locally in your browser (`localStorage`). Messages route through the proxy and count against the shared daily allowance.

## Credits, models & metering

- Accounts receive a **daily free allowance** (credits, refilled daily) shared across every client. The authoritative figures come from the upstream `/me/stats`.
- **Not all models cost the same.** The catalog multiplier is the real price (e.g. ~0.6×–3× for value/standard models, much higher for premium/ultrafast). Some models are uncensored/abliterated (labeled in the UI) and some are **credit-gated** (require purchased credits) depending on the account — gating is enforced upstream.
- The dashboard shows authoritative allowance/remaining plus a local request log. **Per-request credits are an instant estimate** (tokens × multiplier × a calibrated rate) that **reconciles** to the server's settled spend when it advances (the server meter can settle with a delay).
- Request history is stored locally at `~/.freepi-proxy/requests.jsonl` (kept ~14 days).

## Ads & attribution (how free-pi stays free)

free-pi funds inference with ads. The proxy participates **legitimately** — it does not bypass or spoof ads:

- It runs a Gravity pixel (when the `@gravity-ai/api` SDK is resolvable from a global `free-pi-cli` install) and attaches the `x-gravity-context`/`x-session-id` headers the backend expects.
- The dashboard **Overview** tab fetches and displays an ad and reports an impression **only when the ad is actually visible**. Keep the Overview tab open so impressions can be reported.
- If the backend pauses completions with `ads_required`, open the dashboard Overview to report an impression (or run `npx free-pi-cli@latest` once) and retry.

Ad attribution is best-effort and must never break startup; if the Gravity SDK isn't found, the proxy still runs (it just won't attach pixel context).

## Concurrent sessions

The proxy reuses a **single, stable session id** across restarts (`~/.freepi-proxy/session-id`) so it occupies only one of the account's concurrent session slots (accounts are limited). If you ever hit `concurrent_session` errors from stale leases, the proxy can't clear them itself — running `npx free-pi-cli@latest` and using `/close-other-session` (or waiting for the lease to expire) will free a slot.

## Configuration (env vars)

| Variable | Default | Purpose |
|---|---|---|
| `FREEPI_PROXY_PORT` | `8452` | Listen port |
| `FREEPI_PROXY_URL` | `http://127.0.0.1:<port>` | Base URL used in user-facing messages |
| `FREEPI_BASE_URL` | `https://api.freepi.ai` | Upstream backend |
| `FREEPI_CREDENTIALS_PATH` | `~/.free-pi/agent/credentials.json` | Override token file |
| `FREEPI_NO_GRAVITY_PIXEL` | *(unset)* | Set to `1` to disable the Gravity pixel (not recommended) |
| `FREEPI_GRAVITY_SDK` | *(unset)* | Explicit path to the `@gravity-ai/api` entry module |

Local data lives in `~/.freepi-proxy/` (`requests.jsonl`, `session-id`, `proxy.pid`/`proxy.log` when daemonized).

## Caveats

- **Unofficial.** The backend can tighten client/version checks; keep the proxy updated if that happens.
- **JWT expiry.** Tokens expire (on the order of months) — re-login from the dashboard when needed.
- **Vision/image input depends on the upstream model.** The proxy translates Anthropic image blocks to OpenAI `image_url` data URLs; image *generation* works via the MCP tool.
- **Consent.** By using free-pi you accept that ads fund inference and sessions may be used to train models — see <https://freepi.ai/privacy>.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The project is intentionally zero-dependency and build-free.

## License

[MIT](LICENSE)
