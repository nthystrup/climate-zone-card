import type { HassEntity } from "./types";

export interface Thermostat {
  entityId: string;
  name: string;
  mode: string;
  action?: string;
  current?: number;
  humidity?: number;
  temperature?: number;
  low?: number;
  high?: number;
  min: number;
  max: number;
  step: number;
  modes: string[];
  available: boolean;
}

const num = (v: unknown): number | undefined => {
  if (v === null || v === undefined || v === "") return undefined;
  const n = Number(v);
  return isNaN(n) ? undefined : n;
};

export function readThermostat(e: HassEntity): Thermostat {
  const a = e.attributes ?? {};
  return {
    entityId: e.entity_id,
    name: a.friendly_name ?? e.entity_id,
    mode: e.state,
    action: a.hvac_action ?? undefined,
    current: num(a.current_temperature),
    humidity: num(a.current_humidity),
    temperature: num(a.temperature),
    low: num(a.target_temp_low),
    high: num(a.target_temp_high),
    min: num(a.min_temp) ?? 45,
    max: num(a.max_temp) ?? 95,
    step: num(a.target_temp_step) ?? 1,
    modes: Array.isArray(a.hvac_modes) ? a.hvac_modes : [],
    available: e.state !== "unavailable" && e.state !== "unknown",
  };
}

export const isRange = (mode: string) => mode === "heat_cool" || mode === "auto";

export type RangeEnd = "low" | "high";

/** In heat_cool, which end −/+ act on before the user picks one. */
export function defaultEnd(action?: string): RangeEnd {
  return action === "heating" || action === "preheating" ? "low" : "high";
}

function roundToStep(v: number, step: number): number {
  return Math.round(v / step) * step;
}

export function stepValue(v: number, dir: 1 | -1, t: Pick<Thermostat, "step" | "min" | "max">): number {
  const next = roundToStep(v + dir * t.step, t.step);
  return Math.min(t.max, Math.max(t.min, Number(next.toFixed(2))));
}

export interface PendingSetpoint {
  temperature?: number;
  low?: number;
  high?: number;
}

/**
 * Apply one −/+ tap. Single-setpoint modes change `temperature`; range modes
 * change the chosen end and keep at least one step between the ends.
 */
export function applyStep(
  t: Thermostat,
  current: PendingSetpoint,
  dir: 1 | -1,
  end: RangeEnd,
): PendingSetpoint {
  if (isRange(t.mode)) {
    const low = current.low ?? t.low;
    const high = current.high ?? t.high;
    if (low === undefined || high === undefined) return current;
    if (end === "low") {
      const v = stepValue(low, dir, { ...t, max: high - t.step });
      return { low: v, high };
    }
    const v = stepValue(high, dir, { ...t, min: low + t.step });
    return { low, high: v };
  }
  const base = current.temperature ?? t.temperature;
  if (base === undefined) return current;
  return { temperature: stepValue(base, dir, t) };
}

export function setTemperatureData(mode: string, p: PendingSetpoint): Record<string, number> | undefined {
  if (isRange(mode)) {
    if (p.low === undefined || p.high === undefined) return undefined;
    return { target_temp_low: p.low, target_temp_high: p.high };
  }
  return p.temperature === undefined ? undefined : { temperature: p.temperature };
}

/** True when the entity already reports the pending value (so the local override can be dropped). */
export function reflects(t: Thermostat, p: PendingSetpoint): boolean {
  if (isRange(t.mode)) return t.low === p.low && t.high === p.high;
  return t.temperature === p.temperature;
}

export function meanCurrent(ts: Thermostat[]): number | undefined {
  const vals = ts.map((t) => t.current).filter((v): v is number => v !== undefined);
  if (!vals.length) return undefined;
  return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
}

/** Linked zone: all thermostats share mode and setpoint(s). */
export function inSync(ts: Thermostat[]): boolean {
  if (ts.length < 2) return true;
  const [f, ...rest] = ts;
  return rest.every(
    (t) => t.mode === f.mode && t.temperature === f.temperature && t.low === f.low && t.high === f.high,
  );
}

export function modeLabel(mode: string): string {
  switch (mode) {
    case "heat_cool":
      return "Heat/Cool";
    case "fan_only":
      return "Fan";
    case "off":
      return "Off";
    default:
      return mode ? mode[0].toUpperCase() + mode.slice(1) : "—";
  }
}

/** "cool" | "heat" | "range" | "off" — which palette the dial uses. */
export function modeTone(mode: string): "cool" | "heat" | "range" | "off" {
  if (mode === "cool") return "cool";
  if (mode === "heat") return "heat";
  if (isRange(mode)) return "range";
  return "off";
}

export type ActivityKind = "cooling" | "heating" | "fan" | "drying" | "defrosting" | "idle" | "off" | "unknown";

export interface Activity {
  kind: ActivityKind;
  /** "Cooling", "Fan running", … ; for a linked zone where only some run: "Cooling · Kitchen". */
  label: string;
  running: boolean;
}

const ACTION_KIND: Record<string, ActivityKind> = {
  cooling: "cooling",
  heating: "heating",
  preheating: "heating",
  fan: "fan",
  drying: "drying",
  defrosting: "defrosting",
  idle: "idle",
  off: "off",
};

const KIND_LABEL: Record<ActivityKind, string> = {
  cooling: "Cooling",
  heating: "Heating",
  fan: "Fan running",
  drying: "Drying",
  defrosting: "Defrosting",
  idle: "Idle",
  off: "Off",
  unknown: "",
};

/** Most important first: something conditioning beats fan-only beats idle. */
const PRIORITY: ActivityKind[] = ["heating", "cooling", "defrosting", "drying", "fan", "idle", "off", "unknown"];

function kindOf(t: Thermostat): ActivityKind {
  if (!t.available) return "unknown";
  if (t.action) return ACTION_KIND[t.action] ?? "unknown";
  return t.mode === "off" ? "off" : "unknown";
}

/** What the equipment is doing now, from hvac_action, across one or more thermostats. */
export function activity(ts: Thermostat[]): Activity {
  const kinds = ts.map(kindOf);
  const kind = PRIORITY.find((k) => kinds.includes(k)) ?? "unknown";
  const running = kind !== "idle" && kind !== "off" && kind !== "unknown";
  let label = KIND_LABEL[kind];
  if (running && ts.length > 1) {
    const who = ts.filter((_, i) => kinds[i] === kind).map((t) => shortName(t.name));
    if (who.length < ts.length) label += ` · ${who.join(", ")}`;
  }
  return { kind, label, running };
}

/** "Kitchen Thermostat" → "Kitchen". */
export function shortName(name: string): string {
  return name.replace(/\s+thermostat$/i, "").trim() || name;
}
