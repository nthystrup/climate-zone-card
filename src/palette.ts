// Colours with meaning. Light-theme values come from the design spec; dark
// variants are derived in CSS with color-mix against the card background.

export interface Tone {
  fill: string;
  ink: string;
  tint: string;
}

export const TONES = {
  cool: { fill: "#1F6FD1", ink: "#1A4F94", tint: "#E8F0FB" },
  heat: { fill: "#D2541F", ink: "#A53A12", tint: "#FBEDE6" },
  hold: { fill: "#8A5300", ink: "#6E4200", tint: "#FDF1DC" },
  vacation: { fill: "#245C63", ink: "#2F5A5F", tint: "#E9F1F2" },
  vacant: { fill: "#5A6575", ink: "#44505E", tint: "#EEF0F3" },
  off: { fill: "#7A7F87", ink: "#4D525A", tint: "#EFF0F2" },
  range: { fill: "#6A5FC1", ink: "#4B4390", tint: "#EFEDF9" },
} satisfies Record<string, Tone>;

export const HOLD_BORDER = "#F1D29B";

const KNOWN_PERIOD_TONES: Record<string, Tone> = {
  "#F2B45A": { fill: "#F2B45A", ink: "#6B4A16", tint: "#FDF3E3" },
  "#3E4C9C": { fill: "#3E4C9C", ink: "#4A4E6B", tint: "#EEF0F8" },
  "#9AA6DF": { fill: "#9AA6DF", ink: "#3E4C9C", tint: "#F0F2FB" },
};

/** Tone for a period colour; unknown colours get a color-mix derived ink and tint. */
export function periodTone(fill: string): Tone {
  const known = KNOWN_PERIOD_TONES[fill.toUpperCase()];
  if (known) return known;
  return {
    fill,
    ink: `color-mix(in srgb, ${fill} 55%, #1c1c1c)`,
    tint: `color-mix(in srgb, ${fill} 14%, #ffffff)`,
  };
}

/** Inline custom properties for an element with class "toned". */
export const toneVars = (t: Tone) =>
  `--t-fill:${t.fill};--t-ink-l:${t.ink};--t-tint-l:${t.tint};`;
