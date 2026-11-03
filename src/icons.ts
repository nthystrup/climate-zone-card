import { svg } from "lit";
import {
  mdiAccountMultiple,
  mdiAlertCircleOutline,
  mdiCalendarClock,
  mdiChevronRight,
  mdiClockOutline,
  mdiClose,
  mdiFan,
  mdiFire,
  mdiHandBackRight,
  mdiHome,
  mdiLinkVariant,
  mdiMenuDown,
  mdiMinus,
  mdiPlus,
  mdiPower,
  mdiSnowflake,
  mdiSunSnowflakeVariant,
  mdiUmbrellaBeach,
  mdiWaterPercent,
  mdiWeatherNight,
  mdiCheck,
} from "@mdi/js";

export const icons = {
  people: mdiAccountMultiple,
  alert: mdiAlertCircleOutline,
  calendar: mdiCalendarClock,
  chevron: mdiChevronRight,
  clock: mdiClockOutline,
  close: mdiClose,
  fan: mdiFan,
  heat: mdiFire,
  hand: mdiHandBackRight,
  home: mdiHome,
  link: mdiLinkVariant,
  menu: mdiMenuDown,
  minus: mdiMinus,
  plus: mdiPlus,
  off: mdiPower,
  cool: mdiSnowflake,
  range: mdiSunSnowflakeVariant,
  umbrella: mdiUmbrellaBeach,
  dry: mdiWaterPercent,
  moon: mdiWeatherNight,
  check: mdiCheck,
};

export type IconName = keyof typeof icons;

export const icon = (name: IconName, size = 20) =>
  svg`<svg class="icon" width=${size} height=${size} viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d=${icons[name]}></path></svg>`;

export function modeIcon(mode: string): IconName {
  switch (mode) {
    case "cool":
      return "cool";
    case "heat":
      return "heat";
    case "heat_cool":
    case "auto":
      return "range";
    case "fan_only":
      return "fan";
    case "dry":
      return "dry";
    default:
      return "off";
  }
}

export function periodIcon(period: string | undefined, index: number): IconName {
  const p = (period ?? "").toLowerCase();
  if (/sleep|night|bed/.test(p)) return "moon";
  if (/home|day|wake|morning/.test(p)) return "home";
  return index === 0 ? "home" : index === 1 ? "moon" : "clock";
}
