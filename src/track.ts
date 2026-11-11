// Usage tracker: append-only JSONL of every proxied request + aggregate views
// for the dashboard. Each request gets an instant local credit estimate
// (tokens x model multiplier); when the server's settled spend meter advances,
// the window's estimates are scaled to match it (reconciliation).

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { DATA_DIR, HISTORY_DAYS, REQUESTS_PATH } from "./config.ts";

export interface RequestEntry {
  ts: number;                 // epoch ms
  kind: "chat" | "web_search" | "docs_lookup" | "generate_image";
  model: string;              // model id or tool name
  pt: number;                 // prompt tokens (0 for some tools)
  ct: number;                 // completion tokens
  credits: number | null;     // estimated credits, reconciled to settled spend
  ms: number;                 // latency
  status: number;             // upstream HTTP status (0 = network error)
  source: string;             // "api" | "mcp" | "ui"
  error?: string;
  reconciled?: boolean;       // true once scaled to a settled server figure
}

export interface HourBucket { ts: number; credits: number; requests: number; pt: number; ct: number }
export interface ModelBucket { model: string; credits: number; requests: number; pt: number; ct: number; multiplier: number }
export interface DayBucket { ts: number; requests: number; pt: number; ct: number; credits: number; errors: number }

export function newTracker() {
  const entries: RequestEntry[] = [];
  let loaded = false;

  async function load(): Promise<void> {
    if (loaded) return;
    loaded = true;
    try {
      const raw = await readFile(REQUESTS_PATH, "utf8");
      const cutoff = Date.now() - HISTORY_DAYS * 86_400_000;
      for (const line of raw.split("\n")) {
        if (!line) continue;
        try {
          const e = JSON.parse(line) as RequestEntry;
          if (e.ts >= cutoff) entries.push(e);
        } catch { /* skip bad line */ }
      }
    } catch { /* no history yet */ }
  }

  async function persist(e: RequestEntry): Promise<void> {
    try {
      await mkdir(DATA_DIR, { recursive: true });
      await appendFile(REQUESTS_PATH, JSON.stringify(e) + "\n");
    } catch { /* best effort */ }
  }

  return {
    /** Load history from disk (call once at startup so reads see it). */
    ready: load,
    async add(e: RequestEntry): Promise<void> {
      await load();
      entries.push(e);
      await persist(e);
    },
    /** Reconcile local estimates against a settled server spend figure: scale
     * the window's estimates so they sum to the settled amount. */
    reconcile(settledCredits: number, sinceTs: number): void {
      const window = entries.filter((e) => e.ts >= sinceTs && !e.reconciled);
      if (!window.length || settledCredits <= 0) return;
      const estSum = window.reduce((a, e) => a + (e.credits ?? 0), 0);
      if (estSum <= 0) {
        // no estimates to scale (e.g. tool calls): distribute evenly
        window.forEach((e) => {
          e.credits = Math.round((settledCredits / window.length) * 10) / 10;
          e.reconciled = true;
        });
      } else {
        const scale = settledCredits / estSum;
        window.forEach((e) => {
          e.credits = Math.round((e.credits ?? 0) * scale * 10) / 10;
          e.reconciled = true;
        });
      }
      void rewrite();
    },
    recent(n: number): RequestEntry[] {
      return entries.slice(-n).reverse();
    },
    hourly(hours: number): HourBucket[] {
      const now = Date.now();
      const buckets: HourBucket[] = Array.from({ length: hours }, (_, i) => ({
        ts: now - (hours - 1 - i) * 3_600_000, credits: 0, requests: 0, pt: 0, ct: 0,
      }));
      const start = buckets[0]!.ts;
      for (const e of entries) {
        if (e.ts < start) continue;
        const b = buckets[Math.min(hours - 1, Math.floor((e.ts - start) / 3_600_000))]!;
        b.requests++;
        b.pt += e.pt;
        b.ct += e.ct;
        b.credits += e.credits ?? 0;
      }
      return buckets;
    },
    /** Aggregate by local calendar day (last `days` days, oldest first). */
    byDay(days: number): DayBucket[] {
      const now = new Date();
      const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
      const buckets: DayBucket[] = Array.from({ length: days }, (_, i) => ({
        ts: startOfToday - (days - 1 - i) * 86_400_000, requests: 0, pt: 0, ct: 0, credits: 0, errors: 0,
      }));
      const dayIndex = (ts: number): number => {
        const d = new Date(ts);
        const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
        return Math.round((midnight - buckets[0]!.ts) / 86_400_000);
      };
      for (const e of entries) {
        const idx = dayIndex(e.ts);
        if (idx < 0 || idx >= days) continue;
        const b = buckets[idx]!;
        b.requests++;
        b.pt += e.pt;
        b.ct += e.ct;
        b.credits += e.credits ?? 0;
        if (e.status < 200 || e.status >= 400) b.errors++;
      }
      return buckets;
    },
    byModel(days: number): ModelBucket[] {
      const cutoff = Date.now() - days * 86_400_000;
      const map = new Map<string, ModelBucket>();
      for (const e of entries) {
        if (e.ts < cutoff || e.kind !== "chat") continue;
        let m = map.get(e.model);
        if (!m) m = map.set(e.model, { model: e.model, credits: 0, requests: 0, pt: 0, ct: 0, multiplier: 1 }).get(e.model)!;
        m.requests++;
        m.pt += e.pt;
        m.ct += e.ct;
        m.credits += e.credits ?? 0;
      }
      return [...map.values()].sort((a, b) => b.credits - a.credits);
    },
  };

  async function rewrite(): Promise<void> {
    try {
      await mkdir(DATA_DIR, { recursive: true });
      await writeFile(REQUESTS_PATH, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
    } catch { /* best effort */ }
  }
}

export type Tracker = ReturnType<typeof newTracker>;
