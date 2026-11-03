import { describe, expect, it } from "vitest";
import { computeStatus, type ZoneSnapshot } from "../src/status";

const fmt = () => "8:00 PM";
const base: ZoneSnapshot = {
  mode: "cool",
  setpoint: { temperature: 76 },
  override: false,
  vacation: false,
  guestRoom: true,
  occupied: true,
  period: "Home",
  nextPeriod: "Sleep",
  nextTrigger: new Date("2026-11-03T20:00:00-07:00"),
  vacationCool: 82,
  vacationHeat: 60,
  nextSetpoints: { cool: 74, heat: 64 },
};

describe("computeStatus priority", () => {
  it("hold beats everything", () => {
    const s = computeStatus({ ...base, override: true, vacation: true, occupied: false, setpoint: { temperature: 78 } }, fmt);
    expect(s).toMatchObject({ kind: "hold", title: "Held at 78°", detail: "Resumes 8:00 PM with Sleep" });
  });
  it("vacation beats no guests", () => {
    const s = computeStatus({ ...base, vacation: true, occupied: false }, fmt);
    expect(s).toMatchObject({ kind: "vacation", title: "Vacation mode is on", detail: "Every room holds 82° / 60°", setback: true });
  });
  it("no guests in a guest room", () => {
    const s = computeStatus({ ...base, occupied: false }, fmt);
    expect(s).toMatchObject({ kind: "vacant", title: "No guests staying", detail: "Holds 82° cool / 60° heat", setback: true });
  });
  it("non-guest rooms ignore occupancy", () => {
    expect(computeStatus({ ...base, guestRoom: false, occupied: false }, fmt).kind).toBe("period");
  });
  it("period line in cool / heat / heat_cool / off", () => {
    expect(computeStatus(base, fmt)).toMatchObject({
      kind: "period",
      title: "Home · until 8:00 PM",
      detail: "Next: Sleep, cool to 74°",
    });
    expect(computeStatus({ ...base, mode: "heat" }, fmt).detail).toBe("Next: Sleep, heat to 64°");
    expect(computeStatus({ ...base, mode: "heat_cool" }, fmt).detail).toBe("Next: Sleep, heat to 64° / cool to 74°");
    expect(computeStatus({ ...base, mode: "off" }, fmt).detail).toBe("Next: Sleep, 74° cool / 64° heat");
  });
  it("hold in heat_cool shows the range", () => {
    const s = computeStatus({ ...base, mode: "heat_cool", override: true, setpoint: { low: 66, high: 77 } }, fmt);
    expect(s.title).toBe("Held at 66–77°");
  });
});
