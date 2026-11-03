import { LitElement, html, css, nothing, type PropertyValues } from "lit";
import { property, state, query } from "lit/decorators.js";
import type { HomeAssistant, ResolvedConfig } from "./types";
import { baseStyles } from "./styles";
import { icon } from "./icons";
import { periodColor, setpointEntities } from "./config";
import { fmtTemp } from "./status";
import { formatDuration, formatMinutes, nowMinutes, todayIndex } from "./format";
import {
  DAY,
  DAY_SHORT,
  SNAP_MINUTES,
  buildWeek,
  copyGroupPlan,
  dayPieces,
  daysLabel,
  detectMode,
  groupsFor,
  groupsToWeek,
  minutesByPeriod,
  moveBoundary,
  parseSchedule,
  periodAtWeek,
  planToBlocks,
  planWeekSave,
  weekDayPieces,
  weekEquals,
  type DayGroup,
  type DayPlan,
  type ParsedSchedule,
  type SaveOp,
  type Week,
  type WeekMode,
} from "./scheduler";

const SETPOINT_DEBOUNCE_MS = 1000;
const SAVE_TIMEOUT_MS = 15000;
const MODES: { mode: WeekMode; label: string }[] = [
  { mode: "daily", label: "Every day" },
  { mode: "weekend", label: "Weekdays + weekend" },
  { mode: "each", label: "Each day" },
];

export class ClimateZoneScheduleDialog extends LitElement {
  @property({ attribute: false }) hass!: HomeAssistant;
  @property({ attribute: false }) cfg!: ResolvedConfig;
  /** Every Scheduler switch for the zone's period helper. */
  @property({ attribute: false }) scheduleIds: string[] = [];
  @property({ type: Boolean, reflect: true }) dark = false;

  @state() private _mode: WeekMode = "daily";
  @state() private _groups: DayGroup[] = [];
  @state() private _sel = 0;
  @state() private _copyTo: number[] = [];
  @state() private _copyOpen = false;
  @state() private _drag?: number;
  @state() private _focusHandle?: number;
  @state() private _saving = false;
  @state() private _error?: string;
  /** Setpoint values shown before HA reports them, keyed by entity id. */
  @state() private _sp: Record<string, number> = {};

  @query("dialog") private _dialog!: HTMLDialogElement;
  @query(".daybar") private _bar?: HTMLElement;

  private _spTimers = new Map<string, number>();
  private _saveWait?: { desired: ReturnType<typeof groupsToWeek>; resolve: () => void };

  open() {
    this._error = undefined;
    this._reset();
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

  // ---------------------------------------------------------------- schedule state

  private _parsed(): { schedules: ParsedSchedule[]; errors: string[] } {
    const schedules: ParsedSchedule[] = [];
    const errors: string[] = [];
    for (const id of this.scheduleIds ?? []) {
      const ent = this.hass?.states[id];
      if (!ent) continue;
      try {
        schedules.push(parseSchedule(ent));
      } catch (err) {
        errors.push((err as Error).message);
      }
    }
    return { schedules, errors };
  }

  private _week(): Week {
    return buildWeek(this._parsed().schedules);
  }

  private _reset() {
    const week = this._week();
    this._mode = detectMode(week.days);
    this._groups = groupsFor(this._mode, week.days);
    this._sel = this._groupOf(todayIndex(this.hass));
    this._copyOpen = false;
    this._copyTo = [];
  }

  private _groupOf(day: number): number {
    return Math.max(0, this._groups.findIndex((g) => g.days.includes(day)));
  }

  private get _dirty(): boolean {
    return this._groups.length > 0 && !weekEquals(groupsToWeek(this._groups), this._week().days);
  }

  private _setMode(mode: WeekMode) {
    if (mode === this._mode) return;
    const day = this._groups[this._sel]?.days[0] ?? 0;
    this._groups = groupsFor(mode, groupsToWeek(this._groups));
    this._mode = mode;
    this._sel = this._groupOf(day);
    this._copyOpen = false;
    this._copyTo = [];
  }

  private _setPlan(plan: DayPlan) {
    const groups = [...this._groups];
    groups[this._sel] = { days: groups[this._sel].days, plan };
    this._groups = groups;
  }

  protected willUpdate(changed: PropertyValues) {
    if (!changed.has("hass") || !this.hass) return;
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

    const week = this._week();
    if (this._saveWait && weekEquals(week.days, this._saveWait.desired) && !week.conflicts.length) {
      this._saveWait.resolve();
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
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    (e.currentTarget as HTMLElement).focus();
    this._drag = i;
  }

  private _onHandleMove(e: PointerEvent, i: number) {
    const g = this._groups[this._sel];
    if (this._drag !== i || !g) return;
    this._setPlan(moveBoundary(g.plan, i, this._minuteAt(e.clientX)));
  }

  private _onHandleUp(e: PointerEvent) {
    const el = e.currentTarget as HTMLElement;
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    this._drag = undefined;
  }

  private _onHandleKey(e: KeyboardEvent, i: number) {
    const g = this._groups[this._sel];
    const d = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 }[e.key];
    if (!d || !g) return;
    e.preventDefault();
    this._setPlan(moveBoundary(g.plan, i, g.plan.starts[i] + d * SNAP_MINUTES));
  }

  // ---------------------------------------------------------------- copy

  private _toggleCopyTarget(i: number) {
    this._copyTo = this._copyTo.includes(i) ? this._copyTo.filter((x) => x !== i) : [...this._copyTo, i];
  }

  private _applyCopy() {
    if (!this._copyTo.length) return;
    this._groups = copyGroupPlan(this._groups, this._sel, this._copyTo);
    this._copyTo = [];
    this._copyOpen = false;
  }

  // ---------------------------------------------------------------- save

  private _ops(): SaveOp[] {
    const week = this._week();
    return planWeekSave(
      week.sources,
      groupsToWeek(this._groups),
      this.cfg.period,
      this.cfg.name,
      new Set(Object.keys(this.hass.states)),
    );
  }

  private async _save() {
    if (!this._dirty || this._saving) return;
    const desired = groupsToWeek(this._groups);
    const ops = this._ops();
    this._saving = true;
    this._error = undefined;
    let timer: number | undefined;
    try {
      const done = new Promise<void>((resolve, reject) => {
        this._saveWait = { desired, resolve };
        timer = window.setTimeout(
          () => reject(new Error("The schedules didn't update within 15 seconds. Check them in the Scheduler card.")),
          SAVE_TIMEOUT_MS,
        );
      });
      // Edits and adds first so no day is left without a schedule, removals last.
      for (const op of ops) {
        if (op.kind === "edit") await this.hass.callService("scheduler", "edit", op.payload as unknown as Record<string, unknown>);
      }
      for (const op of ops) {
        if (op.kind === "add") await this.hass.callService("scheduler", "add", op.payload as unknown as Record<string, unknown>);
      }
      for (const op of ops) {
        if (op.kind === "remove") await this.hass.callService("scheduler", "remove", { entity_id: op.entityId });
      }
      await done;
      this.close();
    } catch (err) {
      this._error = `Couldn't save the schedule: ${(err as Error)?.message ?? err}. Your edits are kept; Save again to retry.`;
    } finally {
      clearTimeout(timer);
      this._saveWait = undefined;
      this._saving = false;
    }
  }

  private _cancel() {
    this._reset();
    this.close();
  }

  private _onClose() {
    this._drag = undefined;
    this.dispatchEvent(new CustomEvent("closed"));
  }

  // ---------------------------------------------------------------- render

  private _groupLabel(g: DayGroup): string {
    if (this._mode === "weekend") return g.days.length === 5 ? "Weekdays" : "Weekend";
    return daysLabel(g.days);
  }

  protected render() {
    if (!this.hass || !this.cfg) return nothing;
    const options: string[] = this.hass.states[this.cfg.period]?.attributes?.options ?? [];
    const { schedules, errors } = this._parsed();
    const week = buildWeek(schedules);
    const color = (p: string) => periodColor(this.cfg, options, p);
    const group = this._groups[this._sel];
    const plan = group?.plan;
    const minutes = plan ? minutesByPeriod(plan) : new Map<string, number>();
    const editable = !errors.length && !!plan;
    const desired = groupsToWeek(this._groups);
    const dirty = this._dirty;
    const ops = dirty && editable ? this._ops() : [];
    const added = ops.filter((o) => o.kind === "add").map((o) => o.entityId);
    const removed = ops.filter((o) => o.kind === "remove").map((o) => o.entityId);
    const today = todayIndex(this.hass);
    const uncovered = week.days.map((p, d) => (p ? -1 : d)).filter((d) => d >= 0);

    const n = schedules.filter((s) => s.enabled).length;
    const subtitle = `${n} schedule${n === 1 ? "" : "s"} · ${options.length} period${options.length === 1 ? "" : "s"} · ${
      this.hass.config?.time_zone ?? "server"
    } time`;

    const currentPeriod = this.hass.states[this.cfg.period]?.state;
    const switchesTo = dirty ? periodAtWeek(desired, today, nowMinutes(this.hass)) : undefined;
    const warn = switchesTo && switchesTo !== currentPeriod ? switchesTo : undefined;
    const perDay =
      this._groups.length > 1 && group
        ? `on ${this._mode === "weekend" ? this._groupLabel(group).toLowerCase() : this._groupLabel(group)}`
        : "/ day";

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
              ${options.map((p) => this._renderPeriodTile(p, color(p), minutes.get(p) ?? 0, perDay))}
            </div>
            <p class="muted hint">Setpoint changes save automatically.</p>
          </section>

          <section aria-labelledby="sd-day">
            <h3 id="sd-day">Times</h3>
            <div class="seg-ctl" role="radiogroup" aria-label="Schedule pattern">
              ${MODES.map(
                (m) => html`<button role="radio" aria-checked=${this._mode === m.mode ? "true" : "false"}
                  ?disabled=${!editable || this._saving} @click=${() => this._setMode(m.mode)}>${m.label}</button>`,
              )}
            </div>
            ${this._groups.length > 1
              ? html`<div class="chips" role="tablist" aria-label="Days">
                  ${this._groups.map(
                    (g, i) => html`<button role="tab" class="chip" aria-selected=${i === this._sel ? "true" : "false"}
                      @click=${() => {
                        this._sel = i;
                        this._copyOpen = false;
                        this._copyTo = [];
                      }}>${this._groupLabel(g)}${g.days.includes(today) ? html`<span class="today-dot" title="Today"></span>` : nothing}</button>`,
                  )}
                </div>`
              : nothing}
            ${plan
              ? this._renderDayBar(plan, color, editable)
              : html`<p class="muted">No schedule to edit.</p>`}
            ${editable && this._groups.length > 1 ? this._renderCopy() : nothing}
            ${editable ? html`<p class="muted hint">Drag a handle (or focus it and use the arrow keys) to move a change in 15-minute steps.</p>` : nothing}
          </section>

          <section aria-labelledby="sd-week">
            <h3 id="sd-week">Week</h3>
            <div class="week">
              ${DAY_SHORT.map((d, i) => {
                const gi = this._groupOf(i);
                return html`<button class="wk-row ${gi === this._sel && this._groups.length > 1 ? "sel" : ""}"
                  aria-label="Edit ${d}" ?disabled=${this._groups.length < 2}
                  @click=${() => {
                    this._sel = gi;
                    this._copyOpen = false;
                    this._copyTo = [];
                  }}>
                  <span class="wk-day ${i === today ? "today" : ""}">${d}</span>
                  <span class="strip wk-strip">
                    ${weekDayPieces(desired, i).map(
                      (pc) => html`<span class="seg" style=${this._segStyle(pc.start, pc.end, color(pc.period))}></span>`,
                    )}
                  </span>
                </button>`;
              })}
            </div>
          </section>

          ${errors.length ? html`<div class="error" role="alert">Can't edit: ${errors.join("; ")}</div>` : nothing}
          ${week.conflicts.length
            ? html`<div class="warn">${daysLabel(week.conflicts)} ${week.conflicts.length === 1 ? "is" : "are"} covered by more than one schedule. Saving replaces them with one per day.</div>`
            : nothing}
          ${uncovered.length && uncovered.length < 7
            ? html`<div class="warn">${daysLabel(uncovered)} had no schedule; the editor shows ${DAY_SHORT[week.days.findIndex(Boolean)]}'s times for ${uncovered.length === 1 ? "it" : "them"}.</div>`
            : nothing}
          ${added.length || removed.length
            ? html`<div class="info" role="status">
                ${added.length ? html`Saving adds ${this._idList(added)}.` : nothing}
                ${removed.length ? html`Saving removes ${this._idList(removed)}.` : nothing}
              </div>`
            : nothing}
          ${warn ? html`<div class="warn" role="status">Saving switches the room to ${warn} now.</div>` : nothing}
          ${this._error ? html`<div class="error" role="alert">${this._error}</div>` : nothing}

          <footer>
            <p class="muted">Changes made at the thermostat hold until the next period starts.</p>
            <div class="actions">
              <button class="ghost-btn" @click=${this._cancel} ?disabled=${this._saving}>Cancel</button>
              <button class="dark-btn" @click=${this._save} ?disabled=${!dirty || this._saving || !editable}
                title=${dirty ? "" : "Nothing to save: move a time first"}>
                ${this._saving ? "Saving…" : "Save"}
              </button>
            </div>
          </footer>
        </div>
      </dialog>
    `;
  }

  private _idList(ids: string[]) {
    return ids.map((id, i) => html`${i ? ", " : ""}<code>${id}</code>`);
  }

  private _renderCopy() {
    const src = this._groups[this._sel];
    if (!this._copyOpen) {
      return html`<div class="copy-row">
        <button class="ghost-btn sm" @click=${() => (this._copyOpen = true)}>Copy ${this._groupLabel(src)} to…</button>
      </div>`;
    }
    const others = this._groups.map((g, i) => ({ g, i })).filter((x) => x.i !== this._sel);
    const all = others.every((x) => this._copyTo.includes(x.i));
    return html`<div class="copy-box" role="group" aria-label="Copy ${this._groupLabel(src)} times to">
      <div class="copy-title">Copy ${this._groupLabel(src)}'s times to</div>
      <div class="chips">
        ${others.map(
          ({ g, i }) => html`<button class="chip" role="checkbox" aria-checked=${this._copyTo.includes(i) ? "true" : "false"}
            @click=${() => this._toggleCopyTarget(i)}>${this._copyTo.includes(i) ? icon("check", 16) : nothing}${this._groupLabel(g)}</button>`,
        )}
        ${others.length > 2
          ? html`<button class="chip link" @click=${() => (this._copyTo = all ? [] : others.map((x) => x.i))}>
              ${all ? "None" : "All"}</button>`
          : nothing}
      </div>
      <div class="copy-actions">
        <button class="ghost-btn sm" @click=${() => {
          this._copyOpen = false;
          this._copyTo = [];
        }}>Cancel</button>
        <button class="dark-btn sm" ?disabled=${!this._copyTo.length} @click=${this._applyCopy}>Copy</button>
      </div>
    </div>`;
  }

  private _segStyle(start: number, end: number, fill: string) {
    const l = (start / DAY) * 100;
    const w = ((end - start) / DAY) * 100;
    const inL = start > 0 ? 1 : 0;
    const inR = end < DAY ? 1 : 0;
    return `left:calc(${l}% + ${inL}px);width:calc(${w}% - ${inL + inR}px);--seg:${fill}`;
  }

  private _renderPeriodTile(period: string, fill: string, mins: number, perDay: string) {
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
        <span class="muted">${formatDuration(mins)} ${perDay}</span>
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
      .week {
        gap: 2px;
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
      .hint {
        margin: 8px 0 0;
        font-size: 12px;
      }
      .chips {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin-bottom: 4px;
      }
      .chip {
        min-height: 36px;
        padding: 0 12px;
        border-radius: 18px;
        border: 1px solid var(--czc-divider);
        font-size: 13px;
        font-weight: 600;
        display: inline-flex;
        align-items: center;
        gap: 4px;
      }
      .chip[aria-selected="true"],
      .chip[aria-checked="true"] {
        background: var(--czc-text);
        color: var(--czc-bg);
        border-color: var(--czc-text);
      }
      .chip.link {
        border-style: dashed;
      }
      .today-dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: var(--primary-color, #1f6fd1);
        margin-left: 2px;
      }
      .copy-row {
        margin-top: 10px;
      }
      .ghost-btn.sm,
      .dark-btn.sm {
        min-height: 40px;
        padding: 0 14px;
        font-size: 13px;
      }
      .copy-box {
        margin-top: 10px;
        border: 1px solid var(--czc-divider);
        border-radius: 12px;
        padding: 10px 12px;
      }
      .copy-title {
        font-size: 13px;
        font-weight: 600;
        margin-bottom: 8px;
      }
      .copy-actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        margin-top: 8px;
      }
      button.wk-row {
        width: 100%;
        min-height: 20px;
        border-radius: 6px;
        padding: 2px 4px;
      }
      button.wk-row:disabled {
        opacity: 1;
        cursor: default;
      }
      button.wk-row.sel {
        background: color-mix(in srgb, var(--czc-text) 7%, var(--czc-bg));
      }
      .wk-day.today {
        color: var(--czc-text);
        font-weight: 700;
      }
      .wk-strip {
        display: block;
        position: relative;
      }
      .wk-strip .seg {
        display: block;
      }
      .info {
        margin-top: 14px;
        padding: 10px 12px;
        border-radius: 10px;
        font-size: 13px;
        background: color-mix(in srgb, var(--czc-text) 6%, var(--czc-bg));
        overflow-wrap: anywhere;
      }
      .info code {
        font-size: 12px;
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
