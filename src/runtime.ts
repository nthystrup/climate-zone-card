// Runtime stats from the recorder's hvac_action history. Pure functions only;
// the card fetches the rows through HA's history websocket and passes them in.

export const RUNNING = ["cooling", "heating"] as const;
export type Running = (typeof RUNNING)[number];

export interface Segment {
  start: number; // ms epoch
  end: number; // ms epoch; the last segment is extended to "now" when totals are computed
  action: string;
}

/** One row of history/history_during_period (compressed keys, times in epoch seconds). */
export interface HistoryRow {
  s: string;
  a?: { hvac_action?: string | null };
  lu: number;
  lc?: number;
}

export function actionOf(state: string, attrs?: { hvac_action?: string | null }): string {
  if (state === "unavailable" || state === "unknown") return "unknown";
  return attrs?.hvac_action || (state === "off" ? "off" : "idle");
}

/** Collapse history rows into contiguous segments of one hvac_action. */
export function segmentsFromHistory(rows: HistoryRow[]): Segment[] {
  const out: Segment[] = [];
  for (const r of rows) {
    const t = (r.lu ?? r.lc ?? 0) * 1000;
    const action = actionOf(r.s, r.a);
    const last = out[out.length - 1];
    if (last && last.action === action) continue;
    if (last) last.end = t;
    out.push({ start: t, end: t, action });
  }
  return out;
}

/** Merge newer segments onto older ones (incremental fetches overlap at the seam). */
export function mergeSegments(older: Segment[], newer: Segment[]): Segment[] {
  if (!newer.length) return older;
  const cut = newer[0].start;
  const kept = older.filter((s) => s.start < cut).map((s) => ({ ...s }));
  const last = kept[kept.length - 1];
  if (last) last.end = Math.min(Math.max(last.end, cut), cut);
  const out = [...kept];
  for (const s of newer) {
    const prev = out[out.length - 1];
    if (prev && prev.action === s.action) prev.end = s.end;
    else out.push({ ...s });
  }
  return out;
}

/** Record the live state: start a new segment when the action changed at `at`. */
export function appendLive(segs: Segment[], action: string, at: number): Segment[] {
  const last = segs[segs.length - 1];
  if (last && last.action === action) return segs;
  const out = segs.map((s) => ({ ...s }));
  const prev = out[out.length - 1];
  const start = prev ? Math.max(at, prev.start) : at;
  if (prev) prev.end = start;
  out.push({ start, end: start, action });
  return out;
}

export interface DayRuntime {
  start: number;
  cooling: number; // ms
  heating: number; // ms
  cycles: number; // runs that started this day
}

/**
 * Per-day cooling/heating time. `dayStarts` are ascending midnights; each day
 * ends at the next midnight, the last one at `now`. The final segment is
 * treated as still running until `now`.
 */
export function dailyRuntime(segs: Segment[], dayStarts: number[], now: number): DayRuntime[] {
  const days: DayRuntime[] = dayStarts.map((start) => ({ start, cooling: 0, heating: 0, cycles: 0 }));
  segs.forEach((s, i) => {
    if (s.action !== "cooling" && s.action !== "heating") return;
    const end = i === segs.length - 1 ? Math.max(s.end, now) : s.end;
    days.forEach((d, k) => {
      const dEnd = k + 1 < dayStarts.length ? dayStarts[k + 1] : now;
      const overlap = Math.min(end, dEnd) - Math.max(s.start, d.start);
      if (overlap > 0) d[s.action as Running] += overlap;
      if (s.start >= d.start && s.start < dEnd) d.cycles += 1;
    });
  });
  return days;
}

/** Add several thermostats' days together (linked zones). */
export function sumDays(perThermostat: DayRuntime[][]): DayRuntime[] {
  if (!perThermostat.length) return [];
  return perThermostat[0].map((d, i) =>
    perThermostat.reduce(
      (acc, days) => ({
        start: d.start,
        cooling: acc.cooling + (days[i]?.cooling ?? 0),
        heating: acc.heating + (days[i]?.heating ?? 0),
        cycles: acc.cycles + (days[i]?.cycles ?? 0),
      }),
      { start: d.start, cooling: 0, heating: 0, cycles: 0 },
    ),
  );
}

/** Offset of a time zone from UTC at instant t, in ms (wall clock − UTC). */
function tzOffset(t: number, tz?: string): number {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(new Date(t));
  const g = (type: string) => Number(p.find((x) => x.type === type)?.value ?? 0);
  return Date.UTC(g("year"), g("month") - 1, g("day"), g("hour") % 24, g("minute"), g("second")) - Math.floor(t / 1000) * 1000;
}

/** Midnights (ms epoch) of the last `days` days in a time zone, oldest first, today last. */
export function dayStarts(now: number, tz?: string, days = 7): number[] {
  const wall = new Date(now + tzOffset(now, tz));
  const y = wall.getUTCFullYear();
  const m = wall.getUTCMonth();
  const d = wall.getUTCDate();
  const out: number[] = [];
  for (let k = days - 1; k >= 0; k--) {
    const guess = Date.UTC(y, m, d - k);
    let t = guess - tzOffset(guess, tz);
    t = guess - tzOffset(t, tz); // second pass settles DST edges
    out.push(t);
  }
  return out;
}

export function formatRuntime(ms: number): string {
  const min = Math.round(ms / 60000);
  if (min < 1) return ms > 0 ? "<1 min" : "0 min";
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (!h) return `${m} min`;
  return m ? `${h} h ${m} min` : `${h} h`;
}
