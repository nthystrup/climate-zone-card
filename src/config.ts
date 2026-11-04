import type { CardConfig, HomeAssistant, ResolvedConfig } from "./types";
import { findScheduleEntities } from "./scheduler";

export const DEFAULT_PERIOD_COLORS = ["#F2B45A", "#3E4C9C", "#9AA6DF"];

export function titleCase(slug: string): string {
  return slug
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

/** Period name → the slug used in its setpoint helper ids ("Home" → "home"). */
export function periodSlug(period: string): string {
  return period
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

export function validateConfig(config: Partial<CardConfig>): void {
  if (!config || typeof config !== "object") throw new Error("Invalid configuration");
  if (!config.zone || typeof config.zone !== "string") {
    throw new Error("climate-zone-card: `zone` is required (for example `zone: east_bedroom`)");
  }
  if (!/^[a-z0-9_]+$/.test(config.zone)) {
    throw new Error("climate-zone-card: `zone` must be a slug like `east_bedroom`");
  }
  if (config.layout && !["full", "compact"].includes(config.layout)) {
    throw new Error("climate-zone-card: `layout` must be `full` or `compact`");
  }
}

export function resolveConfig(config: CardConfig, hass?: HomeAssistant): ResolvedConfig {
  const z = config.zone;
  const climate = config.climate
    ? (Array.isArray(config.climate) ? config.climate : [config.climate])
    : [`climate.${z}_thermostat`];
  const occupiedDefault = `input_boolean.${z}_occupied`;
  const occupied =
    config.occupied ?? (hass && hass.states[occupiedDefault] ? occupiedDefault : undefined);
  return {
    zone: z,
    name: config.name ?? titleCase(z),
    subtitle: config.subtitle,
    layout: config.layout ?? "full",
    climate,
    period: config.period ?? `input_select.${z}_period`,
    override: config.override ?? `input_boolean.${z}_override`,
    occupied,
    schedule: config.schedule,
    vacation: config.vacation ?? "input_boolean.vacation_mode",
    vacationCool: config.vacation_cool ?? "input_number.vacation_cool_setpoint",
    vacationHeat: config.vacation_heat ?? "input_number.vacation_heat_setpoint",
    dialMin: config.dial_min ?? 60,
    dialMax: config.dial_max ?? 85,
    periodColors: config.period_colors ?? {},
  };
}

/** Entity ids the zone needs, given the current period options. */
export function setpointEntities(cfg: ResolvedConfig, period: string) {
  const s = periodSlug(period);
  return {
    cool: `input_number.${cfg.zone}_${s}_cool`,
    heat: `input_number.${cfg.zone}_${s}_heat`,
  };
}

export interface ZoneEntities {
  /** Every Scheduler switch that drives the period helper (one per group of days). */
  schedules: string[];
  /** Every entity the card reads; used for shouldUpdate. */
  watched: string[];
  missing: string[];
}

export function zoneEntities(cfg: ResolvedConfig, hass: HomeAssistant): ZoneEntities {
  const st = hass.states;
  const required: string[] = [
    ...cfg.climate,
    cfg.period,
    cfg.override,
    cfg.vacation,
    cfg.vacationCool,
    cfg.vacationHeat,
  ];
  if (cfg.occupied) required.push(cfg.occupied);

  const options: string[] = st[cfg.period]?.attributes?.options ?? [];
  for (const p of options) {
    const sp = setpointEntities(cfg, p);
    required.push(sp.cool, sp.heat);
  }
  const schedules = findScheduleEntities(st, cfg.period, cfg.schedule);
  const missing = required.filter((id) => !st[id]);
  if (!schedules.length) missing.push(cfg.schedule ?? `switch.schedule_${cfg.zone} (a Scheduler switch for ${cfg.period})`);
  const watched = [...new Set([...required, ...schedules])];
  return { schedules, watched, missing };
}

export function periodColor(cfg: ResolvedConfig, options: string[], period: string): string {
  if (cfg.periodColors[period]) return cfg.periodColors[period];
  const i = Math.max(0, options.indexOf(period));
  return DEFAULT_PERIOD_COLORS[i % DEFAULT_PERIOD_COLORS.length];
}

/** Zone slugs that have a period helper (input_select.<zone>_period). */
export function discoverZones(states: Record<string, { entity_id: string }>): string[] {
  return Object.keys(states)
    .map((id) => /^input_select\.([a-z0-9_]+)_period$/.exec(id)?.[1])
    .filter((z): z is string => !!z)
    .sort();
}

/**
 * Drop keys that equal what the card would derive anyway, so the saved YAML
 * stays as short as the hand-written examples (`zone:` alone when possible).
 */
export function cleanConfig(config: CardConfig, hass?: HomeAssistant): CardConfig {
  const z = config.zone;
  const d = resolveConfig({ type: config.type, zone: z }, hass);
  const out: Record<string, unknown> = { type: config.type, zone: z };
  const keep = (key: keyof CardConfig, value: unknown, dflt?: unknown) => {
    if (value === undefined || value === null || value === "") return;
    if (Array.isArray(value) && Array.isArray(dflt) && value.length === dflt.length && value.every((v, i) => v === dflt[i])) return;
    if (value === dflt) return;
    out[key] = value;
  };
  keep("name", config.name, d.name);
  keep("subtitle", config.subtitle);
  keep("layout", config.layout, "full");
  const climate = config.climate === undefined ? undefined : Array.isArray(config.climate) ? config.climate : [config.climate];
  if (climate && climate.length) keep("climate", climate, d.climate);
  keep("period", config.period, d.period);
  keep("override", config.override, d.override);
  keep("occupied", config.occupied, d.occupied);
  keep("schedule", config.schedule);
  keep("vacation", config.vacation, d.vacation);
  keep("vacation_cool", config.vacation_cool, d.vacationCool);
  keep("vacation_heat", config.vacation_heat, d.vacationHeat);
  keep("dial_min", config.dial_min, 60);
  keep("dial_max", config.dial_max, 85);
  if (config.period_colors) {
    const options: string[] = hass?.states[config.period ?? d.period]?.attributes?.options ?? [];
    const colors = Object.fromEntries(
      Object.entries(config.period_colors).filter(([p, c]) => {
        if (!c) return false;
        const i = options.indexOf(p);
        return i < 0 || c.toUpperCase() !== DEFAULT_PERIOD_COLORS[i % DEFAULT_PERIOD_COLORS.length];
      }),
    );
    if (Object.keys(colors).length) out.period_colors = colors;
  }
  return out as unknown as CardConfig;
}
