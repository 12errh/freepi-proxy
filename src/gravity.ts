// Gravity pixel + context for legitimate ad attribution (mirrors free-pi-cli's
// src/gravity-pixel.ts). Loads @gravity-ai/api from the global free-pi-cli
// install if present; degrades to undefined (no context) if unavailable.
// Must never block or crash startup.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";

export const GRAVITY_PIXEL_ID = "6cd74804-0541-4d9b-899d-d7fceb465b6f";
export const GRAVITY_CONTEXT_MAX_BYTES = 8192;

/** Candidate global module roots, in priority order. */
function globalModuleRoots(): string[] {
  const roots = new Set<string>();
  const add = (p: string | undefined) => { if (p && p.trim()) roots.add(p.trim()); };
  // Ask the package managers (best effort; absent in minimal environments).
  try {
    const npmRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8", timeout: 3_000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    add(npmRoot);
  } catch { /* npm not on PATH */ }
  try {
    const prefix = execFileSync("npm", ["prefix", "-g"], { encoding: "utf8", timeout: 3_000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    add(join(prefix, "lib", "node_modules"));
  } catch { /* ignore */ }
  // Common install locations (npm global, Homebrew, bun).
  for (const p of [
    "/usr/lib/node_modules",
    "/usr/local/lib/node_modules",
    "/opt/homebrew/lib/node_modules",
    join(homedir(), ".bun", "install", "global", "node_modules"),
    join(homedir(), ".npm-global", "lib", "node_modules"),
  ]) add(p);
  return [...roots];
}

/**
 * Resolve `@gravity-ai/api` from the global `free-pi-cli` install (it ships the
 * SDK as a dependency). Degrades to `null` when unavailable — ad attribution
 * is optional and must never break startup.
 */
async function loadSdk(): Promise<any> {
  if (process.env.FREEPI_GRAVITY_SDK) {
    try { return await import(pathToFileURL(process.env.FREEPI_GRAVITY_SDK).href); } catch { /* fall through */ }
  }
  for (const root of globalModuleRoots()) {
    for (const base of [root, join(root, "free-pi-cli"), join(root, "free-pi-cli", "node_modules")]) {
      try {
        const req = createRequire(join(base, "package.json"));
        const resolved = req.resolve("@gravity-ai/api");
        return await import(pathToFileURL(resolved).href);
      } catch { /* try next candidate */ }
    }
  }
  try { return await import("@gravity-ai/api"); } catch { return null; }
}

function userIdFromJwt(jwt: string): string | undefined {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString("utf8")) as { sub?: unknown };
    return typeof payload.sub === "string" ? payload.sub : undefined;
  } catch { return undefined; }
}

// The CLI's pixel registers SIGINT/SIGTERM handlers that call process.exit(0).
// Remove those to avoid clobbering the proxy's own shutdown. Keep "exit".
function dropPixelSignalHandlers(): () => void {
  const onNew = (event: string | symbol, fn: unknown) => {
    if ((event !== "SIGINT" && event !== "SIGTERM") || typeof fn !== "function") return;
    if (!/shutdownSync/.test(Function.prototype.toString.call(fn))) return;
    queueMicrotask(() => process.removeListener(event, fn as (...args: unknown[]) => void));
  };
  process.on("newListener", onNew);
  return () => process.removeListener("newListener", onNew);
}

export function startGravityPixel(jwt: string): () => string | undefined {
  if (process.env.FREEPI_NO_GRAVITY_PIXEL === "1") return () => undefined;
  const userId = userIdFromJwt(jwt);
  if (!userId) return () => undefined;
  const userHash = createHash("sha256").update(userId).digest("hex");
  const storageDir = join(homedir(), ".free-pi", "gravity");

  let sdk: any;
  let pixel: any;
  void (async () => {
    try {
      sdk = await loadSdk();
      if (!sdk?.gravityPixel || !sdk?.gravityContext) return;
      pixel = sdk.gravityPixel({ pixelId: GRAVITY_PIXEL_ID, appName: "free-pi", storageDir });
      const stopWatching = dropPixelSignalHandlers();
      try { await pixel.start(); } finally { stopWatching(); }
    } catch { pixel = undefined; }
  })();

  return () => {
    try {
      const sessionId = pixel?.getSessionId?.();
      if (!sdk || !pixel || !sessionId) return undefined;
      const ctx = sdk.gravityContext({
        sessionId,
        user: { userId: userHash, gruid: pixel.getVisitorId?.(), grclid: pixel.getClickId?.(), graid: pixel.getGraid?.() },
      });
      const encoded = Buffer.from(JSON.stringify(ctx)).toString("base64url");
      return encoded.length <= GRAVITY_CONTEXT_MAX_BYTES ? encoded : undefined;
    } catch { return undefined; }
  };
}
