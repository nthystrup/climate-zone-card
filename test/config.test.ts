import { describe, expect, it } from "vitest";
import { resolveConfig, validateConfig, zoneEntities, periodColor } from "../src/config";
import type { HomeAssistant } from "../src/types";
import { eastBedroomSchedule } from "./fixtures";

const e = (id: string, state = "on", attributes: Record<string, unknown> = {}) => ({ entity_id: id, state, attributes });
const hass = (ids: ReturnType<typeof e>[]): HomeAssistant =>
  ({ states: Object.fromEntries(ids.map((x) => [x.entity_id, x])), callService: async () => {} }) as HomeAssistant;

const east = hass([
  e("climate.east_bedroom_thermostat", "cool"),
  e("input_select.east_bedroom_period", "Home", { options: ["Home", "Sleep"] }),
  e("input_number.east_bedroom_home_cool", "76"),
  e("input_number.east_bedroom_home_heat", "68"),
  e("input_number.east_bedroom_sleep_cool", "74"),
  e("input_number.east_bedroom_sleep_heat", "64"),
  e("input_boolean.east_bedroom_override", "off"),
  e("input_boolean.east_bedroom_occupied", "off"),
  e("input_boolean.vacation_mode", "off"),
  e("input_number.vacation_cool_setpoint", "82"),
  e("input_number.vacation_heat_setpoint", "60"),
  eastBedroomSchedule(),
]);

describe("config", () => {
  it("requires a zone slug", () => {
    expect(() => validateConfig({})).toThrow(/zone/);
    expect(() => validateConfig({ zone: "East Bedroom" })).toThrow(/slug/);
  });
  it("derives every entity from the zone", () => {
    const c = resolveConfig({ type: "x", zone: "east_bedroom" }, east);
    expect(c.name).toBe("East Bedroom");
    expect(c.climate).toEqual(["climate.east_bedroom_thermostat"]);
    expect(c.occupied).toBe("input_boolean.east_bedroom_occupied");
    const z = zoneEntities(c, east);
    expect(z.missing).toEqual([]);
    expect(z.schedules).toEqual(["switch.schedule_east_bedroom"]);
  });
  it("treats a zone without an _occupied helper as a non-guest room", () => {
    const c = resolveConfig({ type: "x", zone: "great_room", climate: ["climate.living_room", "climate.kitchen"] }, east);
    expect(c.occupied).toBeUndefined();
  });
  it("lists missing helpers for an unmigrated zone", () => {
    const c = resolveConfig({ type: "x", zone: "west_bedroom" }, east);
    const z = zoneEntities(c, east);
    expect(z.missing).toContain("input_select.west_bedroom_period");
    expect(z.missing).toContain("input_boolean.west_bedroom_override");
    expect(z.missing.some((m) => m.startsWith("switch.schedule_west_bedroom"))).toBe(true);
  });
  it("colours periods by position with overrides", () => {
    const c = resolveConfig({ type: "x", zone: "east_bedroom", period_colors: { Sleep: "#000000" } }, east);
    expect(periodColor(c, ["Home", "Sleep", "Late"], "Home")).toBe("#F2B45A");
    expect(periodColor(c, ["Home", "Sleep", "Late"], "Sleep")).toBe("#000000");
    expect(periodColor(c, ["Home", "Sleep", "Late"], "Late")).toBe("#9AA6DF");
  });
});

import { cleanConfig, discoverZones } from "../src/config";

describe("editor helpers", () => {
  it("discovers zones from period helpers", () => {
    expect(discoverZones(east.states)).toEqual(["east_bedroom"]);
  });
  it("drops values equal to the defaults", () => {
    expect(
      cleanConfig(
        {
          type: "custom:climate-zone-card",
          zone: "east_bedroom",
          name: "East Bedroom",
          layout: "full",
          climate: ["climate.east_bedroom_thermostat"],
          occupied: "input_boolean.east_bedroom_occupied",
          dial_min: 60,
          subtitle: "",
          period_colors: { Home: "#f2b45a", Sleep: "#112233" },
        },
        east,
      ),
    ).toEqual({ type: "custom:climate-zone-card", zone: "east_bedroom", period_colors: { Sleep: "#112233" } });
  });
  it("keeps real overrides", () => {
    expect(
      cleanConfig({ type: "x", zone: "great_room", name: "Great Room", layout: "compact", climate: ["climate.living_room", "climate.kitchen"], dial_max: 90 }, east),
    ).toEqual({ type: "x", zone: "great_room", layout: "compact", climate: ["climate.living_room", "climate.kitchen"], dial_max: 90 });
  });
});
