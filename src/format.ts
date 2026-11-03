import type { HomeAssistant } from "./types";

// The Scheduler runs on server time, so the card shows server time everywhere
// (day strip, "until 8:00 PM", the editor). In Phoenix that is also local time.

export function serverTimeZone(hass?: HomeAssistant): string | undefined {
  return hass?.config?.time_zone || undefined;
}

export function uses12h(hass?: HomeAssistant): boolean {
  const f = hass?.locale?.time_format;
  if (f === "12") return true;
  if (f === "24") return false;
  const lang = f === "system" ? undefined : hass?.locale?.language ?? hass?.language;
  try {
    const parts = new Intl.DateTimeFormat(lang, { hour: "numeric" }).resolvedOptions();
    return parts.hourCycle === "h12" || parts.hourCycle === "h11" || parts.hour12 === true;
  } catch {
    return true;
  }
}

function lang(hass?: HomeAssistant): string | undefined {
  return hass?.locale?.time_format === "system" ? undefined : hass?.locale?.language ?? hass?.language;
}

export function formatTime(d: Date, hass?: HomeAssistant): string {
  try {
    return new Intl.DateTimeFormat(lang(hass), {
      hour: "numeric",
      minute: "2-digit",
      hour12: uses12h(hass),
      timeZone: serverTimeZone(hass),
    }).format(d);
  } catch {
    return d.toLocaleTimeString();
  }
}

/** Minutes since midnight → "6:30 AM" / "06:30". */
export function formatMinutes(minutes: number, hass?: HomeAssistant, hourOnly = false): string {
  const m = ((minutes % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60);
  const min = m % 60;
  if (uses12h(hass)) {
    const suffix = h < 12 ? "AM" : "PM";
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return hourOnly && min === 0 ? `${h12} ${suffix}` : `${h12}:${String(min).padStart(2, "0")} ${suffix}`;
  }
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

/** Current minutes since midnight in the server's time zone. */
export function nowMinutes(hass?: HomeAssistant, now = new Date()): number {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      minute: "numeric",
      hourCycle: "h23",
      timeZone: serverTimeZone(hass),
    }).formatToParts(now);
    const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
    const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
    return (h % 24) * 60 + m;
  } catch {
    return now.getHours() * 60 + now.getMinutes();
  }
}

export function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!m) return `${h} h`;
  if (!h) return `${m} min`;
  return `${h} h ${m} min`;
}
