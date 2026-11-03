import type { HassEntity } from "../src/types";

export const eastBedroomSchedule = (over: Record<string, unknown> = {}): HassEntity => ({
  entity_id: "switch.schedule_east_bedroom",
  state: "on",
  attributes: {
    weekdays: ["daily"],
    timeslots: ["07:00 - 20:00", "20:00 - 07:00"],
    entities: ["input_select.east_bedroom_period"],
    actions: [
      { service: "input_select.select_option", data: { option: "Home" } },
      { service: "input_select.select_option", data: { option: "Sleep" } },
    ],
    current_slot: 0,
    next_slot: 1,
    next_trigger: "2026-11-03T20:00:00-07:00",
    ...over,
  },
});
