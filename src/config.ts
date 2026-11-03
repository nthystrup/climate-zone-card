import type { CardConfig, HomeAssistant, ResolvedConfig } from "./types";
import { findScheduleEntity } from "./scheduler";

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
  schedule?: string;
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
  const schedule = findScheduleEntity(st, cfg.period, cfg.schedule);
  const missing = required.filter((id) => !st[id]);
  if (!schedule) missing.push(cfg.schedule ?? `switch.schedule_${cfg.zone} (a Scheduler switch for ${cfg.period})`);
  const watched = [...new Set([...required, ...(schedule ? [schedule] : [])])];
  return { schedule, watched, missing };
}

export function periodColor(cfg: ResolvedConfig, options: string[], period: string): string {
  if (cfg.periodColors[period]) return cfg.periodColors[period];
  const i = Math.max(0, options.indexOf(period));
  return DEFAULT_PERIOD_COLORS[i % DEFAULT_PERIOD_COLORS.length];
}
