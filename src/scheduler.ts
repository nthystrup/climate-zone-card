// Everything that knows about the Scheduler component's data format lives here
// (nielsfaber/scheduler-component v3.x). An upstream format change should be a
// one-file fix.
//
// Read shape (switch.schedule_* attributes):
//   timeslots: ["07:00 - 20:00", "20:00 - 07:00"]
//   actions:   [{service, data: {option}}]          (pairs with timeslots[i])
//   weekdays, entities, current_slot, next_slot, next_trigger
//
// Write shape (scheduler.edit):
//   timeslots: [{start, stop, actions: [{service, entity_id, service_data}]}]

import type { HassEntity } from "./types";

export const DAY = 1440;
export const SNAP_MINUTES = 15;
export const MIN_BLOCK_MINUTES = 30;
export const SELECT_SERVICE = "input_select.select_option";

/** One timeslot. Minutes from midnight; stop < start means it wraps midnight. */
export interface Block {
  start: number;
  stop: number;
  period: string;
}

export interface ParsedSchedule {
  entityId: string;
  enabled: boolean;
  blocks: Block[];
  weekdays: string[];
  /** true when the schedule applies to every day the same way. */
  daily: boolean;
  currentSlot?: number;
  nextSlot?: number;
  nextPeriod?: string;
  nextTrigger?: Date;
}

/** A piece of the day strip, always inside 0..1440 (a wrapping block yields two). */
export interface Piece {
  start: number;
  end: number;
  period: string;
  block: number;
}

/**
 * Editor model: block i runs from starts[i] to starts[(i + 1) % n].
 * Kept in cyclic order (not necessarily ascending) so indexes stay stable while dragging.
 */
export interface DayPlan {
  starts: number[];
  periods: string[];
}

// ---------------------------------------------------------------- parsing

export function parseTime(value: string): number | null {
  const m = /^\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*$/.exec(value);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 24 || min > 59 || (h === 24 && min !== 0)) return null;
  return (h * 60 + min) % DAY;
}

export function formatHHMM(minutes: number): string {
  const m = ((Math.round(minutes) % DAY) + DAY) % DAY;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

function parseSlot(slot: string): { start: number; stop: number | null } | null {
  const [a, b] = String(slot).split(" - ");
  const start = parseTime(a ?? "");
  if (start === null) return null;
  if (b === undefined) return { start, stop: null };
  const stop = parseTime(b);
  return stop === null ? null : { start, stop };
}

/** Period name an action selects, from either the read or the write shape. */
export function actionOption(action: any): string | undefined {
  const opt = action?.data?.option ?? action?.service_data?.option;
  return typeof opt === "string" ? opt : undefined;
}

export class ScheduleParseError extends Error {}

export function parseSchedule(entity: HassEntity): ParsedSchedule {
  const a = entity.attributes ?? {};
  const slots: unknown[] = Array.isArray(a.timeslots) ? a.timeslots : [];
  const actions: unknown[] = Array.isArray(a.actions) ? a.actions : [];
  if (!slots.length) throw new ScheduleParseError(`${entity.entity_id} has no timeslots`);

  const raw = slots.map((s, i) => {
    const t = parseSlot(String(s));
    const period = actionOption(actions[i]);
    if (!t || !period) {
      throw new ScheduleParseError(`${entity.entity_id}: cannot read timeslot ${i} (${String(s)})`);
    }
    return { ...t, period };
  });

  // A slot without a stop time lasts until the next slot starts.
  const sortedStarts = [...new Set(raw.map((r) => r.start))].sort((x, y) => x - y);
  const blocks: Block[] = raw.map((r) => {
    if (r.stop !== null) return { start: r.start, stop: r.stop, period: r.period };
    const next = sortedStarts.find((s) => s > r.start) ?? sortedStarts[0];
    return { start: r.start, stop: next, period: r.period };
  });

  const weekdays: string[] = Array.isArray(a.weekdays) ? a.weekdays.map(String) : ["daily"];
  const nextSlot = typeof a.next_slot === "number" ? a.next_slot : undefined;
  const trigger = a.next_trigger ? new Date(a.next_trigger) : undefined;

  return {
    entityId: entity.entity_id,
    enabled: entity.state !== "off",
    blocks,
    weekdays,
    daily: weekdays.length === 1 && weekdays[0] === "daily",
    currentSlot: typeof a.current_slot === "number" ? a.current_slot : undefined,
    nextSlot,
    nextPeriod: nextSlot !== undefined ? actionOption(actions[nextSlot]) : undefined,
    nextTrigger: trigger && !isNaN(trigger.getTime()) ? trigger : undefined,
  };
}

/** Find the zone's schedule: the configured one if it exists, else the switch whose `entities` include the period helper. */
export function findScheduleEntity(
  states: Record<string, HassEntity>,
  periodEntity: string,
  configured?: string,
): string | undefined {
  if (configured && states[configured]) return configured;
  for (const [id, st] of Object.entries(states)) {
    if (!id.startsWith("switch.")) continue;
    const ents = st.attributes?.entities;
    if (Array.isArray(ents) && ents.includes(periodEntity) && Array.isArray(st.attributes?.timeslots)) {
      return id;
    }
  }
  return undefined;
}

/** Day-strip pieces in 0..1440; a block whose stop is before its start is split at midnight. */
export function dayPieces(blocks: Block[]): Piece[] {
  const out: Piece[] = [];
  blocks.forEach((b, i) => {
    if (b.stop > b.start) out.push({ start: b.start, end: b.stop, period: b.period, block: i });
    else if (b.stop === b.start) out.push({ start: 0, end: DAY, period: b.period, block: i });
    else {
      out.push({ start: b.start, end: DAY, period: b.period, block: i });
      if (b.stop > 0) out.push({ start: 0, end: b.stop, period: b.period, block: i });
    }
  });
  return out.sort((x, y) => x.start - y.start);
}

export function periodAtMinute(blocks: Block[], minute: number): string | undefined {
  const m = ((minute % DAY) + DAY) % DAY;
  return dayPieces(blocks).find((p) => m >= p.start && m < p.end)?.period;
}

// ---------------------------------------------------------------- editor model

export function blocksToPlan(blocks: Block[]): DayPlan {
  const sorted = [...blocks].sort((a, b) => a.start - b.start);
  return { starts: sorted.map((b) => b.start), periods: sorted.map((b) => b.period) };
}

const cyc = (from: number, to: number) => (((to - from) % DAY) + DAY) % DAY;

export function blockLength(plan: DayPlan, i: number): number {
  const n = plan.starts.length;
  if (n === 1) return DAY;
  return cyc(plan.starts[i], plan.starts[(i + 1) % n]) || DAY;
}

export function planToBlocks(plan: DayPlan): Block[] {
  const n = plan.starts.length;
  return plan.starts.map((s, i) => ({
    start: s,
    stop: n === 1 ? s : plan.starts[(i + 1) % n],
    period: plan.periods[i],
  }));
}

export function snapMinutes(minute: number, step = SNAP_MINUTES): number {
  return ((Math.round(minute / step) * step) % DAY + DAY) % DAY;
}

/**
 * Move the boundary at the start of block i to `target` (snapped), keeping
 * both neighbouring blocks at least MIN_BLOCK_MINUTES long.
 */
export function moveBoundary(plan: DayPlan, i: number, target: number): DayPlan {
  const n = plan.starts.length;
  if (n < 2) return plan;
  const prev = plan.starts[(i - 1 + n) % n];
  const next = plan.starts[(i + 1) % n];
  const span = cyc(prev, next) || DAY; // n === 2 → prev === next → the whole day
  const lo = MIN_BLOCK_MINUTES;
  const hi = span - MIN_BLOCK_MINUTES;
  if (hi < lo) return plan;

  let t = snapMinutes(target);
  let off = cyc(prev, t);
  if (off < lo || off > hi) {
    // Outside the allowed arc: clamp to whichever end is closer around the circle,
    // staying on the snap grid (absolute clock time) and inside the minimums.
    const dLo = off < lo ? lo - off : DAY - off + lo;
    const dHi = off > hi ? off - hi : off + DAY - hi;
    off = dLo <= dHi
      ? Math.ceil((prev + lo) / SNAP_MINUTES) * SNAP_MINUTES - prev
      : Math.floor((prev + hi) / SNAP_MINUTES) * SNAP_MINUTES - prev;
    if (off < lo || off > hi) return plan; // arc too short for a grid point
    t = (prev + off) % DAY;
  }
  if (t === plan.starts[i]) return plan;
  const starts = [...plan.starts];
  starts[i] = (t + DAY) % DAY;
  return { starts, periods: plan.periods };
}

/** Merge neighbouring blocks (cyclically) that select the same period. */
export function mergePlan(plan: DayPlan): DayPlan {
  let starts = [...plan.starts];
  let periods = [...plan.periods];
  let changed = true;
  while (changed && starts.length > 1) {
    changed = false;
    for (let i = 0; i < starts.length; i++) {
      const prev = (i - 1 + starts.length) % starts.length;
      if (periods[i] === periods[prev]) {
        starts.splice(i, 1);
        periods.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  return { starts, periods };
}

export function planPeriodAt(plan: DayPlan, minute: number): string | undefined {
  return periodAtMinute(planToBlocks(plan), minute);
}

export function minutesByPeriod(plan: DayPlan): Map<string, number> {
  const out = new Map<string, number>();
  plan.periods.forEach((p, i) => out.set(p, (out.get(p) ?? 0) + blockLength(plan, i)));
  return out;
}

export function planEquals(a: DayPlan, b: DayPlan): boolean {
  const x = planToBlocks(mergePlan(a)).sort((p, q) => p.start - q.start);
  const y = planToBlocks(mergePlan(b)).sort((p, q) => p.start - q.start);
  return (
    x.length === y.length &&
    x.every((v, i) => v.start === y[i].start && v.stop === y[i].stop && v.period === y[i].period)
  );
}

// ---------------------------------------------------------------- writing

export interface EditPayload {
  entity_id: string;
  weekdays: string[];
  repeat_type: "repeat";
  timeslots: {
    start: string;
    stop: string;
    actions: { service: string; entity_id: string; service_data: { option: string } }[];
  }[];
}

/** The single scheduler.edit call that saves a whole day. Merges same-period neighbours first. */
export function buildEditPayload(
  scheduleEntity: string,
  periodEntity: string,
  plan: DayPlan,
  weekdays: string[] = ["daily"],
): EditPayload {
  const blocks = planToBlocks(mergePlan(plan)).sort((a, b) => a.start - b.start);
  return {
    entity_id: scheduleEntity,
    weekdays,
    repeat_type: "repeat",
    timeslots: blocks.map((b) => ({
      start: formatHHMM(b.start),
      stop: formatHHMM(b.stop),
      actions: [{ service: SELECT_SERVICE, entity_id: periodEntity, service_data: { option: b.period } }],
    })),
  };
}

/** The `timeslots` attribute strings HA will report after a save of this plan. */
export function expectedTimeslots(plan: DayPlan): string[] {
  return planToBlocks(mergePlan(plan))
    .sort((a, b) => a.start - b.start)
    .map((b) => `${formatHHMM(b.start)} - ${formatHHMM(b.stop)}`);
}
