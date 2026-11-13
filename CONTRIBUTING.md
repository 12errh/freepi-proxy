# Contributing to freepi-proxy

Thanks for your interest in improving **freepi-proxy**.

## Ground rules

- **Zero dependencies.** The proxy runs on Node.js ≥ 22.19 (or Bun) with no `npm install`. Please do not add runtime dependencies. Dev-only tooling is fine if it stays out of the runtime path.
- **No build step.** Source runs directly (`node src/main.ts` / `bun src/main.ts`). Keep it that way.
- **Legitimate ad attribution only.** free-pi is ad-supported — the proxy must never bypass, spoof, or hide ad/impression reporting. Fixes that break attribution will not be accepted.
- **No secrets in commits.** Never commit JWTs, credentials, or personal data. The proxy reads tokens from `~/.free-pi/agent/credentials.json` at runtime — keep it there.

## Getting started

```sh
git clone <your-fork-url> freepi-proxy
cd freepi-proxy
node src/main.ts          # or: bun src/main.ts
# dashboard → http://127.0.0.1:8452
```

The codebase is plain TypeScript/ESM, split by responsibility:

| File | Role |
|---|---|
| `src/main.ts` | HTTP server, routing, wiring |
| `src/config.ts` | Constants, paths, env vars |
| `src/proxy.ts` | `/v1/chat/completions` + `/v1/models` (OpenAI-compatible) |
| `src/anthropic.ts` | `/v1/messages` + `/v1/messages/count_tokens` (Anthropic-compatible), Claude config |
| `src/models.ts` | Free-model detection + Claude Code slot mapping |
| `src/claude.ts` | Generates Claude Code settings for `freepi-proxy claude` |
| `src/upstream.ts` | free-pi API client (catalog, stats, tools, ads) |
| `src/mcp.ts` | Streamable-HTTP MCP server (`/mcp`) |
| `src/token.ts` | JWT storage + GitHub device-flow login |
| `src/state.ts` | Runtime state, stats polling, spend reconciliation |
| `src/track.ts` | Append-only request log (`~/.freepi-proxy/requests.jsonl`) |
| `src/gravity.ts` | Optional Gravity pixel/context for ad attribution |
| `src/ui.html` | Self-contained dashboard (no external assets) |
| `test/` | `node:test` unit tests + opt-in live e2e tests |
| `freepi-proxy` | CLI launcher (start/stop/status/logs/open/models/claude) |

## Making changes

1. Keep changes small and focused.
2. The dashboard is a **single self-contained HTML file** with inline CSS/JS and zero external requests. Please keep it that way.
3. Run `npm test` for the unit suite. Live tests are opt-in: start the proxy, then run `npm run test:e2e`.
4. Test the affected path end-to-end (a completion through `/v1` or `/v1/messages`, an MCP tool call, the dashboard, `freepi-proxy claude`) before opening a PR.
5. If you touch auth, ads, or credit metering, describe how you verified the behavior.

## Reporting issues

Please include: your Node/Bun version, OS, the proxy log (`~/.freepi-proxy/proxy.log` or console output), and the relevant request/response (redact any token). This project is an **unofficial** proxy — upstream free-pi behavior can change.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
