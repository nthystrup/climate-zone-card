import { css } from "lit";

export const baseStyles = css`
  :host {
    --czc-bg: var(--ha-card-background, var(--card-background-color, #fff));
    --czc-text: var(--primary-text-color, #1c1c1c);
    --czc-text2: var(--secondary-text-color, #646a73);
    --czc-divider: var(--divider-color, rgba(0, 0, 0, 0.12));
    --czc-radius: var(--ha-card-border-radius, 12px);
    --czc-track: color-mix(in srgb, var(--czc-text) 10%, var(--czc-bg));
    --czc-hold-border: #f1d29b;
    --czc-knob: #fff;
    display: block;
    font-family: inherit;
    font-variant-numeric: tabular-nums;
    color: var(--czc-text);
  }
  :host([dark]) {
    --czc-track: color-mix(in srgb, var(--czc-text) 16%, var(--czc-bg));
    --czc-hold-border: color-mix(in srgb, #8a5300 70%, var(--czc-bg));
  }
  .toned {
    --t-ink: var(--t-ink-l);
    --t-tint: var(--t-tint-l);
  }
  :host([dark]) .toned {
    --t-ink: color-mix(in srgb, var(--t-fill) 45%, var(--czc-text));
    --t-tint: color-mix(in srgb, var(--t-fill) 22%, var(--czc-bg));
  }
  * {
    box-sizing: border-box;
  }
  button {
    font: inherit;
    color: inherit;
    background: none;
    border: 0;
    padding: 0;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }
  button:disabled {
    cursor: default;
    opacity: 0.4;
  }
  button:focus-visible,
  [tabindex]:focus-visible {
    outline: 2px solid var(--primary-color, #1f6fd1);
    outline-offset: 2px;
  }
  .icon {
    flex: none;
    display: block;
  }
  .card {
    background: var(--czc-bg);
    border-radius: var(--czc-radius);
    border: var(--ha-card-border-width, 1px) solid var(--ha-card-border-color, var(--czc-divider));
    box-shadow: var(--ha-card-box-shadow, none);
    overflow: visible;
  }
  .card.hold {
    border-color: var(--czc-hold-border);
  }
  .round {
    width: 48px;
    height: 48px;
    border-radius: 50%;
    border: 1.5px solid var(--czc-divider);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: var(--czc-bg);
  }
  .round:not(:disabled):hover {
    background: color-mix(in srgb, var(--czc-text) 5%, var(--czc-bg));
  }
  .dark-btn {
    min-height: 44px;
    padding: 0 16px;
    border-radius: 12px;
    background: var(--czc-text);
    color: var(--czc-bg);
    font-weight: 600;
    font-size: 14px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
  }
  .ghost-btn {
    min-height: 44px;
    padding: 0 16px;
    border-radius: 12px;
    border: 1px solid var(--czc-divider);
    font-weight: 600;
    font-size: 14px;
  }
  .strip {
    position: relative;
    height: 12px;
    border-radius: 6px;
  }
  .strip .seg {
    position: absolute;
    top: 0;
    bottom: 0;
    border-radius: 3px;
    background: var(--seg);
  }
  .strip .hatch {
    position: absolute;
    inset: 0;
    border-radius: 6px;
    background: repeating-linear-gradient(
      135deg,
      color-mix(in srgb, var(--t-fill) 55%, var(--czc-bg)) 0 4px,
      color-mix(in srgb, var(--t-fill) 18%, var(--czc-bg)) 4px 8px
    );
  }
  .strip .now {
    position: absolute;
    top: -3px;
    bottom: -3px;
    width: 3px;
    margin-left: -1.5px;
    border-radius: 2px;
    background: var(--czc-text);
    box-shadow: 0 0 0 2px var(--czc-bg);
  }
  .switch {
    position: relative;
    width: 52px;
    height: 32px;
    border-radius: 16px;
    background: var(--czc-track);
    transition: background 0.15s;
    flex: none;
  }
  .switch::after {
    content: "";
    position: absolute;
    top: 4px;
    left: 4px;
    width: 24px;
    height: 24px;
    border-radius: 50%;
    background: #fff;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
    transition: transform 0.15s;
  }
  .switch[aria-checked="true"] {
    background: var(--primary-color, #1f6fd1);
  }
  .switch[aria-checked="true"]::after {
    transform: translateX(20px);
  }
  dialog {
    border: 0;
    padding: 0;
    background: transparent;
    color: var(--czc-text);
    max-width: calc(100vw - 16px);
    max-height: calc(100dvh - 32px);
    overflow: visible;
  }
  dialog::backdrop {
    background: rgba(0, 0, 0, 0.45);
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }
`;
