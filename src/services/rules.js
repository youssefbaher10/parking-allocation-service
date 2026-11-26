
const { invalid } = require("./errors");

const fields = [
  "zone_id",
  "spot_type",
  "request_type",
  "vehicle_plate",
  "start_time",
  "end_time",
];

function only(body, allowed) {
  if (!body || typeof body !== "object" || Array.isArray(body))
    invalid("Send a JSON object.");

  for (const key of Object.keys(body)) {
    if (!allowed.includes(key))
      invalid("Unexpected field: " + key);
  }
}

function utc(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{3})?Z$/.test(value)
  ) {
    invalid("Use UTC time, for example 2027-01-15T09:00:00Z.");
  }

  const date = new Date(value);

  const canonical = value.includes(".")
    ? value
    : value.replace("Z", ".000Z");

  if (
    !Number.isFinite(date.getTime()) ||
    date.toISOString() !== canonical
  ) {
    invalid("Invalid calendar time.");
  }

  return canonical;
}

// Validate and normalize vehicle plates.
// Supports Arabic and English letters and numbers.
function normalizePlate(value) {
  if (
    typeof value !== "string" ||
    !/^[\p{L}\p{N} -]{1,20}$/u.test(value) ||
    !/[\p{L}\p{N}]/u.test(value)
  ) {
    invalid("Invalid vehicle_plate.");
  }

  return value.trim().toUpperCase();
}

function requestInput(body, now) {
  only(body, fields);

  if (
    typeof body.zone_id !== "string" ||
    !/^[\w-]{1,64}$/.test(body.zone_id)
  ) {
    invalid("Invalid zone_id.");
  }

  if (!["standard", "accessible"].includes(body.spot_type))
    invalid("Invalid spot_type.");

  if (!["daily", "permanent"].includes(body.request_type))
    invalid("Invalid request_type.");

  const plate = normalizePlate(body.vehicle_plate);

  const start = utc(body.start_time);
  const end = utc(body.end_time);

  if (start < now || end <= start)
    invalid("Choose a future start and a later end.");

  return {
    ...body,
    vehicle_plate: plate,
    start_time: start,
    end_time: end,
  };
}

// Check whether two reservation periods overlap.
function overlaps(a, b) {
  return (
    a.start_time < b.end_time &&
    b.start_time < a.end_time
  );
}

// Sort waiting requests by priority, then request time.
function waitingOrder(a, b) {
  return (
    b.priority - a.priority ||
    a.created_at.localeCompare(b.created_at) ||
    a.request_id.localeCompare(b.request_id)
  );
}

// Calculate dynamic parking pricing.
function quote(request, spots, reservations, rule) {
  const occupied = new Set(
    reservations
      .filter(
        (r) =>
          r.status === "confirmed" &&
          overlaps(r, request)
      )
      .map((r) => r.spot_id)
  );

  const busy = spots.filter(
    (id) => occupied.has(id)
  ).length;

  const hours = Math.ceil(
    (Date.parse(request.end_time) -
      Date.parse(request.start_time)) / 3600000
  );

  const rate =
    rule[request.request_type + "_hour_piastres"];

  const highDemand =
    spots.length > 0 &&
    busy / spots.length >= rule.threshold;

  const multiplier =
    highDemand ? rule.surge_percent : 100;

  return {
    currency: "EGP",
    hours,
    hourly_piastres: rate,
    multiplier_percent: multiplier,
    total_piastres: Math.round(
      (hours * rate * multiplier) / 100
    ),
  };
}

module.exports = {
  fields,
  only,
  utc,
  normalizePlate,
  requestInput,
  overlaps,
  waitingOrder,
  quote,
};
