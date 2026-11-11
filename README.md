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

Add the card from the dashboard's card picker (**Climate Zone Card**) and use the visual editor: pick the zone, name, layout (full card or compact row), thermostats, dial range and period colours; entity overrides are under *Entity overrides*. The editor saves only what differs from the defaults, so a typical card is just `zone:`.

### Layouts

- `full` (default): dial, −/+, status line, day strip, guests toggle and the Schedule button.
- `compact`: one row per room for phone dashboards: name, status, − / current temperature and target / +, and a thin day strip. −/+ work like the full card's (one `climate.set_temperature` 1.5 s after the last tap; in Heat/Cool they move the end that matches `hvac_action`). While the zone is on hold the row shows a **Resume** button (same as the full card's Resume schedule). Tap anywhere else on the row to open the full card in a dialog, including the schedule editor.
- **Guests staying is optional.** The toggle and the "No guests staying" state only exist when `input_boolean.<zone>_occupied` exists (or `occupied:` is set); otherwise the room is always treated as occupied.

### YAML

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
hold_until: input_datetime.east_bedroom_hold_until  # optional minimum hold; used if it exists
occupied: input_boolean.east_bedroom_occupied   # default: used if input_boolean.<zone>_occupied exists
schedule: switch.schedule_east_bedroom          # optional; every Scheduler switch whose entities include the period helper is used
vacation: input_boolean.vacation_mode
vacation_cool: input_number.vacation_cool_setpoint
vacation_heat: input_number.vacation_heat_setpoint
dial_min: 60
dial_max: 85
show_runtime: true           # runtime stats on the full card
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
| Minimum hold (optional) | `input_datetime.<zone>_hold_until` | — |
| Guests staying | `input_boolean.<zone>_occupied` (guest rooms only) | `input_boolean.toggle` |
| Schedule | Scheduler `switch.schedule_*` whose `entities` include the period helper (one or more) | `scheduler.edit` / `add` / `remove` (schedule dialog Save) |
| Vacation | `input_boolean.vacation_mode`, `input_number.vacation_cool_setpoint` / `_heat_setpoint` | — |

If any required entity is missing the card shows an error listing the missing ids instead of rendering.

## Behaviour

- **What the equipment is doing** (from each thermostat's `hvac_action`): the full card shows *Cooling*, *Heating*, *Fan running*, *Idle* or *Off* under the indoor reading, with an animated icon while running; the compact row shows the icon before the temperature. In a linked zone, if only some thermostats run, it names them ("Cooling · Kitchen").
- **Status line**, first match wins: manual hold → vacation → guest room with no guests → current period.
- **−/+** change the setpoint by `target_temp_step` (1° if absent), clamped to `min_temp`/`max_temp`. The number updates at once; one `climate.set_temperature` goes out 1.5 s after the last tap. In Heat/Cool, tap the low or high number to choose which end −/+ move.
- A dial change is a manual hold by design: the controller turns the override on, not the card.
- **Minimum hold** (optional): if `input_datetime.<zone>_hold_until` exists, the controller sets it to now + the minimum hold (60 min for East Bedroom) on every manual change, and a period change during that window waits until it passes. The card shows the real resume time ("Resumes 8:55 PM with Sleep"). Zones without the helper keep the old behaviour: the hold ends when the next period starts.
- **Linked zones** show the mean indoor temperature and the first thermostat's setpoint; −/+ and the mode menu target all thermostats. If their setpoints or modes differ the dial reads "Out of sync".
- **Schedule dialog**: period setpoint steppers write immediately (debounced 1 s). Drag the handles on the day bar (or focus one and use the arrow keys) to move period boundaries in 15-minute steps, minimum 30 minutes per block. Save writes the times and waits for Scheduler to report them before closing; a failed save keeps your edits.
- **Editing blocks**: tap a block on the day bar to change its period, split it in two (adds a change halfway through, on the 15-minute grid), or remove it (the block before it takes over its time). A day that is one period all day starts as a single block; split it to add a change.
- **Different times on different days**: pick *Every day*, *Weekdays + weekend* or *Each day*, choose a day group, and edit its bar. *Copy … to* copies the selected day's times to other days. A Scheduler entity holds one set of times for a list of days, so the card keeps one entity per distinct set of times: it reuses existing ones first, creates `switch.schedule_<zone>_2`, `_3`, … with `scheduler.add` when needed, and removes leftovers with `scheduler.remove`. The dialog says which entities a save will add or remove before you press Save. Existing `workday`/`weekend` schedules are read as Mon–Fri / Sat–Sun.
- Periods change only when a slot starts, so the early hours of a day follow the previous day's last slot; the day strip and week preview show it that way.
- **Runtime** (full card, `show_runtime: false` to hide): cooling and heating time today with the number of cycles, a bar per day for the last 7 days, and the 7-day total and daily average. It is computed from the thermostats' `hvac_action` history in the recorder (fetched once per page load over Home Assistant's history websocket, topped up every 15 minutes, and extended live), so it needs no extra entities. Linked zones add their thermostats together. Fan-only time after a cycle is not counted.
- Times are shown in the Home Assistant server's time zone, because that is the clock Scheduler runs on.

## Development

```bash
npm ci
npm test          # unit tests for the pure logic
npm run typecheck
npm run build     # dist/climate-zone-card.js
```

`dev/preview.html` renders the card in every state against mock entities and `dev/editor.html` the visual editor next to a live card; serve the repo root (`python3 -m http.server`) and open `/dev/preview.html` (add `?dark`, `?layout=compact`, or `?failsave` to simulate a failed save).

Scheduler-specific parsing and the `scheduler.edit` payload live in `src/scheduler.ts` only.

## Releasing

1. Bump `version` in `package.json` and `VERSION` in `src/climate-zone-card.ts`.
2. Commit, then either push a tag (`git tag v0.1.1 && git push origin v0.1.1`) or publish a release with a new `v*` tag in the GitHub UI. The Release workflow tests and builds the card, creates the GitHub release and attaches `climate-zone-card.js`, which HACS installs.
