# Climate Zone Card

A Lovelace card for one schedule-driven climate zone: a dial with −/+, a status line that explains what the zone's controller automation is doing, a day strip, a hold banner with Resume, a guests toggle, and a schedule dialog for per-period setpoints and period boundaries.

The card is a front end only. It reads and writes the zone's existing helpers and its [Scheduler](https://github.com/nielsfaber/scheduler-component) switch; the controller automation does all thermostat writes except the dial's −/+ and the mode menu.

## Install

### HACS (custom repository)

1. HACS → ⋮ → **Custom repositories** → add this repository's URL, category **Dashboard**.
2. Install **Climate Zone Card**. HACS adds the resource `/hacsfiles/climate-zone-card/climate-zone-card.js`.
3. Reload the browser (and in the Companion app: Settings → Companion app → Debugging → Reset frontend cache).

### Manual (fast iteration)

```bash
npm ci
npm run build
```

Copy `dist/climate-zone-card.js` to `/config/www/climate-zone-card.js` and add a dashboard resource `/local/climate-zone-card.js?v=1` (type **JavaScript module**). Bump `v` on every copy.

## Configuration

A zone slug is enough; every derived entity can be overridden.

```yaml
type: custom:climate-zone-card
zone: east_bedroom            # required
name: East Bedroom            # default: title-cased zone
subtitle: Guest room          # optional
layout: full                  # full | compact
climate:                      # default: [climate.<zone>_thermostat]
  - climate.east_bedroom_thermostat
# overrides, all optional:
period: input_select.east_bedroom_period
override: input_boolean.east_bedroom_override
occupied: input_boolean.east_bedroom_occupied   # default: used if input_boolean.<zone>_occupied exists
schedule: switch.schedule_east_bedroom          # default: the Scheduler switch whose entities include the period helper
vacation: input_boolean.vacation_mode
vacation_cool: input_number.vacation_cool_setpoint
vacation_heat: input_number.vacation_heat_setpoint
dial_min: 60
dial_max: 85
period_colors:                # optional, by period name
  Home: "#F2B45A"
  Sleep: "#3E4C9C"
```

Linked zone (several thermostats act as one):

```yaml
type: custom:climate-zone-card
zone: great_room
name: Great Room
climate:
  - climate.living_room
  - climate.kitchen
```

### Entity contract

| Entity | Pattern | Card writes |
| --- | --- | --- |
| Thermostat(s) | `climate.<zone>_thermostat` | `climate.set_temperature` (−/+), `climate.set_hvac_mode` (mode menu) |
| Period | `input_select.<zone>_period` (options = periods in order) | — |
| Period setpoints | `input_number.<zone>_<period>_cool` / `_heat` | `input_number.set_value` (schedule dialog) |
| Manual hold | `input_boolean.<zone>_override` | `input_boolean.turn_off` (Resume) |
| Guests staying | `input_boolean.<zone>_occupied` (guest rooms only) | `input_boolean.toggle` |
| Schedule | Scheduler `switch.schedule_*` | `scheduler.edit` (schedule dialog Save) |
| Vacation | `input_boolean.vacation_mode`, `input_number.vacation_cool_setpoint` / `_heat_setpoint` | — |

If any required entity is missing the card shows an error listing the missing ids instead of rendering.

## Behaviour

- **Status line**, first match wins: manual hold → vacation → guest room with no guests → current period.
- **−/+** change the setpoint by `target_temp_step` (1° if absent), clamped to `min_temp`/`max_temp`. The number updates at once; one `climate.set_temperature` goes out 1.5 s after the last tap. In Heat/Cool, tap the low or high number to choose which end −/+ move.
- A dial change is a manual hold by design: the controller turns the override on, not the card.
- **Linked zones** show the mean indoor temperature and the first thermostat's setpoint; −/+ and the mode menu target all thermostats. If their setpoints or modes differ the dial reads "Out of sync".
- **Schedule dialog**: period setpoint steppers write immediately (debounced 1 s). Drag the handles on the day bar (or focus one and use the arrow keys) to move period boundaries in 15-minute steps, minimum 30 minutes per block; Save sends one `scheduler.edit` and waits for the Scheduler entity to update before closing. Only "Every day" schedules can be edited.
- Times are shown in the Home Assistant server's time zone, because that is the clock Scheduler runs on.

## Development

```bash
npm ci
npm test          # unit tests for the pure logic
npm run typecheck
npm run build     # dist/climate-zone-card.js
```

`dev/preview.html` renders the card in every state against mock entities; serve the repo root (`python3 -m http.server`) and open `/dev/preview.html` (add `?dark`, `?layout=compact`, or `?failsave` to simulate a failed save).

Scheduler-specific parsing and the `scheduler.edit` payload live in `src/scheduler.ts` only.

## Releasing

1. Bump `version` in `package.json` and `VERSION` in `src/climate-zone-card.ts`.
2. Create a GitHub release with a tag like `v0.1.0`. The Release workflow builds the card and attaches `climate-zone-card.js`, which HACS installs.
