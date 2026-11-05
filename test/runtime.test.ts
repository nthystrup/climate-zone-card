import { describe, expect, it } from "vitest";
import {
  appendLive,
  dailyRuntime,
  dayStarts,
  formatRuntime,
  mergeSegments,
  segmentsFromHistory,
  sumDays,
  type HistoryRow,
} from "../src/runtime";

const T = (iso: string) => Date.parse(iso);
const row = (iso: string, action: string | null, s = "cool"): HistoryRow => ({ s, a: { hvac_action: action }, lu: T(iso) / 1000 });

// Shape of the live kitchen thermostat: ~10 min cooling, a 1 s fan tail, then idle.
const rows: HistoryRow[] = [
  row("2026-11-04T00:00:00-07:00", "idle"),
  row("2026-11-04T09:08:00-07:00", "cooling"),
  row("2026-11-04T09:18:00-07:00", "fan"),
  row("2026-11-04T09:18:01-07:00", "idle"),
  row("2026-11-04T09:30:00-07:00", "idle"), // temperature-only update, same action
  row("2026-11-04T23:55:00-07:00", "cooling"), // runs across midnight
  row("2026-11-05T00:10:00-07:00", "idle"),
  row("2026-11-05T06:00:00-07:00", "heating"),
];

describe("segments", () => {
  it("collapses rows into action segments", () => {
    const segs = segmentsFromHistory(rows);
    expect(segs.map((s) => s.action)).toEqual(["idle", "cooling", "fan", "idle", "cooling", "idle", "heating"]);
    expect(segs[1].end - segs[1].start).toBe(10 * 60000);
  });
  it("treats off and unavailable separately from idle", () => {
    const segs = segmentsFromHistory([
      { s: "off", lu: 0 },
      { s: "unavailable", lu: 60 },
      { s: "cool", a: { hvac_action: null }, lu: 120 },
    ]);
    expect(segs.map((s) => s.action)).toEqual(["off", "unknown", "idle"]);
  });
  it("merges an incremental fetch onto earlier data", () => {
    const all = segmentsFromHistory(rows);
    const early = segmentsFromHistory(rows.slice(0, 5));
    const late = segmentsFromHistory(rows.slice(4));
    expect(mergeSegments(early, late)).toEqual(all);
  });
  it("appends a live change", () => {
    const segs = segmentsFromHistory(rows.slice(0, 2));
    const out = appendLive(segs, "idle", T("2026-11-04T09:20:00-07:00"));
    expect(out.map((s) => s.action)).toEqual(["idle", "cooling", "idle"]);
    expect(out[1].end).toBe(T("2026-11-04T09:20:00-07:00"));
    expect(appendLive(out, "idle", 0)).toBe(out);
  });
});

describe("daily totals", () => {
  const starts = dayStarts(T("2026-11-05T07:00:00-07:00"), "America/Phoenix", 2);
  it("finds midnights in the server time zone", () => {
    expect(starts).toEqual([T("2026-11-04T00:00:00-07:00"), T("2026-11-05T00:00:00-07:00")]);
  });
  it("splits a run across midnight and counts cycles on the day they start", () => {
    const days = dailyRuntime(segmentsFromHistory(rows), starts, T("2026-11-05T07:00:00-07:00"));
    expect(days[0]).toMatchObject({ cooling: 15 * 60000, heating: 0, cycles: 2 });
    // 10 min of the overnight run, plus heating still running from 06:00 to now (07:00)
    expect(days[1]).toMatchObject({ cooling: 10 * 60000, heating: 60 * 60000, cycles: 1 });
  });
  it("sums linked thermostats", () => {
    const one = dailyRuntime(segmentsFromHistory(rows), starts, T("2026-11-05T07:00:00-07:00"));
    expect(sumDays([one, one])[0]).toMatchObject({ cooling: 30 * 60000, cycles: 4 });
  });
  it("handles a DST zone", () => {
    const s = dayStarts(T("2026-11-02T12:00:00-08:00"), "America/Los_Angeles", 2); // DST ended Nov 1
    expect(s).toEqual([T("2026-11-01T00:00:00-07:00"), T("2026-11-02T00:00:00-08:00")]);
  });
});

describe("formatRuntime", () => {
  it("formats durations", () => {
    expect(formatRuntime(0)).toBe("0 min");
    expect(formatRuntime(20000)).toBe("<1 min");
    expect(formatRuntime(140 * 60000)).toBe("2 h 20 min");
    expect(formatRuntime(120 * 60000)).toBe("2 h");
  });
});
