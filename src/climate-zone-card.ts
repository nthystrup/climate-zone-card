import { LitElement, html, css, nothing, unsafeCSS, type PropertyValues } from "lit";
import { property, state, query } from "lit/decorators.js";
import type { CardConfig, HomeAssistant, ResolvedConfig } from "./types";
import { baseStyles } from "./styles";
import { icon, modeIcon, periodIcon, type IconName } from "./icons";
import { TONES, periodTone, toneVars, type Tone } from "./palette";
import { periodColor, resolveConfig, setpointEntities, validateConfig, zoneEntities } from "./config";
import {
  applyStep,
  defaultEnd,
  inSync,
  isRange,
  meanCurrent,
  modeLabel,
  modeTone,
  readThermostat,
  reflects,
  setTemperatureData,
  type PendingSetpoint,
  type RangeEnd,
  type Thermostat,
} from "./climate";
import { computeStatus, fmtTemp, type Status } from "./status";
import { formatMinutes, formatTime, nowMinutes } from "./format";
import { DAY, dayPieces, parseSchedule, type ParsedSchedule } from "./scheduler";
import { dialSvg } from "./dial";
import "./schedule-dialog";
import type { ClimateZoneScheduleDialog } from "./schedule-dialog";

const VERSION = "0.1.0";
const SEND_DELAY_MS = 1500;
const PENDING_TIMEOUT_MS = 10000;

interface Model {
  cfg: ResolvedConfig;
  thermostats: Thermostat[];
  lead: Thermostat;
  options: string[];
  period?: string;
  schedule?: ParsedSchedule;
  scheduleError?: string;
  status: Status;
  tone: Tone;
  override: boolean;
  occupied: boolean;
  synced: boolean;
  current?: number;
}

const num = (s: string | undefined) => {
  const n = Number(s);
  return s === undefined || isNaN(n) ? undefined : n;
};

export class ClimateZoneCard extends LitElement {
  @property({ attribute: false }) hass?: HomeAssistant;
  @property({ type: Boolean, reflect: true }) dark = false;
  @state() private _config?: CardConfig;
  @state() private _pending?: PendingSetpoint;
  @state() private _end?: RangeEnd;
  @state() private _menuOpen = false;
  @state() private _error?: string;
  @state() private _roomOpen = false;
  @state() private _tick = 0;

  @query("climate-zone-schedule-dialog") private _schedDialog?: ClimateZoneScheduleDialog;
  @query("dialog.room") private _roomDialog?: HTMLDialogElement;

  private _cfg?: ResolvedConfig;
  private _watched: string[] = [];
  private _sendTimer?: number;
  private _sentAt?: number;
  private _clock?: number;

  // ---------------------------------------------------------------- HA card API

  setConfig(config: CardConfig) {
    validateConfig(config);
    this._config = config;
    this._cfg = undefined;
  }

  getCardSize() {
    return this._config?.layout === "compact" ? 2 : 9;
  }

  getGridOptions() {
    return this._config?.layout === "compact"
      ? { columns: 12, rows: 2, min_columns: 6 }
      : { columns: 12, rows: "auto", min_columns: 6 };
  }

  static getStubConfig() {
    return { zone: "east_bedroom" };
  }

  // ---------------------------------------------------------------- lifecycle

  connectedCallback() {
    super.connectedCallback();
    this._clock = window.setInterval(() => (this._tick = Date.now()), 30000);
    document.addEventListener("click", this._onDocClick, true);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    clearInterval(this._clock);
    clearTimeout(this._sendTimer);
    document.removeEventListener("click", this._onDocClick, true);
  }

  protected shouldUpdate(changed: PropertyValues): boolean {
    if (changed.size !== 1 || !changed.has("hass")) return true;
    const old = changed.get("hass") as HomeAssistant | undefined;
    const hass = this.hass;
    if (!old || !hass || !this._cfg) return true;
    if (old.themes?.darkMode !== hass.themes?.darkMode || old.locale !== hass.locale) return true;
    // Entity set can change (e.g. a helper gets created): recompute when any watched or occupied id differs.
    const ids = [...this._watched, `input_boolean.${this._cfg.zone}_occupied`];
    return ids.some((id) => old.states[id] !== hass.states[id]);
  }

  protected willUpdate(changed: PropertyValues) {
    if (!this.hass || !this._config) return;
    if (changed.has("_config") || changed.has("hass")) {
      this._cfg = resolveConfig(this._config, this.hass);
    }
    const dark = !!this.hass.themes?.darkMode;
    if (dark !== this.dark) this.dark = dark;

    // Drop the optimistic setpoint once HA reports it, or give up after a while.
    if (this._pending && this._sentAt && !this._sendTimer) {
      const lead = this._cfg?.climate[0] && this.hass.states[this._cfg.climate[0]];
      if ((lead && reflects(readThermostat(lead), this._pending)) || Date.now() - this._sentAt > PENDING_TIMEOUT_MS) {
        this._pending = undefined;
        this._sentAt = undefined;
      }
    }
  }

  private _onDocClick = (e: MouseEvent) => {
    if (this._menuOpen && !e.composedPath().includes(this.renderRoot.querySelector(".mode-wrap") as EventTarget)) {
      this._menuOpen = false;
    }
  };

  // ---------------------------------------------------------------- model

  private _model(): Model | { missing: string[]; cfg: ResolvedConfig } {
    const hass = this.hass!;
    const cfg = this._cfg!;
    const ents = zoneEntities(cfg, hass);
    this._watched = ents.watched;
    if (ents.missing.length) return { missing: ents.missing, cfg };

    const st = hass.states;
    const thermostats = cfg.climate.map((id) => readThermostat(st[id]));
    const lead = thermostats[0];
    const options: string[] = st[cfg.period].attributes.options ?? [];
    const period = st[cfg.period].state;

    let schedule: ParsedSchedule | undefined;
    let scheduleError: string | undefined;
    try {
      schedule = parseSchedule(st[ents.schedule!]);
    } catch (err) {
      scheduleError = (err as Error).message;
    }

    const override = st[cfg.override].state === "on";
    const vacation = st[cfg.vacation].state === "on";
    const occupied = cfg.occupied ? st[cfg.occupied].state === "on" : true;
    const nextSp = schedule?.nextPeriod ? setpointEntities(cfg, schedule.nextPeriod) : undefined;
    const sp = this._pending ?? {};

    const status = computeStatus(
      {
        mode: lead.mode,
        setpoint: {
          temperature: sp.temperature ?? lead.temperature,
          low: sp.low ?? lead.low,
          high: sp.high ?? lead.high,
        },
        override,
        vacation,
        guestRoom: !!cfg.occupied,
        occupied,
        period,
        nextPeriod: schedule?.nextPeriod,
        nextTrigger: schedule?.nextTrigger,
        vacationCool: num(st[cfg.vacationCool]?.state),
        vacationHeat: num(st[cfg.vacationHeat]?.state),
        nextSetpoints: nextSp ? { cool: num(st[nextSp.cool]?.state), heat: num(st[nextSp.heat]?.state) } : undefined,
      },
      (d) => formatTime(d, hass),
    );

    const tone =
      status.kind === "hold"
        ? TONES.hold
        : status.kind === "vacation"
          ? TONES.vacation
          : status.kind === "vacant"
            ? TONES.vacant
            : periodTone(periodColor(cfg, options, period));

    return {
      cfg,
      thermostats,
      lead,
      options,
      period,
      schedule,
      scheduleError,
      status,
      tone,
      override,
      occupied,
      synced: inSync(thermostats),
      current: thermostats.length > 1 ? meanCurrent(thermostats) : lead.current,
    };
  }

  // ---------------------------------------------------------------- actions

  private _call(domain: string, service: string, data: Record<string, unknown>) {
    this._error = undefined;
    return this.hass!.callService(domain, service, data).catch((err) => {
      this._error = `${domain}.${service} failed: ${err?.message ?? err}`;
      throw err;
    });
  }

  private _step(m: Model, dir: 1 | -1) {
    const end = this._end ?? defaultEnd(m.lead.action);
    const next = applyStep(m.lead, this._pending ?? {}, dir, end);
    if (!setTemperatureData(m.lead.mode, next)) return;
    this._pending = next;
    this._sentAt = undefined;
    clearTimeout(this._sendTimer);
    this._sendTimer = window.setTimeout(() => {
      this._sendTimer = undefined;
      const data = this._pending && setTemperatureData(m.lead.mode, this._pending);
      if (!data) return;
      this._sentAt = Date.now();
      this._call("climate", "set_temperature", { entity_id: m.cfg.climate, ...data }).catch(() => {
        this._pending = undefined;
        this._sentAt = undefined;
      });
    }, SEND_DELAY_MS);
  }

  private _setMode(m: Model, mode: string) {
    this._menuOpen = false;
    if (mode === m.lead.mode && m.synced) return;
    this._call("climate", "set_hvac_mode", { entity_id: m.cfg.climate, hvac_mode: mode }).catch(() => {});
  }

  private _resume(m: Model) {
    this._call("input_boolean", "turn_off", { entity_id: m.cfg.override }).catch(() => {});
  }

  private _toggleGuests(m: Model) {
    if (!m.cfg.occupied) return;
    this._call("input_boolean", "toggle", { entity_id: m.cfg.occupied }).catch(() => {});
  }

  private _openSchedule() {
    this._schedDialog?.open();
  }

  private _openRoom() {
    this._roomOpen = true;
    this.updateComplete.then(() => this._roomDialog?.showModal());
  }

  // ---------------------------------------------------------------- render

  protected render() {
    if (!this._config) return nothing;
    if (!this.hass || !this._cfg) return html`<div class="card pad muted">Loading…</div>`;
    void this._tick;
    const m = this._model();
    if ("missing" in m) return this._renderMissing(m.cfg, m.missing);
    return m.cfg.layout === "compact" ? this._renderCompact(m) : this._renderFull(m);
  }

  private _renderMissing(cfg: ResolvedConfig, missing: string[]) {
    return html`<div class="card pad error-card" role="alert">
      <div class="err-head">${icon("alert", 22)}<strong>${cfg.name} can't be shown</strong></div>
      <p>These entities don't exist yet. Create them or override their ids in the card config:</p>
      <ul>
        ${missing.map((id) => html`<li><code>${id}</code></li>`)}
      </ul>
    </div>`;
  }

  private _modeTone(mode: string): Tone {
    return TONES[modeTone(mode)];
  }

  private _strip(m: Model, height = 12) {
    const now = (nowMinutes(this.hass) / DAY) * 100;
    if (m.status.setback || !m.schedule) {
      return html`<div class="strip toned" style="height:${height}px;${toneVars(m.tone)}">
        <div class="hatch"></div>
        <div class="now" style="left:${now}%"></div>
      </div>`;
    }
    const pieces = dayPieces(m.schedule.blocks);
    return html`<div class="strip" style="height:${height}px">
      ${pieces.map((pc) => {
        const l = (pc.start / DAY) * 100;
        const w = ((pc.end - pc.start) / DAY) * 100;
        const inL = pc.start > 0 ? 1 : 0;
        const inR = pc.end < DAY ? 1 : 0;
        return html`<div
          class="seg"
          title="${pc.period} ${formatMinutes(pc.start, this.hass)}–${formatMinutes(pc.end, this.hass)}"
          style="left:calc(${l}% + ${inL}px);width:calc(${w}% - ${inL + inR}px);--seg:${periodColor(
            m.cfg,
            m.options,
            pc.period,
          )}"
        ></div>`;
      })}
      <div class="now" style="left:${now}%"></div>
    </div>`;
  }

  private _statusIcon(m: Model): IconName {
    switch (m.status.kind) {
      case "hold":
        return "hand";
      case "vacation":
        return "umbrella";
      case "vacant":
        return "people";
      default:
        return periodIcon(m.period, m.options.indexOf(m.period ?? ""));
    }
  }

  private _shownSetpoint(m: Model): PendingSetpoint {
    const p = this._pending ?? {};
    return {
      temperature: p.temperature ?? m.lead.temperature,
      low: p.low ?? m.lead.low,
      high: p.high ?? m.lead.high,
    };
  }

  private _targetShort(m: Model): string {
    const sp = this._shownSetpoint(m);
    const mode = m.lead.mode;
    if (mode === "off") return "Off";
    if (isRange(mode)) return `${fmtTemp(sp.low)}–${fmtTemp(sp.high)}°`;
    if (mode === "cool") return `Cool to ${fmtTemp(sp.temperature)}°`;
    if (mode === "heat") return `Heat to ${fmtTemp(sp.temperature)}°`;
    return modeLabel(mode);
  }

  private _renderFull(m: Model) {
    const cfg = m.cfg;
    const mode = m.lead.mode;
    const off = mode === "off" || !m.lead.available;
    const range = isRange(mode);
    const mt = this._modeTone(mode);
    const sp = this._shownSetpoint(m);
    const end = this._end ?? defaultEnd(m.lead.action);
    const active = m.lead.action === "cooling" || m.lead.action === "heating";
    const label = off
      ? "Off"
      : !m.synced
        ? "Out of sync"
        : range
          ? end === "low"
            ? active && m.lead.action === "heating" ? "Heating to" : "Heat to"
            : active && m.lead.action === "cooling" ? "Cooling to" : "Cool to"
          : mode === "cool"
            ? active ? "Cooling to" : "Cool to"
            : mode === "heat"
              ? active ? "Heating to" : "Heat to"
              : modeLabel(mode);
    const labelTone = !m.synced ? TONES.hold : range ? (end === "low" ? TONES.heat : TONES.cool) : mt;
    const subtitle =
      cfg.subtitle ??
      (cfg.occupied ? `Guest room · ${m.occupied ? "guests staying" : "no guests"}` : m.thermostats.length > 1 ? `${m.thermostats.length} thermostats` : "");
    const canStep = !off && (range ? sp.low !== undefined && sp.high !== undefined : sp.temperature !== undefined);
    const atMin = range ? (end === "low" ? sp.low! <= m.lead.min : sp.high! <= (sp.low ?? 0) + m.lead.step) : sp.temperature! <= m.lead.min;
    const atMax = range ? (end === "low" ? sp.low! >= (sp.high ?? 0) - m.lead.step : sp.high! >= m.lead.max) : sp.temperature! >= m.lead.max;
    const indoor = [
      m.current !== undefined ? `Indoor ${fmtTemp(m.current)}°` : undefined,
      m.thermostats.length === 1 && m.lead.humidity !== undefined ? `${fmtTemp(m.lead.humidity)}% RH` : undefined,
    ]
      .filter(Boolean)
      .join(" · ");

    return html`
      <div class="card full ${m.status.kind === "hold" ? "hold" : ""}">
        <header class="head">
          <div class="titles">
            <div class="name">
              ${cfg.name}${m.thermostats.length > 1 ? html` <span class="link" title="Linked zone">${icon("link", 18)}</span>` : nothing}
            </div>
            ${subtitle ? html`<div class="subtitle">${subtitle}</div>` : nothing}
          </div>
          <div class="mode-wrap">
            <button
              class="mode-pill toned"
              style=${toneVars(mt)}
              aria-haspopup="menu"
              aria-expanded=${this._menuOpen ? "true" : "false"}
              aria-label="HVAC mode: ${modeLabel(mode)}. Change mode"
              ?disabled=${!m.lead.available}
              @click=${() => (this._menuOpen = !this._menuOpen)}
            >
              ${icon(modeIcon(mode), 18)}<span>${modeLabel(mode)}</span>${icon("menu", 18)}
            </button>
            ${this._menuOpen
              ? html`<div class="menu" role="menu" @keydown=${(e: KeyboardEvent) => e.key === "Escape" && (this._menuOpen = false)}>
                  ${m.lead.modes.map(
                    (md) => html`<button role="menuitemradio" aria-checked=${md === mode ? "true" : "false"} @click=${() => this._setMode(m, md)}>
                      ${icon(modeIcon(md), 18)}<span>${modeLabel(md)}</span>${md === mode ? icon("check", 18) : nothing}
                    </button>`,
                  )}
                </div>`
              : nothing}
          </div>
        </header>

        <div class="dial ${off ? "off" : ""}">
          ${dialSvg({
            min: cfg.dialMin,
            max: cfg.dialMax,
            current: m.current,
            setpoint: range ? undefined : sp.temperature,
            low: range ? sp.low : undefined,
            high: range ? sp.high : undefined,
            off,
            color: mt.fill,
            heatColor: TONES.heat.fill,
            coolColor: TONES.cool.fill,
          })}
          <div class="dial-center">
            <div class="dial-label toned" style=${toneVars(off ? TONES.off : labelTone)}>${label}</div>
            ${off
              ? html`<div class="dial-num off-num">—</div>`
              : range
                ? html`<div class="dial-range">
                    <button class="end ${end === "low" ? "sel" : ""}" aria-pressed=${end === "low"} aria-label="Adjust heat setpoint, ${fmtTemp(sp.low)}°"
                      @click=${() => (this._end = "low")}>${fmtTemp(sp.low)}</button><span class="dash">–</span><button
                      class="end ${end === "high" ? "sel" : ""}" aria-pressed=${end === "high"} aria-label="Adjust cool setpoint, ${fmtTemp(sp.high)}°"
                      @click=${() => (this._end = "high")}>${fmtTemp(sp.high)}</button>
                  </div>`
                : html`<div class="dial-num" aria-live="polite">${fmtTemp(sp.temperature)}<span class="deg">°</span></div>`}
            ${indoor ? html`<div class="indoor">${indoor}</div>` : nothing}
          </div>
        </div>

        <div class="steppers">
          <button class="round" aria-label="Lower setpoint" ?disabled=${!canStep || atMin} @click=${() => this._step(m, -1)}>
            ${icon("minus", 24)}
          </button>
          <button class="round" aria-label="Raise setpoint" ?disabled=${!canStep || atMax} @click=${() => this._step(m, 1)}>
            ${icon("plus", 24)}
          </button>
        </div>

        ${m.thermostats.length > 1
          ? html`<div class="tstats">
              ${m.thermostats.map(
                (t) => html`<div class="tstat">
                  <div class="t-name">${t.name}</div>
                  <div class="t-temp">${fmtTemp(t.current)}°</div>
                  <div class="t-act">${t.action ? t.action[0].toUpperCase() + t.action.slice(1) : modeLabel(t.mode)}${
                    t.temperature !== undefined ? html` · ${fmtTemp(t.temperature)}°` : nothing
                  }</div>
                </div>`,
              )}
            </div>`
          : nothing}

        <div class="status toned" style=${toneVars(m.tone)} role="status">
          <div class="st-row">
            <span class="disc">${icon(this._statusIcon(m), 18)}</span>
            <div class="st-text">
              <div class="st-title">${m.status.title}</div>
              ${m.status.detail ? html`<div class="st-detail">${m.status.detail}</div>` : nothing}
            </div>
          </div>
          ${m.status.kind === "hold"
            ? html`<button class="dark-btn resume" @click=${() => this._resume(m)}>Resume schedule</button>`
            : nothing}
        </div>

        <div class="daystrip">
          ${this._strip(m)}
          <div class="hours" aria-hidden="true">
            ${[0, 360, 720, 1080, 1440].map((h) => html`<span>${formatMinutes(h, this.hass, true)}</span>`)}
          </div>
          ${m.scheduleError ? html`<div class="note">${m.scheduleError}</div>` : nothing}
        </div>

        ${this._error ? html`<div class="note err" role="alert">${this._error}</div>` : nothing}

        <footer class="foot">
          ${cfg.occupied
            ? html`<label class="guests">
                <span>Guests staying</span>
                <button class="switch" role="switch" aria-checked=${m.occupied ? "true" : "false"} aria-label="Guests staying"
                  @click=${() => this._toggleGuests(m)}></button>
              </label>`
            : html`<span></span>`}
          <button class="dark-btn sched" @click=${this._openSchedule} ?disabled=${!m.schedule}>
            ${icon("calendar", 18)}<span>Schedule</span>${icon("chevron", 18)}
          </button>
        </footer>

        <climate-zone-schedule-dialog
          .hass=${this.hass}
          .cfg=${cfg}
          .scheduleId=${m.schedule?.entityId}
          ?dark=${this.dark}
        ></climate-zone-schedule-dialog>
      </div>
    `;
  }

  private _renderCompact(m: Model) {
    const cfg = m.cfg;
    const fullConfig = { ...this._config!, layout: "full" as const };
    return html`
      <div class="card compact ${m.status.kind === "hold" ? "hold" : ""}">
        <button class="row" aria-haspopup="dialog" aria-label="${cfg.name}: ${m.status.title}. Open room" @click=${this._openRoom}>
          <div class="c-main">
            <div class="c-name">${cfg.name}${m.thermostats.length > 1 ? html` <span class="link">${icon("link", 16)}</span>` : nothing}</div>
            <div class="c-status toned" style=${toneVars(m.tone)}>
              <span class="dot"></span><span class="c-st">${!m.synced ? "Out of sync" : m.status.title}</span>
            </div>
          </div>
          <div class="c-temp">
            <div class="c-cur">${fmtTemp(m.current)}°</div>
            <div class="c-target">${this._targetShort(m)}</div>
          </div>
          <span class="c-chev">${icon("chevron", 22)}</span>
        </button>
        <div class="c-strip">${this._strip(m, 6)}</div>
      </div>
      ${this._roomOpen
        ? html`<dialog class="room" aria-label=${cfg.name}
            @close=${() => (this._roomOpen = false)}
            @click=${(e: MouseEvent) => e.target === this._roomDialog && this._roomDialog?.close()}>
            <div class="room-inner">
              <button class="room-close" aria-label="Close" @click=${() => this._roomDialog?.close()}>${icon("close", 22)}</button>
              <climate-zone-card .hass=${this.hass} .config=${fullConfig}></climate-zone-card>
            </div>
          </dialog>`
        : nothing}
    `;
  }

  /** Used by the compact layout to configure the nested full card. */
  set config(c: CardConfig) {
    this.setConfig(c);
  }

  static styles = [
    baseStyles,
    css`
      .pad {
        padding: 16px;
      }
      .muted {
        color: var(--czc-text2);
      }
      .error-card p {
        margin: 8px 0;
        color: var(--czc-text2);
        font-size: 14px;
      }
      .error-card ul {
        margin: 0;
        padding-left: 20px;
        font-size: 13px;
        overflow-wrap: anywhere;
      }
      .err-head {
        display: flex;
        align-items: center;
        gap: 8px;
        color: var(--error-color, #b3261e);
      }
      .full {
        padding: 16px;
        position: relative;
      }
      .head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 12px;
      }
      .name {
        font-size: 19px;
        font-weight: 700;
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .link {
        color: var(--czc-text2);
        display: inline-flex;
      }
      .subtitle {
        font-size: 13px;
        color: var(--czc-text2);
        margin-top: 2px;
      }
      .mode-wrap {
        position: relative;
        flex: none;
      }
      .mode-pill {
        height: 44px;
        padding: 0 10px 0 12px;
        border-radius: 22px;
        display: inline-flex;
        align-items: center;
        gap: 6px;
        background: var(--t-tint);
        color: var(--t-ink);
        font-weight: 600;
        font-size: 14px;
      }
      .menu {
        position: absolute;
        right: 0;
        top: calc(100% + 6px);
        z-index: 5;
        min-width: 180px;
        background: var(--czc-bg);
        border: 1px solid var(--czc-divider);
        border-radius: 12px;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
        padding: 6px;
        display: grid;
      }
      .menu button {
        min-height: 44px;
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 0 10px;
        border-radius: 8px;
        text-align: left;
        font-size: 14px;
      }
      .menu button span {
        flex: 1;
      }
      .menu button:hover {
        background: color-mix(in srgb, var(--czc-text) 6%, var(--czc-bg));
      }
      .dial {
        position: relative;
        width: 220px;
        height: 220px;
        margin: 12px auto 0;
      }
      .dial.off {
        opacity: 0.6;
      }
      .dial-svg {
        display: block;
      }
      .dial-center {
        position: absolute;
        inset: 0;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        pointer-events: none;
      }
      .dial-center button {
        pointer-events: auto;
      }
      .dial-label {
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--t-ink);
      }
      .dial-num {
        font-size: 68px;
        font-weight: 600;
        line-height: 1;
        margin: 4px 0 6px 18px;
        letter-spacing: -0.02em;
      }
      .dial-num .deg {
        font-size: 36px;
        vertical-align: top;
        margin-left: 2px;
      }
      .off-num {
        margin-left: 0;
        color: var(--czc-text2);
      }
      .dial-range {
        display: flex;
        align-items: center;
        margin: 4px 0 6px;
      }
      .dial-range .end {
        font-size: 44px;
        font-weight: 600;
        line-height: 1;
        min-width: 56px;
        min-height: 52px;
        border-radius: 10px;
        border-bottom: 3px solid transparent;
      }
      .dial-range .end.sel {
        border-bottom-color: currentColor;
      }
      .dial-range .end:first-child.sel {
        color: ${unsafeCSS(TONES.heat.fill)};
      }
      .dial-range .end:last-child.sel {
        color: ${unsafeCSS(TONES.cool.fill)};
      }
      .dash {
        font-size: 30px;
        color: var(--czc-text2);
        padding: 0 2px;
      }
      .indoor {
        font-size: 14px;
        color: var(--czc-text2);
      }
      .steppers {
        display: flex;
        justify-content: center;
        gap: 72px;
        margin-top: -28px;
        position: relative;
      }
      .tstats {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
        gap: 8px;
        margin-top: 14px;
      }
      .tstat {
        border: 1px solid var(--czc-divider);
        border-radius: 10px;
        padding: 8px 10px;
      }
      .t-name {
        font-size: 13px;
        color: var(--czc-text2);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .t-temp {
        font-size: 22px;
        font-weight: 600;
      }
      .t-act {
        font-size: 12px;
        color: var(--czc-text2);
      }
      .status {
        margin-top: 16px;
        background: var(--t-tint);
        color: var(--t-ink);
        border-radius: 14px;
        padding: 10px 12px;
      }
      .st-row {
        display: flex;
        align-items: center;
        gap: 10px;
      }
      .disc {
        width: 30px;
        height: 30px;
        border-radius: 50%;
        background: var(--t-fill);
        color: #fff;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex: none;
      }
      .st-title {
        font-size: 15px;
        font-weight: 700;
      }
      .st-detail {
        font-size: 13px;
        margin-top: 1px;
      }
      .resume {
        width: 100%;
        margin-top: 10px;
      }
      .daystrip {
        margin-top: 16px;
      }
      .hours {
        display: flex;
        justify-content: space-between;
        font-size: 11px;
        color: var(--czc-text2);
        margin-top: 6px;
      }
      .hours span:first-child {
        transform: translateX(-2px);
      }
      .note {
        font-size: 12px;
        color: var(--czc-text2);
        margin-top: 8px;
      }
      .note.err {
        color: var(--error-color, #b3261e);
      }
      .foot {
        margin-top: 16px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        flex-wrap: wrap;
      }
      .guests {
        display: flex;
        align-items: center;
        gap: 12px;
        font-size: 15px;
        min-height: 44px;
      }
      .sched .icon:last-child {
        margin-right: -6px;
      }

      /* compact */
      .compact {
        overflow: hidden;
      }
      .row {
        width: 100%;
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 12px 8px 10px 16px;
        text-align: left;
        min-height: 64px;
      }
      .c-main {
        flex: 1;
        min-width: 0;
      }
      .c-name {
        font-size: 16px;
        font-weight: 700;
        display: flex;
        align-items: center;
        gap: 4px;
      }
      .c-status {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 13px;
        color: var(--czc-text2);
        margin-top: 2px;
        min-width: 0;
      }
      .c-st {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--t-fill);
        flex: none;
      }
      .c-temp {
        text-align: right;
        flex: none;
      }
      .c-cur {
        font-size: 28px;
        font-weight: 600;
        line-height: 1.05;
      }
      .c-target {
        font-size: 12px;
        color: var(--czc-text2);
        white-space: nowrap;
      }
      .c-chev {
        color: var(--czc-text2);
        flex: none;
      }
      .c-strip {
        padding: 0 16px 12px;
      }
      dialog.room {
        width: min(420px, calc(100vw - 16px));
      }
      .room-inner {
        display: flex;
        flex-direction: column;
        max-height: calc(100dvh - 32px);
        overflow-y: auto;
        overscroll-behavior: contain;
      }
      .room-close {
        align-self: flex-end;
        width: 44px;
        height: 44px;
        border-radius: 50%;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        color: #fff;
        flex: none;
      }
    `,
  ];
}

if (!customElements.get("climate-zone-card")) {
  customElements.define("climate-zone-card", ClimateZoneCard);
}

declare global {
  interface Window {
    customCards?: { type: string; name: string; description: string; preview?: boolean }[];
  }
}

window.customCards = window.customCards || [];
if (!window.customCards.some((c) => c.type === "climate-zone-card")) {
  window.customCards.push({
    type: "climate-zone-card",
    name: "Climate Zone Card",
    description: "Dial, status and schedule for a Scheduler-driven climate zone",
    preview: false,
  });
}

console.info(`%c CLIMATE-ZONE-CARD %c ${VERSION} `, "background:#1F6FD1;color:#fff;font-weight:700", "");
