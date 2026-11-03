// Status line: explains what the controller automation is doing. First match wins:
// hold → vacation → no guests → period.

export type StatusKind = "hold" | "vacation" | "vacant" | "period";

export interface Setpoint {
  temperature?: number;
  low?: number;
  high?: number;
}

export interface ZoneSnapshot {
  mode: string;
  setpoint: Setpoint;
  override: boolean;
  vacation: boolean;
  guestRoom: boolean;
  occupied: boolean;
  period?: string;
  nextPeriod?: string;
  nextTrigger?: Date;
  vacationCool?: number;
  vacationHeat?: number;
  /** The next period's setpoint helpers. */
  nextSetpoints?: { cool?: number; heat?: number };
}

export interface Status {
  kind: StatusKind;
  title: string;
  detail: string;
  /** Hatched day strip instead of period segments. */
  setback: boolean;
}

export const fmtTemp = (n: number | undefined): string =>
  n === undefined || n === null || isNaN(n) ? "—" : Number.isInteger(n) ? String(n) : n.toFixed(1);

export function setpointText(mode: string, sp: Setpoint): string | undefined {
  if (mode === "heat_cool" || mode === "auto") {
    if (sp.low === undefined || sp.high === undefined) return undefined;
    return `${fmtTemp(sp.low)}–${fmtTemp(sp.high)}°`;
  }
  return sp.temperature === undefined ? undefined : `${fmtTemp(sp.temperature)}°`;
}

/** "cool to 74°", "heat to 64°", "heat to 64° / cool to 74°", or "74° cool / 64° heat" when off. */
export function targetPhrase(mode: string, cool?: number, heat?: number): string {
  switch (mode) {
    case "cool":
      return `cool to ${fmtTemp(cool)}°`;
    case "heat":
      return `heat to ${fmtTemp(heat)}°`;
    case "heat_cool":
    case "auto":
      return `heat to ${fmtTemp(heat)}° / cool to ${fmtTemp(cool)}°`;
    default:
      return `${fmtTemp(cool)}° cool / ${fmtTemp(heat)}° heat`;
  }
}

export function computeStatus(z: ZoneSnapshot, fmtTime: (d: Date) => string): Status {
  if (z.override) {
    const held = setpointText(z.mode, z.setpoint);
    const when = z.nextTrigger ? fmtTime(z.nextTrigger) : undefined;
    let detail: string;
    if (when && z.nextPeriod) detail = `Resumes ${when} with ${z.nextPeriod}`;
    else if (when) detail = `Resumes ${when}`;
    else detail = "Resumes when the next period starts";
    return { kind: "hold", title: held ? `Held at ${held}` : "Manual hold", detail, setback: false };
  }
  if (z.vacation) {
    return {
      kind: "vacation",
      title: "Vacation mode is on",
      detail: `Every room holds ${fmtTemp(z.vacationCool)}° / ${fmtTemp(z.vacationHeat)}°`,
      setback: true,
    };
  }
  if (z.guestRoom && !z.occupied) {
    return {
      kind: "vacant",
      title: "No guests staying",
      detail: `Holds ${fmtTemp(z.vacationCool)}° cool / ${fmtTemp(z.vacationHeat)}° heat`,
      setback: true,
    };
  }
  const period = z.period ?? "Schedule";
  const title = z.nextTrigger ? `${period} · until ${fmtTime(z.nextTrigger)}` : period;
  let detail = "";
  if (z.nextPeriod) {
    const sp = z.nextSetpoints ?? {};
    detail = `Next: ${z.nextPeriod}, ${targetPhrase(z.mode, sp.cool, sp.heat)}`;
  }
  return { kind: "period", title, detail, setback: false };
}
