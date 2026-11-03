import { svg, nothing } from "lit";

// 270° arc with the gap at the bottom. Angles in degrees, 0 = +x, clockwise (SVG y is down).
const SIZE = 220;
const C = SIZE / 2;
const R = 96;
const START = 135;
const SWEEP = 270;

export interface DialParams {
  min: number;
  max: number;
  current?: number;
  /** Single setpoint. */
  setpoint?: number;
  /** Range (heat_cool). */
  low?: number;
  high?: number;
  off: boolean;
  /** CSS colour for the single-setpoint arc and knob ring. */
  color: string;
  heatColor: string;
  coolColor: string;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export function valueAngle(v: number, min: number, max: number): number {
  return START + SWEEP * clamp01((v - min) / (max - min || 1));
}

const pt = (deg: number) => {
  const a = (deg * Math.PI) / 180;
  return [C + R * Math.cos(a), C + R * Math.sin(a)];
};

export function arcPath(a0: number, a1: number): string {
  if (a1 < a0) [a0, a1] = [a1, a0];
  const [x0, y0] = pt(a0);
  const [x1, y1] = pt(a1);
  const large = a1 - a0 > 180 ? 1 : 0;
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${R} ${R} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

const knob = (deg: number, ring: string) => {
  const [x, y] = pt(deg);
  return svg`<circle cx=${x} cy=${y} r="11" fill="var(--czc-knob)" stroke=${ring} stroke-width="4"></circle>`;
};

export function dialSvg(p: DialParams) {
  const ang = (v: number) => valueAngle(v, p.min, p.max);
  const cur = p.current !== undefined ? ang(p.current) : undefined;
  const arcs = [];
  const knobs = [];

  if (!p.off) {
    if (p.low !== undefined && p.high !== undefined) {
      const lo = ang(p.low);
      const hi = ang(p.high);
      const mid = (lo + hi) / 2;
      if (hi - lo > 0.5) {
        arcs.push(svg`<path d=${arcPath(lo, mid)} stroke=${p.heatColor} stroke-width="14" stroke-linecap="round" fill="none"></path>`);
        arcs.push(svg`<path d=${arcPath(mid, hi)} stroke=${p.coolColor} stroke-width="14" stroke-linecap="round" fill="none"></path>`);
      }
      knobs.push(knob(lo, p.heatColor), knob(hi, p.coolColor));
    } else if (p.setpoint !== undefined) {
      const sp = ang(p.setpoint);
      if (cur !== undefined && Math.abs(cur - sp) > 0.5) {
        arcs.push(svg`<path d=${arcPath(cur, sp)} stroke=${p.color} stroke-width="14" stroke-linecap="round" fill="none"></path>`);
      }
      knobs.push(knob(sp, p.color));
    }
  }

  const curDot =
    cur !== undefined
      ? (() => {
          const [x, y] = pt(cur);
          return svg`<circle cx=${x} cy=${y} r="4" fill="#fff" stroke="rgba(0,0,0,.25)" stroke-width="1"></circle>`;
        })()
      : nothing;

  return svg`<svg class="dial-svg" viewBox="0 0 ${SIZE} ${SIZE}" width=${SIZE} height=${SIZE} aria-hidden="true">
    <path d=${arcPath(START, START + SWEEP)} stroke="var(--czc-track)" stroke-width="14" stroke-linecap="round" fill="none"></path>
    ${arcs}
    ${curDot}
    ${knobs}
  </svg>`;
}
