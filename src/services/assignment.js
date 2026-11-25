const repo = require("../repositories/dynamodb/requestRepository");
const { spotsFor } = require("./inventory");
const { owned, booking } = require("./requestService");
const { overlaps, waitingOrder } = require("./rules");
const { invalid, conflict } = require("./errors");
async function adminAssign(id, spot, admin) {
  if (typeof spot !== "string" || !spot.length) invalid("Provide a spot_id.");
  return repo.change(async () => {
    const r = await owned("requests", id, admin);
    if (r.status !== "waitlisted" || r.end_time <= new Date().toISOString())
      conflict("Request is not waiting.");
    const spots = await spotsFor(r);
    if (!spots.includes(spot))
      conflict("Spot is unavailable or does not match the request.");
    const reservations = await repo.list("reservations");
    if (
      reservations.some(
        (s) => s.spot_id === spot && s.status === "confirmed" && overlaps(s, r),
      )
    )
      conflict("Spot is booked.");
    const waiting = await repo.list("waiting");
    if (
      waiting.some(
        (w) =>
          w.zone_id === r.zone_id &&
          w.spot_type === r.spot_type &&
          overlaps(w, r) &&
          w.end_time > new Date().toISOString() &&
          waitingOrder(w, r) < 0,
      )
    )
      conflict("Another request has priority.");
    return booking(
      r,
      spot,
      spots,
      reservations,
      await repo.get("rules", "tariff"),
    );
  });
}
module.exports = { adminAssign };
