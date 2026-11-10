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

/**
 * Merge neighbouring blocks that select the same period. `cyclic` also merges
 * the first block into the last (right for an every-day plan); for a plan used
 * on only some days a midnight start must stay, because the previous day may
 * end in a different period.
 */
export function mergePlan(plan: DayPlan, cyclic = true): DayPlan {
  if (!cyclic) {
    const order = plan.starts.map((s, i) => i).sort((a, b) => plan.starts[a] - plan.starts[b]);
    const starts: number[] = [];
    const periods: string[] = [];
    for (const i of order) {
      if (periods.length && periods[periods.length - 1] === plan.periods[i]) continue;
      starts.push(plan.starts[i]);
      periods.push(plan.periods[i]);
    }
    return { starts, periods };
  }
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

/**
 * The single scheduler.edit call that saves a whole day. Merges same-period
 * neighbours first, across midnight only when the plan runs every day.
 */
export function buildEditPayload(
  scheduleEntity: string,
  periodEntity: string,
  plan: DayPlan,
  weekdays: string[] = ["daily"],
): EditPayload {
  const everyDay = expandWeekdays(weekdays).length === 7;
  const merged = mergePlan(plan, everyDay);
  const blocks = planToBlocks(merged).sort((a, b) => a.start - b.start);
  return {
    entity_id: scheduleEntity,
    weekdays,
    repeat_type: "repeat",
    timeslots: blocks.map((b) => ({
      start: formatHHMM(b.start),
      // A single all-day block would otherwise read "00:00 - 00:00".
      stop: formatHHMM(blocks.length === 1 ? b.start + DAY - 1 : b.stop),
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

// ---------------------------------------------------------------- week model
//
// One Scheduler entity has one `weekdays` list and one set of timeslots, so a
// week with different times on different days is several entities that all
// select the same period helper. These helpers merge them into a Mon..Sun view
// and work out the add/edit/remove calls that turn one week into another.

export const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export const DAY_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
export type WeekDays = (DayPlan | undefined)[];

/** Scheduler weekday tokens → day indexes (0 = Monday). `workday` is approximated as Mon–Fri. */
export function expandWeekdays(tokens: string[]): number[] {
  const out = new Set<number>();
  for (const t of tokens) {
    if (t === "daily") [0, 1, 2, 3, 4, 5, 6].forEach((d) => out.add(d));
    else if (t === "workday") [0, 1, 2, 3, 4].forEach((d) => out.add(d));
    else if (t === "weekend") [5, 6].forEach((d) => out.add(d));
    else {
      const i = (DAYS as readonly string[]).indexOf(t);
      if (i >= 0) out.add(i);
    }
  }
  return [...out].sort((a, b) => a - b);
}

export function weekdayTokens(days: number[]): string[] {
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  return sorted.length === 7 ? ["daily"] : sorted.map((d) => DAYS[d]);
}

const sameDays = (a: number[], b: number[]) => a.length === b.length && a.every((v, i) => v === b[i]);

/** "Every day", "Mon–Fri", "Sat–Sun", "Mon, Wed". `sep` lets callers use an ASCII dash for entity names. */
export function daysLabel(days: number[], sep = "–"): string {
  const d = [...new Set(days)].sort((a, b) => a - b);
  if (d.length === 7) return "Every day";
  const runs: number[][] = [];
  for (const x of d) {
    const last = runs[runs.length - 1];
    if (last && last[last.length - 1] === x - 1) last.push(x);
    else runs.push([x]);
  }
  return runs
    .map((r) => (r.length >= 3 ? `${DAY_SHORT[r[0]]}${sep}${DAY_SHORT[r[r.length - 1]]}` : r.map((x) => DAY_SHORT[x]).join(", ")))
    .join(", ");
}

export interface WeekSource {
  entityId: string;
  weekdays: string[];
  days: number[];
  plan: DayPlan;
}

export interface Week {
  days: WeekDays;
  sources: WeekSource[];
  /** Day indexes claimed by more than one schedule (the first, by entity id, wins). */
  conflicts: number[];
}

/** Merge the zone's enabled schedules into one week. */
export function buildWeek(schedules: ParsedSchedule[]): Week {
  const days: WeekDays = Array(7).fill(undefined);
  const conflicts = new Set<number>();
  const sources: WeekSource[] = [];
  for (const s of [...schedules].filter((x) => x.enabled).sort((a, b) => a.entityId.localeCompare(b.entityId))) {
    const ds = expandWeekdays(s.weekdays);
    const plan = blocksToPlan(s.blocks);
    sources.push({ entityId: s.entityId, weekdays: s.weekdays, days: ds, plan });
    for (const d of ds) {
      if (days[d]) conflicts.add(d);
      else days[d] = plan;
    }
  }
  return { days, sources, conflicts: [...conflicts].sort((a, b) => a - b) };
}

function latestStart(plan: DayPlan, upTo: number): number | undefined {
  let best: number | undefined;
  plan.starts.forEach((s, i) => {
    if (s <= upTo && (best === undefined || s > plan.starts[best])) best = i;
  });
  return best;
}

/**
 * Period in force at `minute` on `day`. Periods change only when a slot starts,
 * so before today's first start the previous day's last slot still applies.
 */
export function periodAtWeek(week: WeekDays, day: number, minute: number): string | undefined {
  for (let back = 0; back < 7; back++) {
    const plan = week[(((day - back) % 7) + 7) % 7];
    if (!plan || !plan.starts.length) continue;
    const i = latestStart(plan, back === 0 ? minute : DAY);
    if (i !== undefined) return plan.periods[i];
  }
  return undefined;
}

/** What the day strip shows for one day of the week, including the carry-over from the day before. */
export function weekDayPieces(week: WeekDays, day: number): Piece[] {
  const plan = week[day];
  const starts = plan
    ? plan.starts.map((s, i) => ({ s, p: plan.periods[i] })).sort((a, b) => a.s - b.s)
    : [];
  const out: Piece[] = [];
  const first = starts[0]?.s ?? DAY;
  if (first > 0) {
    const carry = periodAtWeek(week, (day + 6) % 7, DAY);
    if (carry) out.push({ start: 0, end: first, period: carry, block: -1 });
  }
  starts.forEach((x, i) => {
    const end = starts[i + 1]?.s ?? DAY;
    if (end > x.s) out.push({ start: x.s, end, period: x.p, block: i });
  });
  return out;
}

export function weekEquals(a: WeekDays, b: WeekDays): boolean {
  return a.every((p, i) => {
    const q = b[i];
    if (!p || !q) return !p && !q;
    return planEquals(p, q);
  });
}

// ---------------------------------------------------------------- editor groups

export type WeekMode = "daily" | "weekend" | "each";

export interface DayGroup {
  days: number[];
  plan: DayPlan;
}

const eq = (a?: DayPlan, b?: DayPlan) => !!a && !!b && planEquals(a, b);

export function detectMode(week: WeekDays): WeekMode {
  if (week.every((p) => eq(p, week[0]))) return "daily";
  if ([1, 2, 3, 4].every((d) => eq(week[d], week[0])) && eq(week[6], week[5])) return "weekend";
  return "each";
}

/** Regroup a week for a mode. Collapsing keeps Monday's times for weekdays and Saturday's for the weekend. */
export function groupsFor(mode: WeekMode, week: WeekDays): DayGroup[] {
  const fallback = week.find(Boolean) ?? { starts: [0], periods: [""] };
  const at = (d: number) => week[d] ?? fallback;
  if (mode === "daily") return [{ days: [0, 1, 2, 3, 4, 5, 6], plan: at(0) }];
  if (mode === "weekend") {
    return [
      { days: [0, 1, 2, 3, 4], plan: at(0) },
      { days: [5, 6], plan: week[5] ?? at(0) },
    ];
  }
  return [0, 1, 2, 3, 4, 5, 6].map((d) => ({ days: [d], plan: at(d) }));
}

export function groupsToWeek(groups: DayGroup[]): WeekDays {
  const week: WeekDays = Array(7).fill(undefined);
  for (const g of groups) for (const d of g.days) week[d] = g.plan;
  return week;
}

// ---------------------------------------------------------------- saving a week

export interface AddPayload {
  name: string;
  weekdays: string[];
  repeat_type: "repeat";
  timeslots: EditPayload["timeslots"];
}

export type SaveOp =
  | { kind: "edit"; entityId: string; payload: EditPayload }
  | { kind: "add"; entityId: string; payload: AddPayload }
  | { kind: "remove"; entityId: string };

/** Scheduler names a new entity switch.schedule_<slugify(name)>. */
export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * The calls that turn the zone's current schedules into `desired`. Days with
 * identical times share one entity; existing entities are reused (same days
 * first) before new ones are added, and leftovers are removed.
 */
export function planWeekSave(
  sources: WeekSource[],
  desired: WeekDays,
  periodEntity: string,
  zoneName: string,
  existingIds: Set<string>,
): SaveOp[] {
  const groups: DayGroup[] = [];
  desired.forEach((p, d) => {
    if (!p) return;
    // Keep the plan as drawn (buildEditPayload merges); a midnight start matters on some days.
    const g = groups.find((x) => planEquals(x.plan, p));
    if (g) g.days.push(d);
    else groups.push({ days: [d], plan: p });
  });

  const remaining = [...sources];
  const pairs: { g: DayGroup; s?: WeekSource }[] = groups.map((g) => {
    const i = remaining.findIndex((s) => sameDays(s.days, g.days));
    return { g, s: i >= 0 ? remaining.splice(i, 1)[0] : undefined };
  });
  for (const pr of pairs) if (!pr.s && remaining.length) pr.s = remaining.shift();

  const ops: SaveOp[] = [];
  const taken = new Set(existingIds);
  for (const { g, s } of pairs) {
    if (s) {
      if (sameDays(s.days, g.days) && planEquals(s.plan, g.plan)) continue;
      const weekdays = sameDays(s.days, g.days) ? s.weekdays : weekdayTokens(g.days);
      ops.push({ kind: "edit", entityId: s.entityId, payload: buildEditPayload(s.entityId, periodEntity, g.plan, weekdays) });
    } else {
      // Neutral names: the days an entity covers can change later, its id cannot.
      let name = zoneName;
      for (let n = 2; taken.has(`switch.schedule_${slugify(name)}`); n++) name = `${zoneName} ${n}`;
      const entityId = `switch.schedule_${slugify(name)}`;
      taken.add(entityId);
      const weekdays = weekdayTokens(g.days);
      const { timeslots } = buildEditPayload(entityId, periodEntity, g.plan, weekdays);
      ops.push({ kind: "add", entityId, payload: { name, weekdays, repeat_type: "repeat", timeslots } });
    }
  }
  for (const s of remaining) ops.push({ kind: "remove", entityId: s.entityId });
  return ops;
}

/** Find every Scheduler switch that drives the zone's period helper, plus the configured one. */
export function findScheduleEntities(
  states: Record<string, HassEntity>,
  periodEntity: string,
  configured?: string,
): string[] {
  const out = new Set<string>();
  if (configured && states[configured]) out.add(configured);
  for (const [id, st] of Object.entries(states)) {
    if (!id.startsWith("switch.")) continue;
    const ents = st.attributes?.entities;
    if (Array.isArray(ents) && ents.includes(periodEntity) && Array.isArray(st.attributes?.timeslots)) out.add(id);
  }
  return [...out].sort();
}

/**
 * The next time the period actually changes, from the merged week. Scheduler's
 * own next_trigger can be a slot that re-selects the current period (a
 * midnight "Sleep" after an evening "Sleep"). Searches up to a week ahead.
 */
export function nextPeriodChange(
  week: WeekDays,
  day: number,
  minute: number,
): { period: string; dayOffset: number; minute: number } | undefined {
  const current = periodAtWeek(week, day, minute);
  for (let k = 0; k <= 7; k++) {
    const d = (day + k) % 7;
    const plan = week[d];
    if (!plan) continue;
    const starts = plan.starts.map((s, i) => ({ s, p: plan.periods[i] })).sort((a, b) => a.s - b.s);
    for (const { s, p } of starts) {
      if (k === 0 && s <= minute) continue;
      if (p !== current) return { period: p, dayOffset: k, minute: s };
    }
  }
  return undefined;
}

/** The soonest upcoming period change across the zone's enabled schedules. */
export function nextChange(schedules: ParsedSchedule[]): { period?: string; at?: Date } {
  let best: ParsedSchedule | undefined;
  for (const s of schedules) {
    if (!s.enabled || !s.nextTrigger) continue;
    if (!best || s.nextTrigger < best.nextTrigger!) best = s;
  }
  return { period: best?.nextPeriod, at: best?.nextTrigger };
}

/** Copy group `from`'s times onto the groups in `to` (draft only; Save writes them). */
export function copyGroupPlan(groups: DayGroup[], from: number, to: number[]): DayGroup[] {
  const src = groups[from]?.plan;
  if (!src) return groups;
  return groups.map((g, i) =>
    i !== from && to.includes(i) ? { days: g.days, plan: { starts: [...src.starts], periods: [...src.periods] } } : g,
  );
}
