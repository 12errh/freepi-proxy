// JWT storage + GitHub device-flow login, replicating free-pi-cli's
// src/credentials.ts and src/auth-flow.ts byte-for-byte at the protocol level.

import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { dirname } from "node:path";
import { BASE_URL, CONSENT_VERSION, CREDENTIALS_PATH, UA } from "./config.ts";

export interface DeviceFlow {
  session_id: string;
  user_code: string;
  verification_uri: string;
  interval: number;
  expires_in?: number;
}

export interface TokenState {
  token: string | null;
  /** "ok" | "missing" | "rejected" (401 from /me) | "unknown" (network/5xx) */
  status: "ok" | "missing" | "rejected" | "unknown";
  handle?: string;
  checkedAt: number;
}

async function postJson(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(new URL(path, BASE_URL), {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": UA, ...headers },
    body: JSON.stringify(body),
  });
}

// ---------- storage (same file the CLI uses) ----------

export async function loadJwt(): Promise<string | null> {
  try {
    const raw = await readFile(process.env.FREEPI_CREDENTIALS_PATH || CREDENTIALS_PATH, "utf8");
    const parsed = JSON.parse(raw) as { token?: unknown };
    return typeof parsed.token === "string" && parsed.token.length > 0 ? parsed.token : null;
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") {
      console.error(`[freepi-proxy] could not read ${process.env.FREEPI_CREDENTIALS_PATH || CREDENTIALS_PATH}: ${e instanceof Error ? e.message : e}`);
    }
    return null;
  }
}

export async function saveJwt(token: string): Promise<void> {
  const path = process.env.FREEPI_CREDENTIALS_PATH || CREDENTIALS_PATH;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ token }), { mode: 0o600 });
  await chmod(path, 0o600).catch(() => {});
}

// ---------- token validation ----------

/** GET /me with the JWT. Throws on 401 (rejected token). Returns handle. */
export async function checkToken(jwt: string): Promise<{ ok: true; handle?: string } | { ok: false; code: "rejected" | "unknown" }> {
  try {
    const res = await fetch(new URL("/me", BASE_URL), { headers: { authorization: `Bearer ${jwt}`, "user-agent": UA } });
    if (res.status === 401) return { ok: false, code: "rejected" };
    if (!res.ok) return { ok: false, code: "unknown" };
    const body = (await res.json().catch(() => ({}))) as { handle?: unknown };
    return { ok: true, handle: typeof body.handle === "string" ? body.handle : undefined };
  } catch {
    return { ok: false, code: "unknown" };
  }
}

// ---------- device flow (same endpoints as the CLI) ----------

export async function startDeviceFlow(): Promise<DeviceFlow> {
  let res: Response;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      res = await postJson("/auth/github/device", {});
      if (!res.ok) throw new Error(`device flow start failed: HTTP ${res.status}`);
      return (await res.json()) as DeviceFlow;
    } catch (err) {
      lastErr = err;
      if (err instanceof Error && /HTTP/.test(err.message)) throw err;
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
  throw new Error(`network unreachable: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
}

async function submitConsent(sessionId: string): Promise<void> {
  const res = await postJson("/auth/consent", { session_id: sessionId, consent_version: CONSENT_VERSION });
  if (!res.ok) throw new Error(`consent submission failed: HTTP ${res.status}`);
}

/** One poll of /auth/token. Returns token, "waiting", or throws. */
async function pollOnce(sessionId: string): Promise<string | "waiting" | "slowdown"> {
  const res = await postJson("/auth/token", { session_id: sessionId });
  if (res.status === 403) {
    const body = (await res.json().catch(() => ({}))) as { code?: string };
    if (body.code === "consent_required") throw new Error("consent_required: consent was not recorded");
    throw new Error(`token poll failed: HTTP ${res.status}`);
  }
  if (!res.ok) throw new Error(`token poll failed: HTTP ${res.status}`);
  const parsed = (await res.json()) as { token?: string; code?: string; retry_after?: number };
  if (typeof parsed.token === "string" && parsed.token) return parsed.token;
  if (parsed.code === "slow_down") return "slowdown";
  if (parsed.code === "authorization_pending" || parsed.code === "pending") return "waiting";
  return "waiting";
}

export interface LoginSession {
  flow: DeviceFlow;
  state: "authorizing" | "ok" | "error";
  error?: string;
  token?: string;
  startedAt: number;
}

/** In-memory login session the dashboard drives. One at a time. */
export class LoginManager {
  current: LoginSession | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  onToken?: (token: string) => void;

  start(): LoginSession {
    this.stop();
    // synchronous start; errors surface via state
    void this.#run();
    return this.current!;
  }

  async #run(): Promise<void> {
    try {
      const flow = await startDeviceFlow();
      this.current = { flow, state: "authorizing", startedAt: Date.now() };
      // The CLI submits consent immediately after starting the flow.
      await submitConsent(flow.session_id);
      const interval = Math.max(Number(flow.interval) || 5, 3) * 1000;
      const deadline = Date.now() + (Number(flow.expires_in) || 900) * 1000;
      const tick = async (): Promise<void> => {
        if (!this.current || this.current.state !== "authorizing") return;
        if (Date.now() > deadline) {
          this.current.state = "error";
          this.current.error = "device code expired";
          return;
        }
        try {
          const r = await pollOnce(flow.session_id);
          if (r === "waiting") {
            this.timer = setTimeout(tick, interval);
          } else if (r === "slowdown") {
            this.timer = setTimeout(tick, 10_000);
          } else {
            this.current.state = "ok";
            this.current.token = r;
            this.onToken?.(r);
          }
        } catch (err) {
          // tolerate transient network errors like the CLI does
          this.timer = setTimeout(tick, Math.max(interval, 5_000));
          this.current.error = err instanceof Error ? err.message : String(err);
        }
      };
      await tick();
    } catch (err) {
      this.current = {
        flow: { session_id: "", user_code: "", verification_uri: BASE_URL, interval: 5 },
        state: "error",
        error: err instanceof Error ? err.message : String(err),
        startedAt: Date.now(),
      };
    }
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.current = null;
  }
}
