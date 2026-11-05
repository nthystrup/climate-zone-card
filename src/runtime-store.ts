import type { HomeAssistant } from "./types";
import { appendLive, actionOf, mergeSegments, segmentsFromHistory, type HistoryRow, type Segment } from "./runtime";

// History for runtime stats, cached per thermostat and shared by every card on
// the page (the compact row's dialog reuses what the row already fetched).

const REFRESH_MS = 15 * 60 * 1000;

interface Entry {
  segs: Segment[];
  from: number;
  until: number;
  loading?: Promise<void>;
  error?: string;
}

const cache = new Map<string, Entry>();

export function runtimeEntry(id: string): Entry | undefined {
  return cache.get(id);
}

/**
 * Fetch (or top up) history for these thermostats from `from` (ms). Never throws.
 * Resolves true when new data arrived (so the caller should re-render).
 */
export async function ensureHistory(hass: HomeAssistant, ids: string[], from: number): Promise<boolean> {
  if (!hass.callWS) {
    if (ids.every((id) => cache.get(id)?.error)) return false;
    for (const id of ids) cache.set(id, { segs: [], from, until: 0, error: "This Home Assistant frontend has no history API." });
    return true;
  }
  const now = Date.now();
  const todo = ids.filter((id) => {
    const e = cache.get(id);
    return !e || (!e.loading && (e.from > from || now - e.until > REFRESH_MS));
  });
  const pending = ids.map((id) => cache.get(id)?.loading).filter(Boolean) as Promise<void>[];
  if (!todo.length) {
    if (!pending.length) return false;
    await Promise.all(pending);
    return true;
  }
  // Top up from where the cache ends unless it doesn't reach back far enough.
  const start = Math.min(...todo.map((id) => {
    const e = cache.get(id);
    return e && e.from <= from && !e.error ? e.until - 60000 : from;
  }));
  const load = (async () => {
    try {
      const res = await hass.callWS!<Record<string, HistoryRow[]>>({
        type: "history/history_during_period",
        start_time: new Date(start).toISOString(),
        end_time: new Date(now).toISOString(),
        entity_ids: todo,
        include_start_time_state: true,
        significant_changes_only: false,
        minimal_response: false,
        no_attributes: false,
      });
      for (const id of todo) {
        const fresh = segmentsFromHistory(res?.[id] ?? []);
        const old = cache.get(id);
        const segs = old && !old.error && old.from <= from ? mergeSegments(old.segs, fresh) : fresh;
        cache.set(id, { segs, from: Math.min(old?.from ?? from, from), until: now });
      }
    } catch (err) {
      for (const id of todo) {
        cache.set(id, { segs: [], from, until: now, error: (err as Error)?.message ?? String(err) });
      }
    }
  })();
  for (const id of todo) {
    const e = cache.get(id);
    cache.set(id, { segs: e?.segs ?? [], from: e?.from ?? from, until: e?.until ?? 0, loading: load });
  }
  await Promise.all([load, ...pending]);
  return true;
}

/** Fold the live state into the cache so action changes are recorded when they happen. */
export function recordLive(hass: HomeAssistant, ids: string[]): void {
  for (const id of ids) {
    const e = cache.get(id);
    const st = hass.states[id];
    if (!e || e.loading || e.error || !st) continue;
    const at = Date.parse(st.last_updated ?? "") || Date.now();
    e.segs = appendLive(e.segs, actionOf(st.state, st.attributes), at);
  }
}
