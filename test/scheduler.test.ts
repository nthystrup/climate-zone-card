import { describe, expect, it } from "vitest";
import {
  blocksToPlan,
  buildEditPayload,
  dayPieces,
  expectedTimeslots,
  findScheduleEntities,
  mergePlan,
  minutesByPeriod,
  moveBoundary,
  parseSchedule,
  parseTime,
  periodAtMinute,
  planPeriodAt,
  snapMinutes,
  ScheduleParseError,
} from "../src/scheduler";
import { eastBedroomSchedule } from "./fixtures";

describe("parseTime", () => {
  it("reads HH:MM and HH:MM:SS", () => {
    expect(parseTime("07:00")).toBe(420);
    expect(parseTime("20:00:00")).toBe(1200);
    expect(parseTime("24:00")).toBe(0);
    expect(parseTime("sunrise")).toBeNull();
    expect(parseTime("25:00")).toBeNull();
  });
});

describe("parseSchedule", () => {
  it("pairs timeslots with actions and finds the next period", () => {
    const s = parseSchedule(eastBedroomSchedule());
    expect(s.blocks).toEqual([
      { start: 420, stop: 1200, period: "Home" },
      { start: 1200, stop: 420, period: "Sleep" },
    ]);
    expect(s.daily).toBe(true);
    expect(s.nextPeriod).toBe("Sleep");
    expect(s.nextTrigger?.toISOString()).toBe("2026-11-04T03:00:00.000Z");
  });

  it("accepts the write shape (service_data) for actions", () => {
    const s = parseSchedule(
      eastBedroomSchedule({
        actions: [
          { service: "input_select.select_option", service_data: { option: "Home" } },
          { service: "input_select.select_option", service_data: { option: "Sleep" } },
        ],
      }),
    );
    expect(s.blocks.map((b) => b.period)).toEqual(["Home", "Sleep"]);
  });

  it("fills a missing stop with the next slot's start", () => {
    const s = parseSchedule(eastBedroomSchedule({ timeslots: ["07:00", "20:00"] }));
    expect(s.blocks).toEqual([
      { start: 420, stop: 1200, period: "Home" },
      { start: 1200, stop: 420, period: "Sleep" },
    ]);
  });

  it("throws a readable error on unreadable slots", () => {
    expect(() => parseSchedule(eastBedroomSchedule({ timeslots: ["sunrise - 20:00", "20:00 - 07:00"] }))).toThrow(
      ScheduleParseError,
    );
    expect(() => parseSchedule(eastBedroomSchedule({ timeslots: [] }))).toThrow(ScheduleParseError);
  });
});

describe("day strip", () => {
  it("splits a slot that wraps midnight into two pieces", () => {
    const { blocks } = parseSchedule(eastBedroomSchedule());
    expect(dayPieces(blocks)).toEqual([
      { start: 0, end: 420, period: "Sleep", block: 1 },
      { start: 420, end: 1200, period: "Home", block: 0 },
      { start: 1200, end: 1440, period: "Sleep", block: 1 },
    ]);
  });

  it("does not emit an empty piece for a slot ending at midnight", () => {
    const pieces = dayPieces([
      { start: 0, stop: 1200, period: "Home" },
      { start: 1200, stop: 0, period: "Sleep" },
    ]);
    expect(pieces).toHaveLength(2);
  });

  it("finds the period at a minute, including across the wrap", () => {
    const { blocks } = parseSchedule(eastBedroomSchedule());
    expect(periodAtMinute(blocks, 6 * 60 + 59)).toBe("Sleep");
    expect(periodAtMinute(blocks, 7 * 60)).toBe("Home");
    expect(periodAtMinute(blocks, 19 * 60 + 59)).toBe("Home");
    expect(periodAtMinute(blocks, 23 * 60)).toBe("Sleep");
  });
});

describe("findScheduleEntities", () => {
  const states = {
    "switch.something_else": { entity_id: "switch.something_else", state: "on", attributes: {} },
    "switch.schedule_abc123": { ...eastBedroomSchedule(), entity_id: "switch.schedule_abc123" },
  };
  it("matches by the period helper in `entities`, not by name", () => {
    expect(findScheduleEntities(states, "input_select.east_bedroom_period")).toEqual(["switch.schedule_abc123"]);
  });
  it("uses the configured entity when it exists", () => {
    expect(findScheduleEntities(states, "input_select.x", "switch.something_else")).toEqual(["switch.something_else"]);
  });
  it("returns undefined when nothing matches", () => {
    expect(findScheduleEntities(states, "input_select.west_bedroom_period")).toEqual([]);
  });
});

describe("boundary editing", () => {
  const plan = () => blocksToPlan(parseSchedule(eastBedroomSchedule()).blocks);

  it("snaps to 15 minutes", () => {
    expect(snapMinutes(397)).toBe(390);
    expect(snapMinutes(398)).toBe(405);
    expect(snapMinutes(1439)).toBe(0);
  });

  it("moves 7:00 to 6:30", () => {
    const p = moveBoundary(plan(), 0, 6 * 60 + 31);
    expect(p.starts).toEqual([390, 1200]);
    expect(expectedTimeslots(p)).toEqual(["06:30 - 20:00", "20:00 - 06:30"]);
  });

  it("enforces the 30 minute minimum on both sides", () => {
    expect(moveBoundary(plan(), 0, 1190).starts).toEqual([1170, 1200]);
    expect(moveBoundary(plan(), 1, 430).starts).toEqual([420, 450]);
  });

  it("can move a boundary across midnight", () => {
    const p = moveBoundary(plan(), 1, 23 * 60 + 55); // Sleep starts at 00:00
    expect(p.starts).toEqual([420, 0]);
    expect(expectedTimeslots(p)).toEqual(["00:00 - 07:00", "07:00 - 00:00"]);
    const q = moveBoundary(plan(), 1, 60); // Sleep starts at 01:00
    expect(expectedTimeslots(q)).toEqual(["01:00 - 07:00", "07:00 - 01:00"]);
  });

  it("clamps to the nearer end when dropped far outside", () => {
    // Block 0 (Home) start may move within (20:00 + 30m, 20:00 - 30m) around the circle.
    // With three blocks it is bounded by its neighbours.
    const three = { starts: [420, 1020, 1200], periods: ["Home", "Evening", "Sleep"] };
    expect(moveBoundary(three, 1, 1300).starts[1]).toBe(1170);
    expect(moveBoundary(three, 1, 300).starts[1]).toBe(450);
  });

  it("counts hours per period", () => {
    const m = minutesByPeriod(plan());
    expect(m.get("Home")).toBe(780);
    expect(m.get("Sleep")).toBe(660);
  });

  it("finds the period at a time in a plan", () => {
    expect(planPeriodAt(moveBoundary(plan(), 0, 390), 400)).toBe("Home");
  });
});

describe("buildEditPayload", () => {
  it("builds the exact scheduler.edit shape", () => {
    const plan = blocksToPlan(parseSchedule(eastBedroomSchedule()).blocks);
    expect(buildEditPayload("switch.schedule_east_bedroom", "input_select.east_bedroom_period", plan)).toEqual({
      entity_id: "switch.schedule_east_bedroom",
      weekdays: ["daily"],
      repeat_type: "repeat",
      timeslots: [
        {
          start: "07:00",
          stop: "20:00",
          actions: [
            {
              service: "input_select.select_option",
              entity_id: "input_select.east_bedroom_period",
              service_data: { option: "Home" },
            },
          ],
        },
        {
          start: "20:00",
          stop: "07:00",
          actions: [
            {
              service: "input_select.select_option",
              entity_id: "input_select.east_bedroom_period",
              service_data: { option: "Sleep" },
            },
          ],
        },
      ],
    });
  });

  it("merges adjacent blocks with the same period, including across the wrap", () => {
    const plan = { starts: [0, 420, 1200], periods: ["Sleep", "Home", "Sleep"] };
    expect(mergePlan(plan)).toEqual({ starts: [420, 1200], periods: ["Home", "Sleep"] });
    const payload = buildEditPayload("switch.s", "input_select.p", plan);
    expect(payload.timeslots.map((t) => `${t.start}-${t.stop}`)).toEqual(["07:00-20:00", "20:00-07:00"]);
  });
});
