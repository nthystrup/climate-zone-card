import { describe, expect, it } from "vitest";
import { applyStep, defaultEnd, inSync, meanCurrent, readThermostat, setTemperatureData } from "../src/climate";

const t = (attrs: Record<string, unknown> = {}, state = "cool") =>
  readThermostat({
    entity_id: "climate.x",
    state,
    attributes: { min_temp: 45, max_temp: 92, temperature: 82, current_temperature: 73, hvac_modes: ["off", "cool"], ...attrs },
  });

describe("setpoint stepping", () => {
  it("steps by 1 when target_temp_step is absent and clamps", () => {
    expect(applyStep(t(), {}, 1, "high")).toEqual({ temperature: 83 });
    expect(applyStep(t({ temperature: 92 }), {}, 1, "high")).toEqual({ temperature: 92 });
    expect(applyStep(t({ target_temp_step: 0.5 }), { temperature: 83 }, -1, "high")).toEqual({ temperature: 82.5 });
  });
  it("acts on one end of the range and keeps the ends apart", () => {
    const r = t({ temperature: null, target_temp_low: 68, target_temp_high: 69 }, "heat_cool");
    expect(applyStep(r, {}, 1, "low")).toEqual({ low: 68, high: 69 });
    expect(applyStep(r, {}, -1, "low")).toEqual({ low: 67, high: 69 });
    expect(applyStep(r, {}, 1, "high")).toEqual({ low: 68, high: 70 });
  });
  it("builds set_temperature data", () => {
    expect(setTemperatureData("cool", { temperature: 78 })).toEqual({ temperature: 78 });
    expect(setTemperatureData("heat_cool", { low: 66, high: 77 })).toEqual({ target_temp_low: 66, target_temp_high: 77 });
  });
  it("defaults the range end from hvac_action", () => {
    expect(defaultEnd("heating")).toBe("low");
    expect(defaultEnd("cooling")).toBe("high");
    expect(defaultEnd("idle")).toBe("high");
  });
});

describe("linked zones", () => {
  it("averages and detects drift", () => {
    expect(meanCurrent([t({ current_temperature: 74 }), t({ current_temperature: 76 })])).toBe(75);
    expect(inSync([t({ temperature: 80 }), t({ temperature: 80 })])).toBe(true);
    expect(inSync([t({ temperature: 80 }), t({ temperature: 79 })])).toBe(false);
  });
});

describe("activity", async () => {
  const { activity, shortName } = await import("../src/climate");
  const th = (action: string | null, name = "Kitchen Thermostat", state = "cool") =>
    readThermostat({ entity_id: "climate.x", state, attributes: { hvac_action: action, friendly_name: name, temperature: 76 } });
  it("maps hvac_action to a label", () => {
    expect(activity([th("cooling")])).toMatchObject({ kind: "cooling", label: "Cooling", running: true });
    expect(activity([th("fan")])).toMatchObject({ kind: "fan", label: "Fan running", running: true });
    expect(activity([th("idle")])).toMatchObject({ kind: "idle", label: "Idle", running: false });
    expect(activity([th("preheating")]).kind).toBe("heating");
    expect(activity([th(null, "x", "off")])).toMatchObject({ kind: "off", label: "Off", running: false });
    expect(activity([readThermostat({ entity_id: "climate.x", state: "unavailable", attributes: {} })]).kind).toBe("unknown");
  });
  it("names the running thermostat in a linked zone", () => {
    expect(activity([th("idle", "Living Room Thermostat"), th("cooling", "Kitchen Thermostat")]).label).toBe("Cooling · Kitchen");
    expect(activity([th("cooling", "Living Room Thermostat"), th("cooling")]).label).toBe("Cooling");
    expect(activity([th("fan", "Living Room Thermostat"), th("cooling")]).label).toBe("Cooling · Kitchen");
    expect(activity([th("idle", "Living Room Thermostat"), th("idle")]).label).toBe("Idle");
  });
  it("shortens thermostat names", () => {
    expect(shortName("Living Room Thermostat")).toBe("Living Room");
    expect(shortName("Kitchen")).toBe("Kitchen");
  });
});
