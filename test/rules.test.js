const test = require("node:test");
const assert = require("node:assert/strict");
const {
  requestInput,
  overlaps,
  waitingOrder,
  quote,
  utc,
} = require("../src/services/rules");
const window = {
  start_time: "2030-01-01T10:00:00.000Z",
  end_time: "2030-01-01T11:00:00.000Z",
};
const request = {
  ...window,
  vehicle_plate: "أ ب 123",
  zone_id: "zone_1",
  spot_type: "standard",
  request_type: "daily",
};
test("valid UTC and Arabic plate", () =>
  assert.equal(requestInput(request, "2029").vehicle_plate, "أ ب 123"));
test("impossible dates and missing time zones", () => {
  for (const x of ["2030-02-30T10:00:00Z", "2030-01-01T10:00:00"])
    assert.throws(() => utc(x));
});
test("intervals may touch at their endpoints", () =>
  assert.equal(
    overlaps(window, { ...window, start_time: window.end_time }),
    false,
  ));
test("priority first, then submission order", () => {
  const a = { priority: 1, created_at: "a", request_id: "a" };
  assert.ok(waitingOrder({ ...a, priority: 2 }, a) < 0);
  assert.ok(waitingOrder(a, { ...a, created_at: "b" }) < 0);
});
test("high occupancy uses the configured tariff", () => {
  const rule = {
    daily_hour_piastres: 1000,
    surge_percent: 125,
    threshold: 0.8,
  };
  assert.equal(quote(request, ["A1"], [], rule).total_piastres, 1000);
  assert.equal(
    quote(
      request,
      ["A1"],
      [{ ...window, spot_id: "A1", status: "confirmed" }],
      rule,
    ).total_piastres,
    1250,
  );
});
test("server-controlled fields are rejected", () =>
  assert.throws(() => requestInput({ ...request, priority: 2 }, "2029")));
