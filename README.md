# freepi-proxy

A **zero-dependency** local proxy, dashboard, chat UI, and MCP server for
[free-pi](https://freepi.ai) (ad-supported, community-funded inference).

Point coding agents at it and they use your free-pi daily allowance instead of a paid API key:

- **OpenAI-compatible** Chat Completions at `/v1/chat/completions` + model discovery at `/v1/models`
- **Anthropic-compatible** Messages API at `/v1/messages` — `freepi-proxy claude` wires Claude Code to it
- **MCP server** at `/mcp` (Streamable HTTP) — `generate_image`, `web_search`, `docs_lookup`, `check_usage`
- **Dashboard** at `/` — allowance/credits, burn chart, request log, live model catalog, built-in **Chat**
- **Auth handled for you** — GitHub device-flow login in the UI; shares the same credential file as `free-pi-cli`
- **No install step** — Node or Bun runs the TypeScript sources directly; there is no build and no `node_modules`

> **Unofficial.** Not affiliated with free-pi/freepi.ai. It talks to the same backend as
> `free-pi-cli`; upstream behavior and client checks can change at any time.

---

## Requirements

| | |
|---|---|
| Runtime | **Node.js ≥ 22.19** (runs `.ts` directly, type stripping) **or** Bun |
| Account | A free-pi account — created from the dashboard login or with `npx free-pi-cli@latest` |
| OS | Linux, macOS, or WSL. `freepi-proxy open` needs `xdg-open`/`open` |

The `freepi-proxy` launcher shell script calls `node`; Bun can run the server directly
(`bun src/main.ts`) but the daemon/log/claude helpers assume Node is on `PATH`.

---

## Installation

### From source (recommended)

```sh
git clone https://github.com/12errh/freepi-proxy.git
cd freepi-proxy
```

Then expose the launcher on your `PATH` — either link it:

```sh
ln -s "$PWD/freepi-proxy" ~/.local/bin/freepi-proxy   # ensure ~/.local/bin is on PATH
```

or install it as an npm bin (no dependencies, nothing is fetched):

```sh
npm install -g .        # from the checkout; provides `freepi-proxy`
# or, keeping the checkout live under edit:
npm link
```

Verify:

```sh
freepi-proxy help
node --version          # must be >= v22.19.0
```

### Without installing

```sh
git clone https://github.com/12errh/freepi-proxy.git
cd freepi-proxy
node src/main.ts        # foreground, prints the URLs, Ctrl+C to stop
```

---

## First run & login

```sh
freepi-proxy start -d        # background daemon
freepi-proxy status          # confirm it is up
freepi-proxy open            # opens http://127.0.0.1:8452
```

1. In the dashboard, click **Log in** — it starts GitHub's device flow and shows a short code.
2. Enter the code on the GitHub page it links to and authorize.
3. The JWT is written to `~/.free-pi/agent/credentials.json` (mode `0600`), the same file
   `free-pi-cli` uses. If you have already used the CLI, the proxy picks the token up on start —
   no login needed.
4. Check the **Overview** tab: account handle, tier, remaining credits, refill time.

**Keep the dashboard Overview tab open** while you work. It displays free-pi's ad and reports the
impression only when visible; without impressions the backend can pause completions with
`ads_required` (see [Ads & attribution](#ads--attribution)).

Nothing is exposed beyond loopback: the server binds `127.0.0.1` only and requires no API key of
its own (any non-empty key satisfies OpenAI-style clients; the proxy injects your real JWT).

---

## CLI reference

`freepi-proxy <command>`:

| Command | Description |
|---|---|
| `start` | Run in the foreground (Ctrl+C to stop) |
| `start -d` / `--background` / `--daemon` | Start in the background; writes `~/.freepi-proxy/proxy.pid` |
| `stop` | Stop the daemon (frees the port, removes the pid file) |
| `restart` | `stop` then `start -d` |
| `status` | Running state plus account handle, tier, lane, remaining credits, refill time, uptime |
| `logs [n]` | Last `n` lines of `~/.freepi-proxy/proxy.log` (default 50) |
| `logs -f [n]` | Follow the log |
| `open` | Open the dashboard in the default browser |
| `models` | Print `freepi/<model-id>` for every currently available **Free Unlimited** model |
| `claude [options] [-- <claude args>]` | Launch Claude Code against the proxy (see [Claude Code](#claude-code)) |
| `help` | Usage |

`start` is idempotent: if the port already answers `/api/state`, it prints the existing URL instead
of starting a second instance.

---

## Endpoints

The proxy listens on `127.0.0.1:8452` by default (`FREEPI_PROXY_PORT`).

| Method & path | Protocol | Purpose |
|---|---|---|
| `POST /v1/chat/completions` | OpenAI | Streaming/non-streaming completions, tool calls |
| `GET /v1/models` | OpenAI | Model discovery — only available **Free Unlimited** catalog entries |
| `POST /v1/messages` | Anthropic | Messages API, streaming + tool use, translated to the upstream |
| `POST /v1/messages/count_tokens` | Anthropic | Input token estimate |
| `GET /api/hello` | — | Claude Code probe |
| `GET /api/claude/config` | — | Current Claude slot mapping (used by `freepi-proxy claude`) |
| `POST /mcp`, `GET /mcp`, `DELETE /mcp` | MCP (Streamable HTTP) | Tool server |
| `GET /` | HTTP | Dashboard (single self-contained HTML file) |
| `GET /api/state` | JSON | Allowance, usage history, catalog, server info |
| `POST /api/login/start`, `GET /api/login/status` | JSON | GitHub device-flow login used by the UI |
| `GET /api/ads/next`, `POST /api/ads/impression` | JSON | Ad surface used by the Overview tab |
| `POST /api/stats/refresh` | JSON | Force an authoritative `/me/stats` poll |

---

## Connecting an agent

### Any OpenAI-compatible client

```sh
export OPENAI_BASE_URL=http://127.0.0.1:8452/v1
export OPENAI_API_KEY=local          # any non-empty string
```

Model ids come from the live catalog (e.g. `glm-5.3-flash`, `deepseek-v4-flash`,
`deepseek-v4.1-flash`, `gpt-6-luna`, `solar-pro-4`, `gemma-4-uncensored`). Run
`freepi-proxy models` or open the **Models** tab for the current list, multipliers, and
availability. Unknown model ids are not errors: the proxy logs a warning and uses its default model.

### omp

The proxy works as an omp custom provider. `/v1/models` exposes only available Free Unlimited
models, so discovery cannot select a paid model. Start the proxy, then add
`~/.omp/agent/models.yml`:

```yaml
providers:
  freepi:
    baseUrl: http://127.0.0.1:8452/v1
    api: openai-completions
    apiKey: local
    discovery:
      type: openai-models-list
    modelOverrides:
      deepseek-v4.1-flash: { contextWindow: 200000, maxTokens: 8192 }
      deepseek-v4-flash:   { contextWindow: 200000, maxTokens: 8192 }
      glm-5.3-flash:       { contextWindow: 200000, maxTokens: 8192 }
      particle:            { contextWindow: 200000, maxTokens: 8192 }
```

```sh
omp models refresh freepi
omp models freepi
omp --model freepi/<model-id>
```

`contextWindow` matches free-pi's 200k `CONTEXT_WINDOW`; `maxTokens` is the completion cap. If a
promotion or the lineup changes, refresh discovery before selecting a model.

### OpenCode

Global config (`~/.config/opencode/opencode.json`) — provider plus the MCP tools:

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
        "glm-5.3-flash":     { "name": "GLM 5.3 Flash · 1.5x",      "limit": { "context": 200000, "output": 8192 } },
        "deepseek-v4-flash": { "name": "DeepSeek V4 Flash · 1x",    "limit": { "context": 200000, "output": 8192 } },
        "gpt-6-luna":        { "name": "GPT-6 Luna · 2x",           "limit": { "context": 200000, "output": 8192 } }
      }
    }
  },
  "mcp": {
    "freepi-tools": { "type": "remote", "url": "http://127.0.0.1:8452/mcp", "enabled": true }
  }
}
```

Set `limit.context` to `200000` for every model, matching the CLI's `CONTEXT_WINDOW`. An earlier
upstream bug rejected long sessions with `context_too_long` well below that limit; it is fixed, so
no reduced cap is needed. The proxy still rotates a session if the backend reports one.

OpenCode v2 can report "missing bearer token" when no credential exists — `apiKey: "local"`
satisfies it. The dashboard shows the live catalog if you want to add more models.

### Claude Code

```sh
freepi-proxy claude                          # start proxy if needed, then run `claude`
freepi-proxy claude --list                   # free models + current slot mapping
freepi-proxy claude --model glm-5.3-flash    # change the default/main model
freepi-proxy claude --sonnet solar-pro-4     # change one slot
freepi-proxy claude -- -p "say hi"           # flags after `--` go to Claude Code
```

The command ensures the proxy is running, builds a settings profile as JSON, and runs
`claude --settings '<json>'`. Your `~/.claude/settings.json` is never modified.

Slot mapping, chosen from the live catalog (free models preferred):

| Claude Code slot | Default free-pi model |
|---|---|
| default / Opus | `deepseek-v4.1-flash` |
| Fable | `particle` |
| Sonnet | `glm-5.3-flash` |
| Haiku / small-fast | `deepseek-v4-flash` |

Flags: `--model`, `--fable`, `--opus`, `--sonnet`, `--haiku`. If the free lineup changes, the proxy
picks the available free models by catalog order instead. `CLAUDE_CODE_MAX_CONTEXT_TOKENS` is set
to `200000` in the generated profile.

Any Anthropic-format client can use `http://127.0.0.1:8452` as its base URL.

---

## MCP tools

Streamable-HTTP MCP server at `http://127.0.0.1:8452/mcp`. Add it as a remote MCP server in any
client that supports streamable HTTP (OpenCode, omp, etc.).

| Tool | Arguments | What it does |
|---|---|---|
| `generate_image` | `prompt` (required), `aspect_ratio` (`1:1`, `16:9`, `9:16`, `4:3`, `3:2`), `name` (filename hint) | Generates one image, saves it under `./images/` (fallback `~/freepi-images`), returns the path. The model cannot see the image. |
| `web_search` | `query` (required), `num_results` (1–10, default 5) | Live web search — title, URL, publish date, page text |
| `docs_lookup` | `library` and `query` (required), `library_id` (from an earlier call) | Current library/framework documentation |
| `check_usage` | — | Read-only tier, remaining credits, refill time, token counts |

Every call is metered against your daily free-pi allowance.

---

## Dashboard & Chat

Single self-contained HTML file (no CDN, no external requests), five tabs:

- **Overview** — credits remaining, daily cap, refill time, burn and 14-day usage charts, plus the ad panel
- **Chat** — streaming chat to any model: markdown + code copy, temperature / max-tokens / system
  prompt, regenerate, export; models grouped into *Best value*, *Standard*, *Uncensored/Abliterated*,
  *Premium/Heavy*, *Unavailable*. History stays in browser `localStorage`.
- **Activity** — paginated request log: model, tokens, estimated credits, status
- **Models** — live catalog with multipliers and availability
- **Setup** — connection snippets for the clients above

Chat and agent traffic share the same daily allowance.

---

## Credits, models & metering

- Accounts get a **daily free allowance** in credits, refilled daily and shared across every client.
  Authoritative numbers come from the upstream `/me/stats`, polled every 60s.
- **Models cost different amounts.** The catalog multiplier is the real price (roughly 0.6×–3× for
  value/standard models, much higher for premium/ultrafast). Uncensored/abliterated models are
  labeled in the UI; credit-gated models are enforced upstream.
- Per-request credits in the Activity log are an **instant local estimate**
  (tokens × multiplier × a calibrated rate). They **reconcile** to the server's settled spend when
  the meter advances, which can lag by a few seconds.
- Request history: `~/.freepi-proxy/requests.jsonl`, kept ~14 days.

---

## Ads & attribution

free-pi funds inference with ads. The proxy participates legitimately — it does not bypass or spoof ads:

- It runs the Gravity pixel when `@gravity-ai/api` is resolvable from a global `free-pi-cli` install
  (the CLI ships it as a dependency) and attaches the `x-gravity-context` / `x-session-id` headers
  the backend expects.
- The Overview tab fetches and displays an ad, reporting an impression **only when it is actually
  visible**. Keep the tab open.
- If completions pause with `ads_required`, open the Overview tab (or run `npx free-pi-cli@latest`
  once) and retry.

Attribution is best-effort: if the SDK cannot be found the proxy still starts, it just runs without
pixel context. `FREEPI_GRAVITY_SDK` points at an explicit SDK entry module;
`FREEPI_NO_GRAVITY_PIXEL=1` disables the pixel (not recommended).

---

## Sessions

The proxy reuses a **single stable session id** across restarts (`~/.freepi-proxy/session-id`) so it
occupies one of the account's limited concurrent-session slots. Stale `concurrent_session` leases
cannot be cleared by the proxy — run `npx free-pi-cli@latest`, use `/close-other-session`, or wait
for the lease to expire.

That session id is not immortal. free-pi meters a *session* (one CLI run), not just a request: if a
session exhausts its budget, later completions can be rejected with `context_too_long`
("This conversation is too long. Run /compact or start a new session with /new."). The upstream bug
that fired this far below the 200k window is fixed, but the proxy still treats it as session-level —
it retires the session, mints a fresh one, and replays the request once, so a stale lease cannot
wedge a long run. The retired lease expires on its own. `concurrent_session` is deliberately **not**
retried: rotating more sessions would only make that worse.

---

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `FREEPI_PROXY_PORT` | `8452` | Listen port (and the port the launcher probes) |
| `FREEPI_PROXY_URL` | `http://127.0.0.1:<port>` | Base URL used in messages and generated Claude settings |
| `FREEPI_BASE_URL` | `https://api.freepi.ai` | Upstream backend |
| `FREEPI_CREDENTIALS_PATH` | `~/.free-pi/agent/credentials.json` | Override the token file |
| `FREEPI_NO_GRAVITY_PIXEL` | *(unset)* | `1` disables the Gravity ad pixel |
| `FREEPI_GRAVITY_SDK` | *(unset)* | Explicit path to the `@gravity-ai/api` entry module |
| `FREEPI_E2E` | *(unset)* | `1` enables the live end-to-end tests |

Environment changes apply to new daemon starts: `freepi-proxy restart` after editing.

### Local data

| Path | Contents |
|---|---|
| `~/.free-pi/agent/credentials.json` | JWT shared with `free-pi-cli` (mode `0600`) |
| `~/.freepi-proxy/requests.jsonl` | Request history (~14 days) |
| `~/.freepi-proxy/session-id` | Stable upstream session id |
| `~/.freepi-proxy/proxy.pid`, `proxy.log` | Daemon pid and log |
| `./images/`, `~/freepi-images` | MCP `generate_image` output |

Deleting `session-id` mints a new session on next start; deleting the credentials forces a re-login.

---

## Development & tests

```sh
npm test                # node --test test/*.test.ts  (23 tests; no network)
npm run test:e2e        # FREEPI_E2E=1, live upstream — needs a valid token
npm start               # node src/main.ts
npm run start:bun       # bun src/main.ts
```

The suite covers model selection, the OpenAI discovery filter, Anthropic translation, and
session rotation. The project is intentionally zero-dependency and build-free: no bundler, no
transpiler, no `node_modules`.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `status` says NOT RUNNING but the port is busy | Another process holds the port. `fuser -k 8452/tcp` or set `FREEPI_PROXY_PORT` |
| Dashboard shows no token / `check_usage` refuses | Log in from the dashboard; confirm `~/.free-pi/agent/credentials.json` exists and is readable |
| `concurrent_session` errors | Free a slot: `npx free-pi-cli@latest`, `/close-other-session`, or wait for the lease to expire |
| `ads_required` on every completion | Open the dashboard Overview tab so an impression can be reported, then retry |
| `context_too_long` | The session was spent; the proxy retries once on a fresh session. If it persists, `/compact` the conversation or restart the client |
| `claude not found on PATH` | Install Claude Code first (`npm i -g @anthropic-ai/claude-code`) |
| OpenCode says "missing bearer token" | Set `apiKey: "local"` on the provider |
| Model ids rejected by the client | `freepi-proxy models` — ids must exist in the current free catalog |
| Ads never report / completions pause | Check the log (`freepi-proxy logs 100`) for Gravity SDK resolution; install `free-pi-cli` globally or set `FREEPI_GRAVITY_SDK` |

---

## Caveats

- **Unofficial.** The backend can tighten client/version checks; keep the proxy updated if it breaks.
  The proxy sends the catalog's current `client-version` floor (`0.6.19` as a fallback).
- **JWT expiry.** Tokens expire (on the order of months); log in again from the dashboard.
- **Vision/image input depends on the upstream model.** Anthropic image blocks are translated to
  OpenAI `image_url` data URLs; image *generation* works through the MCP tool.
- **Consent.** Using free-pi means ads fund inference and sessions may be used to train models —
  see <https://freepi.ai/privacy>.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Zero dependencies, no build step, no `as any`-style
shortcuts; run `npm test` before sending a patch.

## License

[MIT](LICENSE)
