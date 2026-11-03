import { LitElement, html, css, nothing, type PropertyValues } from "lit";
import { property, state, query } from "lit/decorators.js";
import type { HomeAssistant, ResolvedConfig } from "./types";
import { baseStyles } from "./styles";
import { icon } from "./icons";
import { periodColor, setpointEntities } from "./config";
import { fmtTemp } from "./status";
import { formatDuration, formatMinutes, nowMinutes } from "./format";
import {
  DAY,
  SNAP_MINUTES,
  blocksToPlan,
  buildEditPayload,
  dayPieces,
  minutesByPeriod,
  moveBoundary,
  parseSchedule,
  planEquals,
  planPeriodAt,
  planToBlocks,
  type DayPlan,
  type ParsedSchedule,
} from "./scheduler";

const SETPOINT_DEBOUNCE_MS = 1000;
const SAVE_TIMEOUT_MS = 10000;
const WEEK = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export class ClimateZoneScheduleDialog extends LitElement {
  @property({ attribute: false }) hass!: HomeAssistant;
  @property({ attribute: false }) cfg!: ResolvedConfig;
  @property({ attribute: false }) scheduleId?: string;
  @property({ type: Boolean, reflect: true }) dark = false;

  @state() private _plan?: DayPlan;
  @state() private _saved?: DayPlan;
  @state() private _drag?: number;
  @state() private _focusHandle?: number;
  @state() private _saving = false;
  @state() private _error?: string;
  /** Setpoint values shown before HA reports them, keyed by entity id. */
  @state() private _sp: Record<string, number> = {};

  @query("dialog") private _dialog!: HTMLDialogElement;
  @query(".daybar") private _bar?: HTMLElement;

  private _spTimers = new Map<string, number>();
  private _saveWait?: { before: string; resolve: () => void };

  open() {
    this._error = undefined;
    this._resetPlan();
    this.updateComplete.then(() => {
      if (!this._dialog.open) this._dialog.showModal();
    });
  }

  close() {
    if (this._dialog?.open) this._dialog.close();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._spTimers.forEach((t) => clearTimeout(t));
    this._spTimers.clear();
  }

  private _schedule(): ParsedSchedule | undefined {
    const ent = this.scheduleId ? this.hass?.states[this.scheduleId] : undefined;
    if (!ent) return undefined;
    try {
      return parseSchedule(ent);
    } catch {
      return undefined;
    }
  }

  private _resetPlan() {
    const s = this._schedule();
    this._saved = s ? blocksToPlan(s.blocks) : undefined;
    this._plan = this._saved;
  }

  private get _dirty(): boolean {
    return !!this._plan && !!this._saved && !planEquals(this._plan, this._saved);
  }

  protected willUpdate(changed: PropertyValues) {
    if (changed.has("hass") && this.hass) {
      // Drop optimistic setpoint values once HA reports them.
      const next = { ...this._sp };
      let changedSp = false;
      for (const [id, v] of Object.entries(this._sp)) {
        if (!this._spTimers.has(id) && Number(this.hass.states[id]?.state) === v) {
          delete next[id];
          changedSp = true;
        }
      }
      if (changedSp) this._sp = next;

      // Saving: wait for the schedule attributes to change.
      const ent = this.scheduleId ? this.hass.states[this.scheduleId] : undefined;
      if (this._saveWait && ent && JSON.stringify(ent.attributes.timeslots) !== this._saveWait.before) {
        this._saveWait.resolve();
      }
      // Pick up outside changes while the user has not edited anything.
      if (!this._dirty && !this._saving) {
        const s = this._schedule();
        const saved = s ? blocksToPlan(s.blocks) : undefined;
        if (!saved || !this._saved || !planEquals(saved, this._saved)) {
          this._saved = saved;
          this._plan = saved;
        }
      }
    }
  }

  // ---------------------------------------------------------------- setpoints

  private _helper(id: string) {
    const e = this.hass.states[id];
    if (!e) return undefined;
    const a = e.attributes;
    return {
      value: this._sp[id] ?? Number(e.state),
      min: Number(a.min ?? 0),
      max: Number(a.max ?? 100),
      step: Number(a.step ?? 1),
    };
  }

  private _stepSetpoint(id: string, dir: 1 | -1) {
    const h = this._helper(id);
    if (!h || isNaN(h.value)) return;
    const v = Math.min(h.max, Math.max(h.min, Number((h.value + dir * h.step).toFixed(2))));
    if (v === h.value) return;
    this._sp = { ...this._sp, [id]: v };
    const old = this._spTimers.get(id);
    if (old) clearTimeout(old);
    this._spTimers.set(
      id,
      window.setTimeout(async () => {
        this._spTimers.delete(id);
        try {
          await this.hass.callService("input_number", "set_value", { entity_id: id, value: v });
        } catch (err) {
          const next = { ...this._sp };
          delete next[id];
          this._sp = next;
          this._error = `Couldn't save ${id}: ${(err as Error)?.message ?? err}`;
        }
      }, SETPOINT_DEBOUNCE_MS),
    );
  }

  // ---------------------------------------------------------------- day bar

  private _minuteAt(clientX: number): number {
    const r = this._bar!.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    return f * DAY;
  }

  private _onHandleDown(e: PointerEvent, i: number) {
    if (!this._plan) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    (e.currentTarget as HTMLElement).focus();
    this._drag = i;
  }

  private _onHandleMove(e: PointerEvent, i: number) {
    if (this._drag !== i || !this._plan) return;
    this._plan = moveBoundary(this._plan, i, this._minuteAt(e.clientX));
  }

  private _onHandleUp(e: PointerEvent) {
    const el = e.currentTarget as HTMLElement;
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    this._drag = undefined;
  }

  private _onHandleKey(e: KeyboardEvent, i: number) {
    if (!this._plan) return;
    const d = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 }[e.key];
    if (!d) return;
    e.preventDefault();
    this._plan = moveBoundary(this._plan, i, this._plan.starts[i] + d * SNAP_MINUTES);
  }

  // ---------------------------------------------------------------- save

  private async _save() {
    if (!this._plan || !this.scheduleId || !this._dirty) return;
    const s = this._schedule();
    const before = JSON.stringify(this.hass.states[this.scheduleId]?.attributes.timeslots);
    const payload = buildEditPayload(this.scheduleId, this.cfg.period, this._plan, s?.weekdays ?? ["daily"]);
    this._saving = true;
    this._error = undefined;
    let timer: number | undefined;
    try {
      const changed = new Promise<void>((resolve, reject) => {
        this._saveWait = { before, resolve };
        timer = window.setTimeout(
          () => reject(new Error("The schedule didn't update within 10 seconds. Check it in the Scheduler card.")),
          SAVE_TIMEOUT_MS,
        );
      });
      await this.hass.callService("scheduler", "edit", payload as unknown as Record<string, unknown>);
      await changed;
      this._saved = this._plan;
      this.close();
    } catch (err) {
      this._error = `Couldn't save the schedule: ${(err as Error)?.message ?? err}`;
    } finally {
      clearTimeout(timer);
      this._saveWait = undefined;
      this._saving = false;
    }
  }

  private _cancel() {
    this._resetPlan();
    this.close();
  }

  private _onClose() {
    this._drag = undefined;
    this.dispatchEvent(new CustomEvent("closed"));
  }

  // ---------------------------------------------------------------- render

  protected render() {
    if (!this.hass || !this.cfg) return nothing;
    const options: string[] = this.hass.states[this.cfg.period]?.attributes?.options ?? [];
    const sched = this._schedule();
    const plan = this._plan;
    const color = (p: string) => periodColor(this.cfg, options, p);
    const minutes = plan ? minutesByPeriod(plan) : new Map<string, number>();
    const editable = !!sched && sched.daily && !!plan;
    const subtitle = !sched
      ? "The schedule can't be read"
      : sched.daily
        ? `Every day · ${options.length} period${options.length === 1 ? "" : "s"} · times are ${this.hass.config?.time_zone ?? "server"} time`
        : "Custom days — only “Every day” schedules can be edited here";

    const currentPeriod = this.hass.states[this.cfg.period]?.state;
    const switchesTo = plan && this._dirty ? planPeriodAt(plan, nowMinutes(this.hass)) : undefined;
    const warn = switchesTo && switchesTo !== currentPeriod ? switchesTo : undefined;

    return html`
      <dialog
        aria-labelledby="sd-title"
        @close=${this._onClose}
        @cancel=${(e: Event) => {
          if (this._saving) e.preventDefault();
        }}
        @click=${(e: MouseEvent) => {
          if (e.target === this._dialog && !this._saving) this._cancel();
        }}
      >
        <div class="sheet">
          <header>
            <div>
              <h2 id="sd-title">${this.cfg.name} schedule</h2>
              <div class="sub">${subtitle}</div>
            </div>
            <button class="close" aria-label="Close" @click=${this._cancel} ?disabled=${this._saving}>
              ${icon("close", 22)}
            </button>
          </header>

          <section aria-labelledby="sd-periods">
            <h3 id="sd-periods">Periods</h3>
            <div class="tiles">
              ${options.map((p) => this._renderPeriodTile(p, color(p), minutes.get(p) ?? 0))}
            </div>
          </section>

          <section aria-labelledby="sd-day">
            <h3 id="sd-day">Day</h3>
            <div class="seg-ctl" role="radiogroup" aria-label="Schedule pattern">
              <button role="radio" aria-checked="true">Every day</button>
              <button role="radio" aria-checked="false" disabled title="Not supported yet">Weekdays + weekend</button>
              <button role="radio" aria-checked="false" disabled title="Not supported yet">Each day</button>
            </div>
            ${plan ? this._renderDayBar(plan, color, editable) : html`<p class="muted">No schedule to edit.</p>`}
          </section>

          <section aria-labelledby="sd-week">
            <h3 id="sd-week">Week</h3>
            <div class="week">
              ${WEEK.map(
                (d) => html`<div class="wk-row">
                  <span class="wk-day">${d}</span>
                  <div class="strip wk-strip">
                    ${plan
                      ? dayPieces(planToBlocks(plan)).map(
                          (pc) => html`<div class="seg" style=${this._segStyle(pc.start, pc.end, color(pc.period))}></div>`,
                        )
                      : nothing}
                  </div>
                </div>`,
              )}
            </div>
          </section>

          ${warn ? html`<div class="warn" role="status">Saving switches the room to ${warn} now.</div>` : nothing}
          ${this._error ? html`<div class="error" role="alert">${this._error}</div>` : nothing}

          <footer>
            <p class="muted">Changes made at the thermostat hold until the next period starts.</p>
            <div class="actions">
              <button class="ghost-btn" @click=${this._cancel} ?disabled=${this._saving}>Cancel</button>
              <button class="dark-btn" @click=${this._save} ?disabled=${!this._dirty || this._saving || !editable}>
                ${this._saving ? "Saving…" : "Save"}
              </button>
            </div>
          </footer>
        </div>
      </dialog>
    `;
  }

  private _segStyle(start: number, end: number, fill: string) {
    const l = (start / DAY) * 100;
    const w = ((end - start) / DAY) * 100;
    const inL = start > 0 ? 1 : 0;
    const inR = end < DAY ? 1 : 0;
    return `left:calc(${l}% + ${inL}px);width:calc(${w}% - ${inL + inR}px);--seg:${fill}`;
  }

  private _renderPeriodTile(period: string, fill: string, mins: number) {
    const ids = setpointEntities(this.cfg, period);
    const row = (label: string, id: string) => {
      const h = this._helper(id);
      return html`<div class="stepper">
        <span class="st-label">${label}</span>
        <button class="round sm" aria-label="Lower ${period} ${label.toLowerCase()} setpoint"
          ?disabled=${!h || h.value <= h.min} @click=${() => this._stepSetpoint(id, -1)}>${icon("minus")}</button>
        <span class="st-val" aria-live="polite">${h ? `${fmtTemp(h.value)}°` : "—"}</span>
        <button class="round sm" aria-label="Raise ${period} ${label.toLowerCase()} setpoint"
          ?disabled=${!h || h.value >= h.max} @click=${() => this._stepSetpoint(id, 1)}>${icon("plus")}</button>
      </div>`;
    };
    return html`<div class="tile">
      <div class="tile-head">
        <span class="swatch" style="background:${fill}"></span>
        <span class="tile-name">${period}</span>
        <span class="muted">${formatDuration(mins)} / day</span>
      </div>
      ${row("Cool", ids.cool)} ${row("Heat", ids.heat)}
    </div>`;
  }

  private _renderDayBar(plan: DayPlan, color: (p: string) => string, editable: boolean) {
    const pieces = dayPieces(planToBlocks(plan));
    // Label a wrapping block once, on its longer piece.
    const longest = new Map<number, number>();
    pieces.forEach((pc, idx) => {
      const prev = longest.get(pc.block);
      if (prev === undefined || pc.end - pc.start > pieces[prev].end - pieces[prev].start) longest.set(pc.block, idx);
    });
    const sp = (p: string) => {
      const ids = setpointEntities(this.cfg, p);
      const c = this._helper(ids.cool)?.value;
      const h = this._helper(ids.heat)?.value;
      return `${fmtTemp(c)}° / ${fmtTemp(h)}°`;
    };
    const ticks = Array.from({ length: 9 }, (_, i) => i * 180);
    const handles = plan.starts.length > 1 ? plan.starts : [];

    return html`
      <div class="daybar-wrap ${editable ? "" : "readonly"}">
        <div class="daybar">
          ${pieces.map((pc, idx) => {
            const label = longest.get(pc.block) === idx;
            return html`<div class="block" style=${this._segStyle(pc.start, pc.end, color(pc.period))}>
              ${label
                ? html`<span class="bl-name">${pc.period}</span><span class="bl-sp">${sp(pc.period)}</span>`
                : nothing}
            </div>`;
          })}
          ${editable
            ? handles.map((m, i) => {
                const active = this._drag === i || this._focusHandle === i;
                const t = formatMinutes(m, this.hass);
                return html`<div
                  class="handle ${active ? "active" : ""}"
                  style="left:${(m / DAY) * 100}%"
                  role="slider"
                  tabindex="0"
                  aria-label="Start of ${plan.periods[i]}"
                  aria-valuemin="0"
                  aria-valuemax=${DAY - 1}
                  aria-valuenow=${m}
                  aria-valuetext=${t}
                  @pointerdown=${(e: PointerEvent) => this._onHandleDown(e, i)}
                  @pointermove=${(e: PointerEvent) => this._onHandleMove(e, i)}
                  @pointerup=${this._onHandleUp}
                  @pointercancel=${this._onHandleUp}
                  @keydown=${(e: KeyboardEvent) => this._onHandleKey(e, i)}
                  @focus=${() => (this._focusHandle = i)}
                  @blur=${() => (this._focusHandle = undefined)}
                >
                  <span class="knob"></span>
                  ${active ? html`<span class="bubble">${t}</span>` : nothing}
                </div>`;
              })
            : nothing}
        </div>
        <div class="ticks" aria-hidden="true">
          ${ticks.map(
            (m) => html`<span class="tick ${m % 360 === 0 ? "major" : ""}" style="left:${(m / DAY) * 100}%">
              ${m % 360 === 0 ? html`<span>${formatMinutes(m, this.hass, true)}</span>` : nothing}
            </span>`,
          )}
        </div>
      </div>
    `;
  }

  static styles = [
    baseStyles,
    css`
      dialog {
        width: min(560px, calc(100vw - 16px));
      }
      .sheet {
        background: var(--czc-bg);
        border-radius: var(--czc-radius);
        padding: 20px;
        max-height: calc(100dvh - 32px);
        overflow-y: auto;
        overscroll-behavior: contain;
      }
      header {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 12px;
      }
      h2 {
        margin: 0;
        font-size: 19px;
        font-weight: 700;
      }
      h3 {
        margin: 20px 0 10px;
        font-size: 12px;
        font-weight: 600;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: var(--czc-text2);
      }
      .sub,
      .muted {
        color: var(--czc-text2);
        font-size: 13px;
      }
      .close {
        width: 44px;
        height: 44px;
        margin: -8px -8px 0 0;
        border-radius: 50%;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex: none;
      }
      .tiles {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: 10px;
      }
      .tile {
        border: 1px solid var(--czc-divider);
        border-radius: 12px;
        padding: 12px;
      }
      .tile-head {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 6px;
      }
      .tile-head .muted {
        margin-left: auto;
      }
      .swatch {
        width: 14px;
        height: 14px;
        border-radius: 4px;
        flex: none;
      }
      .tile-name {
        font-weight: 700;
        font-size: 15px;
      }
      .stepper {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-top: 6px;
      }
      .st-label {
        flex: 1;
        font-size: 14px;
        color: var(--czc-text2);
      }
      .st-val {
        min-width: 44px;
        text-align: center;
        font-size: 18px;
        font-weight: 600;
      }
      .round.sm {
        width: 44px;
        height: 44px;
      }
      .seg-ctl {
        display: flex;
        border: 1px solid var(--czc-divider);
        border-radius: 12px;
        padding: 3px;
        gap: 3px;
        margin-bottom: 14px;
      }
      .seg-ctl button {
        flex: 1;
        min-height: 38px;
        border-radius: 9px;
        font-size: 13px;
        font-weight: 600;
        padding: 0 6px;
      }
      .seg-ctl button[aria-checked="true"] {
        background: var(--czc-text);
        color: var(--czc-bg);
      }
      .daybar-wrap {
        padding: 30px 14px 0;
      }
      .daybar {
        position: relative;
        height: 64px;
        touch-action: none;
      }
      .readonly .daybar {
        opacity: 0.85;
      }
      .block {
        position: absolute;
        top: 0;
        bottom: 0;
        border-radius: 8px;
        background: var(--seg);
        overflow: hidden;
        display: flex;
        flex-direction: column;
        justify-content: center;
        padding: 0 8px 0 18px;
        color: #fff;
        text-shadow: 0 1px 1px rgba(0, 0, 0, 0.25);
        white-space: nowrap;
      }
      .bl-name {
        font-weight: 700;
        font-size: 13px;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .bl-sp {
        font-size: 12px;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .handle {
        position: absolute;
        top: 50%;
        width: 44px;
        height: 44px;
        margin: -22px 0 0 -22px;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: ew-resize;
        touch-action: none;
        outline: none;
        z-index: 1;
      }
      .handle .knob {
        width: 28px;
        height: 28px;
        border-radius: 50%;
        background: #fff;
        border: 2px solid var(--czc-text);
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
      }
      .handle:focus-visible .knob {
        outline: 2px solid var(--primary-color, #1f6fd1);
        outline-offset: 2px;
      }
      .bubble {
        position: absolute;
        bottom: calc(100% + 4px);
        left: 50%;
        transform: translateX(-50%);
        background: #1c1c1c;
        color: #fff;
        font-size: 12px;
        font-weight: 600;
        padding: 4px 8px;
        border-radius: 6px;
        white-space: nowrap;
        pointer-events: none;
      }
      .ticks {
        position: relative;
        height: 22px;
        margin-top: 4px;
      }
      .tick {
        position: absolute;
        top: 0;
        width: 1px;
        height: 4px;
        background: var(--czc-divider);
      }
      .tick.major {
        height: 6px;
        background: var(--czc-text2);
      }
      .tick span {
        position: absolute;
        top: 8px;
        left: 0;
        transform: translateX(-50%);
        font-size: 11px;
        color: var(--czc-text2);
        white-space: nowrap;
      }
      .week {
        display: grid;
        gap: 6px;
      }
      .wk-row {
        display: flex;
        align-items: center;
        gap: 10px;
      }
      .wk-day {
        width: 32px;
        font-size: 12px;
        color: var(--czc-text2);
      }
      .wk-strip {
        flex: 1;
        height: 8px;
        border-radius: 4px;
      }
      .wk-strip .seg {
        border-radius: 2px;
      }
      .warn,
      .error {
        margin-top: 14px;
        padding: 10px 12px;
        border-radius: 10px;
        font-size: 14px;
      }
      .warn {
        background: #fdf1dc;
        color: #6e4200;
      }
      .error {
        background: color-mix(in srgb, var(--error-color, #db4437) 14%, var(--czc-bg));
        color: var(--error-color, #b3261e);
      }
      :host([dark]) .warn {
        background: color-mix(in srgb, #8a5300 25%, var(--czc-bg));
        color: color-mix(in srgb, #f1d29b 80%, var(--czc-text));
      }
      footer {
        margin-top: 18px;
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 12px;
      }
      footer p {
        flex: 1 1 220px;
        margin: 0;
      }
      .actions {
        display: flex;
        gap: 8px;
        margin-left: auto;
      }
      @media (max-width: 480px) {
        .sheet {
          padding: 16px;
        }
        .daybar-wrap {
          padding-left: 10px;
          padding-right: 10px;
        }
      }
    `,
  ];
}

if (!customElements.get("climate-zone-schedule-dialog")) {
  customElements.define("climate-zone-schedule-dialog", ClimateZoneScheduleDialog);
}
