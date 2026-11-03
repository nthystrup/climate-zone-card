import { describe, expect, it } from "vitest";
import {
  buildWeek,
  daysLabel,
  detectMode,
  expandWeekdays,
  groupsFor,
  groupsToWeek,
  moveBoundary,
  nextChange,
  parseSchedule,
  periodAtWeek,
  planWeekSave,
  weekDayPieces,
  weekEquals,
  type DayPlan,
} from "../src/scheduler";
import { eastBedroomSchedule } from "./fixtures";

const P = "input_select.east_bedroom_period";
const weekday: DayPlan = { starts: [420, 1200], periods: ["Home", "Sleep"] };
const weekend: DayPlan = { starts: [510, 1320], periods: ["Home", "Sleep"] };

const sched = (id: string, weekdays: string[], timeslots: string[], next?: string) =>
  parseSchedule({
    ...eastBedroomSchedule({ weekdays, timeslots, ...(next ? { next_trigger: next } : {}) }),
    entity_id: id,
  });

describe("weekdays", () => {
  it("expands tokens", () => {
    expect(expandWeekdays(["daily"])).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(expandWeekdays(["workday"])).toEqual([0, 1, 2, 3, 4]);
    expect(expandWeekdays(["weekend"])).toEqual([5, 6]);
    expect(expandWeekdays(["sat", "mon"])).toEqual([0, 5]);
  });
  it("labels day sets", () => {
    expect(daysLabel([0, 1, 2, 3, 4])).toBe("Mon–Fri");
    expect(daysLabel([5, 6])).toBe("Sat, Sun");
    expect(daysLabel([0, 2])).toBe("Mon, Wed");
    expect(daysLabel([0, 1, 2, 3, 4, 5, 6])).toBe("Every day");
    expect(daysLabel([0, 1, 2, 3], "-")).toBe("Mon-Thu");
  });
});

describe("buildWeek", () => {
  it("merges a weekday and a weekend schedule", () => {
    const w = buildWeek([
      sched("switch.a", ["mon", "tue", "wed", "thu", "fri"], ["07:00 - 20:00", "20:00 - 07:00"]),
      sched("switch.b", ["sat", "sun"], ["08:30 - 22:00", "22:00 - 08:30"]),
    ]);
    expect(w.days[0]).toEqual(weekday);
    expect(w.days[6]).toEqual(weekend);
    expect(w.conflicts).toEqual([]);
    expect(detectMode(w.days)).toBe("weekend");
  });
  it("reports overlapping schedules and ignores disabled ones", () => {
    const a = sched("switch.a", ["daily"], ["07:00 - 20:00", "20:00 - 07:00"]);
    const b = sched("switch.b", ["sat"], ["08:30 - 22:00", "22:00 - 08:30"]);
    expect(buildWeek([a, b]).conflicts).toEqual([5]);
    expect(buildWeek([a, { ...b, enabled: false }]).conflicts).toEqual([]);
  });
});

describe("period across days", () => {
  const week = groupsToWeek([
    { days: [0, 1, 2, 3, 4], plan: weekday },
    { days: [5, 6], plan: weekend },
  ]);
  it("carries Friday's last slot into Saturday morning", () => {
    expect(periodAtWeek(week, 5, 8 * 60)).toBe("Sleep");
    expect(periodAtWeek(week, 5, 9 * 60)).toBe("Home");
    expect(periodAtWeek(week, 6, 21 * 60 + 30)).toBe("Home"); // Sunday sleep starts at 22:00
  });
  it("draws Saturday's strip with the carry-over piece", () => {
    expect(weekDayPieces(week, 5).map((p) => [p.start, p.end, p.period])).toEqual([
      [0, 510, "Sleep"],
      [510, 1320, "Home"],
      [1320, 1440, "Sleep"],
    ]);
  });
  it("matches the old single-day strip for an every-day schedule", () => {
    const daily = groupsToWeek(groupsFor("daily", week));
    expect(weekDayPieces(daily, 2).map((p) => [p.start, p.end, p.period])).toEqual([
      [0, 420, "Sleep"],
      [420, 1200, "Home"],
      [1200, 1440, "Sleep"],
    ]);
  });
});

describe("mode switching", () => {
  const daily = groupsToWeek(groupsFor("daily", [weekday, weekday, weekday, weekday, weekday, weekday, weekday]));
  it("splits and recombines without changing the week", () => {
    expect(detectMode(daily)).toBe("daily");
    expect(weekEquals(groupsToWeek(groupsFor("weekend", daily)), daily)).toBe(true);
    expect(weekEquals(groupsToWeek(groupsFor("each", daily)), daily)).toBe(true);
  });
  it("collapsing keeps Monday's times", () => {
    const mixed = groupsToWeek([
      { days: [0, 1, 2, 3, 4], plan: weekday },
      { days: [5, 6], plan: weekend },
    ]);
    expect(groupsFor("daily", mixed)[0].plan).toEqual(weekday);
    expect(groupsFor("weekend", mixed)[1].plan).toEqual(weekend);
  });
});

describe("planWeekSave", () => {
  const existing = buildWeek([sched("switch.schedule_east_bedroom", ["daily"], ["07:00 - 20:00", "20:00 - 07:00"])]);
  const ids = new Set(["switch.schedule_east_bedroom"]);

  it("does nothing when the week is unchanged", () => {
    expect(planWeekSave(existing.sources, existing.days, P, "East Bedroom", ids)).toEqual([]);
  });

  it("edits in place for an every-day change", () => {
    const desired = groupsToWeek([{ days: [0, 1, 2, 3, 4, 5, 6], plan: moveBoundary(weekday, 0, 390) }]);
    const ops = planWeekSave(existing.sources, desired, P, "East Bedroom", ids);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ kind: "edit", entityId: "switch.schedule_east_bedroom" });
    expect((ops[0] as any).payload.weekdays).toEqual(["daily"]);
  });

  it("splitting off the weekend reuses the existing entity and adds one", () => {
    const desired = groupsToWeek([
      { days: [0, 1, 2, 3, 4], plan: weekday },
      { days: [5, 6], plan: weekend },
    ]);
    const ops = planWeekSave(existing.sources, desired, P, "East Bedroom", ids);
    expect(ops.map((o) => [o.kind, o.entityId])).toEqual([
      ["edit", "switch.schedule_east_bedroom"],
      ["add", "switch.schedule_east_bedroom_2"],
    ]);
    expect((ops[0] as any).payload.weekdays).toEqual(["mon", "tue", "wed", "thu", "fri"]);
    expect((ops[1] as any).payload).toMatchObject({
      name: "East Bedroom 2",
      weekdays: ["sat", "sun"],
      repeat_type: "repeat",
      timeslots: [
        { start: "08:30", stop: "22:00", actions: [{ service: "input_select.select_option", entity_id: P, service_data: { option: "Home" } }] },
        { start: "22:00", stop: "08:30", actions: [{ service: "input_select.select_option", entity_id: P, service_data: { option: "Sleep" } }] },
      ],
    });
  });

  it("days with identical times share an entity even in each-day mode", () => {
    const desired = groupsToWeek(groupsFor("each", groupsToWeek([
      { days: [0, 1, 2, 3, 4], plan: weekday },
      { days: [5, 6], plan: weekend },
    ])));
    expect(planWeekSave(existing.sources, desired, P, "East Bedroom", ids).filter((o) => o.kind === "add")).toHaveLength(1);
  });

  it("going back to every day removes the extra entity", () => {
    const two = buildWeek([
      sched("switch.schedule_east_bedroom", ["mon", "tue", "wed", "thu", "fri"], ["07:00 - 20:00", "20:00 - 07:00"]),
      sched("switch.schedule_east_bedroom_2", ["sat", "sun"], ["08:30 - 22:00", "22:00 - 08:30"]),
    ]);
    const desired = groupsToWeek(groupsFor("daily", two.days));
    expect(planWeekSave(two.sources, desired, P, "East Bedroom", ids).map((o) => [o.kind, o.entityId])).toEqual([
      ["edit", "switch.schedule_east_bedroom"],
      ["remove", "switch.schedule_east_bedroom_2"],
    ]);
  });

  it("keeps workday/weekend tokens when the days still match", () => {
    const w = buildWeek([
      sched("switch.wd", ["workday"], ["07:00 - 20:00", "20:00 - 07:00"]),
      sched("switch.we", ["weekend"], ["08:30 - 22:00", "22:00 - 08:30"]),
    ]);
    const desired = groupsToWeek([
      { days: [0, 1, 2, 3, 4], plan: moveBoundary(weekday, 0, 390) },
      { days: [5, 6], plan: weekend },
    ]);
    const ops = planWeekSave(w.sources, desired, P, "East Bedroom", new Set());
    expect(ops).toHaveLength(1);
    expect((ops[0] as any).payload.weekdays).toEqual(["workday"]);
  });

  it("avoids entity id collisions for new schedules", () => {
    const desired = groupsToWeek([
      { days: [0, 1, 2, 3, 4], plan: weekday },
      { days: [5, 6], plan: weekend },
    ]);
    const ops = planWeekSave(existing.sources, desired, P, "East Bedroom",
      new Set([...ids, "switch.schedule_east_bedroom_2"]));
    expect(ops[1].entityId).toBe("switch.schedule_east_bedroom_3");
  });
});

describe("nextChange", () => {
  it("picks the soonest trigger across schedules", () => {
    const a = sched("switch.a", ["mon"], ["07:00 - 20:00", "20:00 - 07:00"], "2026-11-09T07:00:00-07:00");
    const b = sched("switch.b", ["tue"], ["08:30 - 22:00", "22:00 - 08:30"], "2026-11-03T22:00:00-07:00");
    expect(nextChange([a, b]).at?.toISOString()).toBe("2026-11-04T05:00:00.000Z");
  });
});

describe("copyGroupPlan", () => {
  it("copies one day's times to others without touching the rest", async () => {
    const { copyGroupPlan } = await import("../src/scheduler");
    const groups = groupsFor("each", groupsToWeek([
      { days: [0, 1, 2, 3, 4], plan: weekday },
      { days: [5, 6], plan: weekend },
    ]));
    groups[0] = { days: [0], plan: moveBoundary(weekday, 0, 390) };
    const out = copyGroupPlan(groups, 0, [1, 2, 6]);
    expect(out[1].plan.starts).toEqual([390, 1200]);
    expect(out[6].plan.starts).toEqual([390, 1200]);
    expect(out[3].plan).toBe(groups[3].plan);
    expect(out[5].plan).toEqual(weekend);
    out[1].plan.starts[0] = 0;
    expect(out[0].plan.starts[0]).toBe(390); // independent copies
  });
});
