// Constants and paths for freepi-proxy. Zero dependencies.

import { homedir } from "node:os";
import { join } from "node:path";

/** free-pi backend, overridable for dev like the CLI does. */
export const BASE_URL = process.env.FREEPI_BASE_URL || "https://api.freepi.ai";

/** Port the proxy listens on. */
export const PORT = Number(process.env.FREEPI_PROXY_PORT || 8452);

/** Public base URL used in user-facing messages (defaults to loopback). */
export const DASHBOARD_URL = process.env.FREEPI_PROXY_URL || `http://127.0.0.1:${PORT}`;

/** free-pi CLI stores its JWT here (mode 0600). We share the same file. */
export const CREDENTIALS_PATH = join(homedir(), ".free-pi", "agent", "credentials.json");

/** Our own data dir: usage log + cached state. */
export const DATA_DIR = join(homedir(), ".freepi-proxy");
export const REQUESTS_PATH = join(DATA_DIR, "requests.jsonl");
export const SESSION_ID_PATH = join(DATA_DIR, "session-id");

/** Consent version free-pi-cli 0.6.x submits during login (src/consent.ts). */
export const CONSENT_VERSION = "4";

/** Header the server's forced-update gate reads; we send the catalog's latest. */
export const FALLBACK_CLIENT_VERSION = "0.6.15";

/** Public catalog refresh cadence. */
export const CATALOG_REFRESH_MS = 10 * 60 * 1000;

/** How often we sync authoritative /me/stats for the dashboard. */
export const STATS_POLL_MS = 60_000;

/** Min gap between credit-diff polls triggered by completions. */
export const CREDIT_DIFF_MIN_MS = 3_000;

/** Days of request history kept in requests.jsonl. */
export const HISTORY_DAYS = 14;

/** Server peg: $1.125 daily cap = 15,000 credits → 1 credit = $0.000075. */
export const CREDITS_PER_USD = 15_000 / 1.125;

/** Local instant estimate: credits per token at 1x multiplier. Calibrated from
 * a live measurement (glm-flash 1x: $0.000421 for 2,526 tokens ≈ 0.00222 cr/tok).
 * Reconciled against the server's settled spend when it lands. */
export const EST_CREDITS_PER_TOKEN = 0.00222;

/** Where MCP generate_image saves files when the cwd is not writable. */
export const IMAGE_FALLBACK_DIR = join(homedir(), "freepi-images");

export const UA = "freepi-proxy/1.0";
