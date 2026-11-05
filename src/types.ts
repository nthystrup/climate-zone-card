// Minimal shapes of the Home Assistant frontend objects this card touches.
// Kept local so the card does not depend on HA's internal packages.

export interface HassEntity {
  entity_id: string;
  state: string;
  attributes: Record<string, any>;
  last_changed?: string;
  last_updated?: string;
}

export interface HassLocale {
  language: string;
  time_format?: "language" | "system" | "12" | "24";
  time_zone?: "local" | "server";
}

export interface HomeAssistant {
  states: Record<string, HassEntity>;
  locale?: HassLocale;
  language?: string;
  config?: { time_zone?: string; unit_system?: { temperature?: string } };
  themes?: { darkMode?: boolean };
  callService(
    domain: string,
    service: string,
    data?: Record<string, unknown>,
    target?: Record<string, unknown>,
  ): Promise<unknown>;
  callWS?<T>(msg: Record<string, unknown>): Promise<T>;
}

export type Layout = "full" | "compact";

/** Card config as the user writes it in YAML. */
export interface CardConfig {
  type: string;
  zone: string;
  name?: string;
  subtitle?: string;
  layout?: Layout;
  climate?: string | string[];
  period?: string;
  override?: string;
  occupied?: string;
  schedule?: string;
  vacation?: string;
  vacation_cool?: string;
  vacation_heat?: string;
  dial_min?: number;
  dial_max?: number;
  period_colors?: Record<string, string>;
  show_runtime?: boolean;
}

/** Config with every derived entity id filled in. */
export interface ResolvedConfig {
  zone: string;
  name: string;
  subtitle?: string;
  layout: Layout;
  climate: string[];
  period: string;
  override: string;
  /** undefined = not a guest room (always treated as occupied). */
  occupied?: string;
  /** Explicitly configured schedule entity, if any. */
  schedule?: string;
  vacation: string;
  vacationCool: string;
  vacationHeat: string;
  dialMin: number;
  dialMax: number;
  periodColors: Record<string, string>;
  showRuntime: boolean;
}

export type HvacMode = "off" | "heat" | "cool" | "heat_cool" | "auto" | "dry" | "fan_only";
