import { LitElement, html, css, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import type { CardConfig, HomeAssistant } from "./types";
import {
  DEFAULT_PERIOD_COLORS,
  cleanConfig,
  discoverZones,
  resolveConfig,
  titleCase,
  zoneEntities,
} from "./config";

// Visual editor built from plain form controls: HA's own ha-* form elements
// change between releases, so the card does not depend on them.

type OverrideKey = "period" | "override" | "occupied" | "schedule" | "vacation" | "vacation_cool" | "vacation_heat";

const OVERRIDES: { key: OverrideKey; label: string; domain: string }[] = [
  { key: "period", label: "Period helper", domain: "input_select" },
  { key: "override", label: "Manual hold helper", domain: "input_boolean" },
  { key: "occupied", label: "Guests staying helper", domain: "input_boolean" },
  { key: "schedule", label: "Scheduler switch (extra)", domain: "switch" },
  { key: "vacation", label: "Vacation mode", domain: "input_boolean" },
  { key: "vacation_cool", label: "Vacation cool setpoint", domain: "input_number" },
  { key: "vacation_heat", label: "Vacation heat setpoint", domain: "input_number" },
];

const SLUG = /^[a-z0-9_]+$/;

export class ClimateZoneCardEditor extends LitElement {
  @property({ attribute: false }) hass?: HomeAssistant;
  @state() private _config?: CardConfig;
  @state() private _zoneDraft = "";

  setConfig(config: CardConfig) {
    this._config = { ...config };
    this._zoneDraft = config.zone ?? "";
  }

  private _emit(next: CardConfig) {
    this._config = next;
    if (!next.zone || !SLUG.test(next.zone)) return; // keep the last valid config in HA
    this.dispatchEvent(
      new CustomEvent("config-changed", {
        detail: { config: cleanConfig(next, this.hass) },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private _set<K extends keyof CardConfig>(key: K, value: CardConfig[K] | undefined) {
    if (!this._config) return;
    const next = { ...this._config } as CardConfig;
    if (value === undefined || value === "" || (Array.isArray(value) && !value.length)) delete next[key];
    else next[key] = value;
    this._emit(next);
  }

  private _setZone(zone: string) {
    this._zoneDraft = zone.trim();
    if (!this._config || !SLUG.test(this._zoneDraft)) {
      this.requestUpdate();
      return;
    }
    // A new zone changes every derived id; drop thermostats that were derived from the old one.
    const next: CardConfig = { ...this._config, zone: this._zoneDraft };
    const oldDefault = `climate.${this._config.zone}_thermostat`;
    const climate = this._climateList();
    if (climate.length === 1 && climate[0] === oldDefault) delete next.climate;
    this._emit(next);
  }

  private _climateList(): string[] {
    const c = this._config?.climate;
    if (!c) return this._config ? [`climate.${this._config.zone}_thermostat`] : [];
    return Array.isArray(c) ? c : [c];
  }

  private _toggleClimate(id: string, on: boolean) {
    const list = this._climateList().filter((x) => x !== id);
    if (on) list.push(id);
    this._set("climate", list.length ? list : undefined);
  }

  private _num(key: "dial_min" | "dial_max", raw: string) {
    const n = Number(raw);
    this._set(key, raw === "" || isNaN(n) ? undefined : n);
  }

  private _setColor(period: string, color: string | undefined) {
    const colors = { ...(this._config?.period_colors ?? {}) };
    if (color) colors[period] = color.toUpperCase();
    else delete colors[period];
    this._set("period_colors", Object.keys(colors).length ? colors : undefined);
  }

  private _ids(domain: string): string[] {
    return Object.keys(this.hass?.states ?? {})
      .filter((id) => id.startsWith(`${domain}.`))
      .sort();
  }

  private _friendly(id: string): string {
    return this.hass?.states[id]?.attributes?.friendly_name ?? id;
  }

  protected render() {
    if (!this._config) return nothing;
    const hass = this.hass;
    const cfg = this._config;
    const zones = hass ? discoverZones(hass.states) : [];
    const zoneValid = SLUG.test(this._zoneDraft);
    const resolved = resolveConfig(cfg, hass);
    const ents = hass && zoneValid ? zoneEntities(resolved, hass) : undefined;
    const climateIds = this._ids("climate");
    const chosen = this._climateList();
    const options: string[] = hass?.states[resolved.period]?.attributes?.options ?? [];
    const layout = cfg.layout ?? "full";

    return html`
      <div class="form">
        <label class="field">
          <span class="label">Zone</span>
          <input
            list="czc-zones"
            .value=${this._zoneDraft}
            placeholder="east_bedroom"
            autocapitalize="off"
            spellcheck="false"
            @change=${(e: Event) => this._setZone((e.target as HTMLInputElement).value)}
          />
          <datalist id="czc-zones">${zones.map((z) => html`<option value=${z}>${titleCase(z)}</option>`)}</datalist>
          <span class="help ${zoneValid ? "" : "bad"}">
            ${zoneValid
              ? html`Builds every helper id from this slug, e.g. <code>input_select.${this._zoneDraft}_period</code>.`
              : "Use lower-case letters, digits and underscores, like east_bedroom."}
          </span>
        </label>

        ${ents?.missing.length
          ? html`<div class="notice">
              Missing for this zone:
              <ul>${ents.missing.map((m) => html`<li><code>${m}</code></li>`)}</ul>
            </div>`
          : ents
            ? html`<div class="ok">Found all helpers${ents.schedules.length ? html` and ${ents.schedules.length} schedule${ents.schedules.length === 1 ? "" : "s"}` : nothing}.</div>`
            : nothing}

        <div class="row2">
          <label class="field">
            <span class="label">Name</span>
            <input .value=${cfg.name ?? ""} placeholder=${titleCase(cfg.zone ?? "")}
              @change=${(e: Event) => this._set("name", (e.target as HTMLInputElement).value.trim())} />
          </label>
          <label class="field">
            <span class="label">Subtitle</span>
            <input .value=${cfg.subtitle ?? ""} placeholder=${resolved.occupied ? "Guest room · …" : "optional"}
              @change=${(e: Event) => this._set("subtitle", (e.target as HTMLInputElement).value.trim())} />
          </label>
        </div>

        <fieldset class="field">
          <legend class="label">Layout</legend>
          <div class="seg" role="radiogroup">
            ${(["full", "compact"] as const).map(
              (l) => html`<label class="seg-opt ${layout === l ? "on" : ""}">
                <input type="radio" name="czc-layout" .checked=${layout === l}
                  @change=${() => this._set("layout", l === "full" ? undefined : l)} />
                <span>${l === "full" ? "Full card" : "Compact row"}</span>
              </label>`,
            )}
          </div>
          <span class="help">${layout === "full"
            ? "Dial, status, day strip and schedule button."
            : "One row per room for phone dashboards; tap it to open the full card."}</span>
        </fieldset>

        <fieldset class="field">
          <legend class="label">Thermostats</legend>
          <div class="checks">
            ${climateIds.length
              ? climateIds.map(
                  (id) => html`<label class="check">
                    <input type="checkbox" .checked=${chosen.includes(id)}
                      @change=${(e: Event) => this._toggleClimate(id, (e.target as HTMLInputElement).checked)} />
                    <span>${this._friendly(id)} <code>${id}</code></span>
                  </label>`,
                )
              : html`<span class="help">No climate entities found.</span>`}
          </div>
          <span class="help">Pick two or more for a linked zone; −/+ and the mode menu then act on all of them.</span>
        </fieldset>

        <fieldset class="field">
          <legend class="label">Dial range (°)</legend>
          <div class="row2">
            <label class="field"><span class="sub">Min</span>
              <input type="number" inputmode="numeric" .value=${cfg.dial_min !== undefined ? String(cfg.dial_min) : ""} placeholder="60"
                @change=${(e: Event) => this._num("dial_min", (e.target as HTMLInputElement).value)} /></label>
            <label class="field"><span class="sub">Max</span>
              <input type="number" inputmode="numeric" .value=${cfg.dial_max !== undefined ? String(cfg.dial_max) : ""} placeholder="85"
                @change=${(e: Event) => this._num("dial_max", (e.target as HTMLInputElement).value)} /></label>
          </div>
        </fieldset>

        <label class="check toggle">
          <input type="checkbox" .checked=${cfg.show_runtime !== false}
            @change=${(e: Event) => this._set("show_runtime", (e.target as HTMLInputElement).checked ? undefined : false)} />
          <span>Show runtime stats <span class="help">(full card: cooling/heating time today and for the last 7 days)</span></span>
        </label>

        ${options.length
          ? html`<fieldset class="field">
              <legend class="label">Period colours</legend>
              <div class="colors">
                ${options.map((p, i) => {
                  const dflt = DEFAULT_PERIOD_COLORS[i % DEFAULT_PERIOD_COLORS.length];
                  const set = cfg.period_colors?.[p];
                  const value = set && /^#[0-9a-f]{6}$/i.test(set) ? set : dflt;
                  return html`<label class="color">
                    <input type="color" .value=${value.toLowerCase()} aria-label="${p} colour"
                      @change=${(e: Event) => this._setColor(p, (e.target as HTMLInputElement).value)} />
                    <span>${p}</span>
                    ${set ? html`<button type="button" class="link" @click=${() => this._setColor(p, undefined)}>Reset</button>` : nothing}
                  </label>`;
                })}
              </div>
            </fieldset>`
          : nothing}

        <details class="field">
          <summary class="label">Entity overrides</summary>
          <p class="help">Leave blank to use the id built from the zone (shown greyed out).</p>
          ${OVERRIDES.map(({ key, label, domain }) => {
            const placeholder =
              key === "schedule"
                ? "found automatically"
                : key === "occupied"
                  ? resolved.occupied ?? `input_boolean.${cfg.zone}_occupied (not a guest room)`
                  : key === "period"
                    ? resolved.period
                    : key === "override"
                      ? resolved.override
                      : key === "vacation"
                        ? resolved.vacation
                        : key === "vacation_cool"
                          ? resolved.vacationCool
                          : resolved.vacationHeat;
            return html`<label class="field">
              <span class="sub">${label}</span>
              <input list="czc-${domain}" .value=${(cfg[key] as string | undefined) ?? ""} placeholder=${placeholder}
                autocapitalize="off" spellcheck="false"
                @change=${(e: Event) => this._set(key, (e.target as HTMLInputElement).value.trim())} />
            </label>`;
          })}
          ${["input_select", "input_boolean", "input_number", "switch"].map(
            (d) => html`<datalist id="czc-${d}">${this._ids(d).map((id) => html`<option value=${id}></option>`)}</datalist>`,
          )}
        </details>
      </div>
    `;
  }

  static styles = css`
    :host {
      display: block;
      color: var(--primary-text-color);
      font-family: inherit;
    }
    .form {
      display: grid;
      gap: 16px;
    }
    .field {
      display: grid;
      gap: 6px;
      min-width: 0;
    }
    fieldset {
      border: 0;
      padding: 0;
      margin: 0;
    }
    .label {
      font-weight: 600;
      font-size: 14px;
      padding: 0;
    }
    .sub {
      font-size: 13px;
      color: var(--secondary-text-color);
    }
    .help {
      font-size: 12px;
      color: var(--secondary-text-color);
    }
    .help.bad {
      color: var(--error-color, #b3261e);
    }
    input[type="text"],
    input:not([type]),
    input[type="number"] {
      font: inherit;
      color: inherit;
      background: var(--card-background-color, var(--ha-card-background, #fff));
      border: 1px solid var(--divider-color, rgba(0, 0, 0, 0.2));
      border-radius: 8px;
      padding: 0 12px;
      min-height: 44px;
      width: 100%;
      box-sizing: border-box;
    }
    input::placeholder {
      color: var(--secondary-text-color);
      opacity: 0.7;
    }
    input:focus-visible,
    summary:focus-visible,
    button:focus-visible {
      outline: 2px solid var(--primary-color, #1f6fd1);
      outline-offset: 1px;
    }
    .row2 {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
    }
    @media (max-width: 420px) {
      .row2 {
        grid-template-columns: 1fr;
      }
    }
    .seg {
      display: flex;
      border: 1px solid var(--divider-color, rgba(0, 0, 0, 0.2));
      border-radius: 10px;
      padding: 3px;
      gap: 3px;
    }
    .seg-opt {
      flex: 1;
      position: relative;
      min-height: 38px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
    }
    .seg-opt input {
      position: absolute;
      opacity: 0;
      inset: 0;
      margin: 0;
      cursor: pointer;
    }
    .seg-opt.on {
      background: var(--primary-text-color);
      color: var(--card-background-color, #fff);
    }
    .seg-opt:has(input:focus-visible) {
      outline: 2px solid var(--primary-color, #1f6fd1);
    }
    .checks {
      display: grid;
      gap: 2px;
      max-height: 220px;
      overflow-y: auto;
      border: 1px solid var(--divider-color, rgba(0, 0, 0, 0.2));
      border-radius: 8px;
      padding: 4px;
    }
    .check {
      display: flex;
      align-items: center;
      gap: 10px;
      min-height: 40px;
      padding: 0 6px;
      font-size: 14px;
      cursor: pointer;
    }
    .toggle {
      padding: 0;
    }
    .check input {
      width: 20px;
      height: 20px;
      flex: none;
    }
    .check code,
    .help code,
    .notice code {
      font-size: 12px;
      color: var(--secondary-text-color);
      overflow-wrap: anywhere;
    }
    .colors {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
    }
    .color {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 14px;
    }
    .color input {
      width: 44px;
      height: 36px;
      padding: 0;
      border: 1px solid var(--divider-color, rgba(0, 0, 0, 0.2));
      border-radius: 8px;
      background: none;
      cursor: pointer;
    }
    .link {
      font: inherit;
      font-size: 12px;
      color: var(--primary-color, #1f6fd1);
      background: none;
      border: 0;
      padding: 4px;
      cursor: pointer;
    }
    summary {
      cursor: pointer;
      min-height: 32px;
      display: flex;
      align-items: center;
      gap: 6px;
      list-style: none;
    }
    summary::-webkit-details-marker {
      display: none;
    }
    summary::before {
      content: "";
      width: 0;
      height: 0;
      border-left: 6px solid currentColor;
      border-top: 5px solid transparent;
      border-bottom: 5px solid transparent;
      transition: transform 0.15s;
    }
    details[open] summary::before {
      transform: rotate(90deg);
    }
    details[open] summary {
      margin-bottom: 4px;
    }
    details .field {
      margin-top: 8px;
    }
    .notice,
    .ok {
      font-size: 13px;
      padding: 10px 12px;
      border-radius: 8px;
    }
    .notice {
      background: color-mix(in srgb, var(--warning-color, #ffa600) 16%, transparent);
    }
    .notice ul {
      margin: 6px 0 0;
      padding-left: 18px;
    }
    .ok {
      background: color-mix(in srgb, var(--success-color, #43a047) 14%, transparent);
    }
  `;
}

if (!customElements.get("climate-zone-card-editor")) {
  customElements.define("climate-zone-card-editor", ClimateZoneCardEditor);
}
