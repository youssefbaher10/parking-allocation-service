
const { randomUUID, createHash } = require("node:crypto");
const repo = require("../repositories/dynamodb/requestRepository");
const { spotsFor } = require("./inventory");
const { ApiError, conflict, invalid } = require("./errors");

const {
  fields,
  only,
  utc,
  normalizePlate,
  requestInput,
  overlaps,
  waitingOrder,
  quote,
} = require("./rules");

const now = () => new Date().toISOString();

const group = (a, b) =>
  a.zone_id === b.zone_id && a.spot_type === b.spot_type;

async function owned(table, id, actor) {
  const row = await repo.get(table, id);

  if (!row || (actor.role !== "admin" && row.user_id !== actor.user_id)) {
    throw new ApiError(404, "NOT_FOUND", "Record not found.");
  }

  return row;
}

async function requests(actor, filters) {
  only(filters, ["status", "priority", "request_type"]);

  const rows = await repo.list("requests");

  return rows
    .filter(
      (r) =>
        (actor.role === "admin" || r.user_id === actor.user_id) &&
        Object.entries(filters).every(([k, v]) => String(r[k]) === v),
    )
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

async function queue(actor) {
  const waiting = (await repo.list("waiting")).sort(waitingOrder);
  const ranks = new Map();
  const result = [];

  for (const r of waiting) {
    const key = r.zone_id + "/" + r.spot_type;
    const rank = (ranks.get(key) || 0) + 1;

    ranks.set(key, rank);

    if (r.user_id === actor.user_id) {
      result.push({ ...r, queue_rank: rank });
    }
  }

  return result;
}

async function price(input) {
  const clean = requestInput(input, now());
  const spots = await spotsFor(clean);

  return quote(
    clean,
    spots,
    await repo.list("reservations"),
    await repo.get("rules", "tariff"),
  );
}

function booking(r, spot, spots, reservations, rule) {
  const reservation = {
    ...r,
    reservation_id: "res_" + r.request_id,
    spot_id: spot,
    status: "confirmed",
    confirmed_at: now(),
    price: quote(r, spots, reservations, rule),
  };

  const request = {
    ...r,
    status: "allocated",
    reservation_id: reservation.reservation_id,
  };

  return {
    writes: [
      repo.save("requests", request),
      repo.save("reservations", reservation),
      repo.remove("waiting", r.request_id),
    ],
    result: reservation,
  };
}

// One promotion per transaction.
// Sort the queue before trying available time windows.
async function promoteOne(scope) {
  return repo.change(async () => {
    const clock = now();

    const waiting = (await repo.list("waiting"))
      .filter((r) => group(r, scope) && r.end_time > clock)
      .sort(waitingOrder);

    if (!waiting.length) {
      return { writes: [], result: null };
    }

    const spots = await spotsFor(scope);
    const reservations = await repo.list("reservations");
    const rule = await repo.get("rules", "tariff");

    for (const r of waiting) {
      const spot = spots.find(
        (id) =>
          !reservations.some(
            (s) =>
              s.spot_id === id &&
              s.status === "confirmed" &&
              overlaps(s, r),
          ),
      );

      if (!spot) continue;

      return booking(r, spot, spots, reservations, rule);
    }

    return { writes: [], result: null };
  });
}

async function promote(scope) {
  // Bound one HTTP request.
  // The scheduled job continues any remaining work.
  for (let i = 0; i < 12; i++) {
    if (!(await promoteOne(scope))) break;
  }
}

async function attemptPromotion(scope) {
  try {
    await promote(scope);
  } catch (e) {
    // The request/cancellation is already durable.
    // The next sweep retries the queue.
    console.error(
      JSON.stringify({
        event: "promotion_deferred",
        zone_id: scope.zone_id,
        reason: e.code || e.name,
      }),
    );
  }
}

async function submit(body, actor, token) {
  if (token && !/^[a-zA-Z0-9_-]{1,100}$/.test(token)) {
    invalid("Invalid Idempotency-Key.");
  }

  const id = token
    ? createHash("sha256")
        .update(JSON.stringify([actor.user_id, token]))
        .digest("hex")
    : randomUUID();

  const input = requestInput(body, "");
  const signature = JSON.stringify(fields.map((k) => input[k]));

  await repo.change(async () => {
    const old = await repo.get("requests", id);

    if (old) {
      if (old.signature !== signature) {
        conflict("This key belongs to a different submission.");
      }

      return { writes: [], result: old };
    }

    const clock = now();

    if (input.start_time < clock) {
      invalid("Start time must be in the future.");
    }

    // Fail before accepting a request if the catalogue is offline.
    await spotsFor(input);

    const row = {
      ...input,
      request_id: id,
      user_id: actor.user_id,
      priority: actor.priority,
      status: "waitlisted",
      created_at: clock,
      signature,
    };

    return {
      writes: [
        repo.save("requests", row),
        repo.save("waiting", row),
      ],
      result: row,
    };
  });

  await attemptPromotion(input);

  return repo.get("requests", id);
}

async function edit(id, body, actor) {
  only(body, fields);

  if (!Object.keys(body).length) {
    invalid("Provide a field to update.");
  }

  const updated = await repo.change(async () => {
    const old = await owned("requests", id, actor);

    if (old.status !== "waitlisted") {
      conflict("Only waiting requests can be edited.");
    }

    const previous = Object.fromEntries(
      fields.map((k) => [k, old[k]]),
    );

    const clean = requestInput(
      { ...previous, ...body },
      now(),
    );

    await spotsFor(clean);

    const row = { ...old, ...clean };

    return {
      writes: [
        repo.save("requests", row),
        repo.save("waiting", row),
      ],
      result: row,
    };
  });

  await attemptPromotion(updated);

  return repo.get("requests", id);
}

async function closeRequest(id, actor, reason) {
  const row = await repo.change(async () => {
    const r = await owned("requests", id, actor);

    if (["expired", "cancelled"].includes(r.status)) {
      return { writes: [], result: r };
    }

    // Reservation may have been renewed during the sweep.
    if (reason === "expired" && r.end_time > now()) {
      return { writes: [], result: r };
    }

    if (reason === "cancelled" && r.end_time <= now()) {
      conflict("This request has already ended.");
    }

    const closed = { ...r, status: reason };
    const writes = [repo.save("requests", closed)];

    if (r.status === "waitlisted") {
      writes.push(repo.remove("waiting", id));
    }

    if (r.reservation_id) {
      const s = await repo.get(
        "reservations",
        r.reservation_id,
      );

      writes.push(
        repo.save("reservations", {
          ...s,
          status: reason,
        }),
      );
    }

    return { writes, result: closed };
  });

  if (reason === "cancelled") {
    await attemptPromotion(row);
  }

  return row;
}

async function cancelReservation(id, actor) {
  const s = await owned("reservations", id, actor);

  await closeRequest(s.request_id, actor, "cancelled");

  return repo.get("reservations", id);
}

async function renew(id, body, actor) {
  only(body, ["end_time"]);

  const end = utc(body.end_time);

  return repo.change(async () => {
    const s = await owned("reservations", id, actor);

    if (s.status !== "confirmed" || s.end_time <= now()) {
      conflict("Only an unexpired reservation can be renewed.");
    }

    if (end <= s.end_time) {
      invalid("New end must be later than the current end.");
    }

    const extension = {
      ...s,
      start_time: s.end_time,
      end_time: end,
    };

    const spots = await spotsFor(s);

    if (!spots.includes(s.spot_id)) {
      conflict("This spot is inactive.");
    }

    const others = (await repo.list("reservations")).filter(
      (r) => r.reservation_id !== id,
    );

    if (
      others.some(
        (r) =>
          r.spot_id === s.spot_id &&
          r.status === "confirmed" &&
          overlaps(r, extension),
      )
    ) {
      conflict(
        "Another reservation uses this spot during the extension.",
      );
    }

    const r = await repo.get("requests", s.request_id);

    const updated = { ...s, end_time: end };

    updated.price = quote(
      updated,
      spots,
      others,
      await repo.get("rules", "tariff"),
    );

    return {
      writes: [
        repo.save("reservations", updated),
        repo.save("requests", { ...r, end_time: end }),
      ],
      result: updated,
    };
  });
}

// Verify a reservation using its ID.
// Used for QR permit verification.
async function validity(id) {
  const s = await repo.get("reservations", id);
  const clock = now();

  const valid = Boolean(
    s &&
    s.status === "confirmed" &&
    s.start_time <= clock &&
    clock < s.end_time,
  );

  return {
    reservation_id: id,
    valid,
    spot_id: valid ? s.spot_id : null,
    vehicle_plate: valid ? s.vehicle_plate : null,
  };
}

// Find an active reservation using a vehicle plate and parking spot.
// Used by the Incident Reports Service for possible violation detection.
async function lookupReservation(filters) {
  only(filters, ["vehicle_plate", "spot_id"]);

  const plate = normalizePlate(filters.vehicle_plate);
  const spotId = filters.spot_id;

  if (
    typeof spotId !== "string" ||
    !/^[\w-]{1,64}$/.test(spotId)
  ) {
    invalid("Invalid spot_id.");
  }

  const reservations = await repo.list("reservations");
  const clock = now();

  const matches = reservations.filter(
    (r) =>
      r.vehicle_plate === plate &&
      r.spot_id === spotId &&
      r.status === "confirmed" &&
      r.start_time <= clock &&
      clock < r.end_time,
  );

  // A conflicting database state must not be reported
  // as a normal valid or invalid reservation.
  if (matches.length > 1) {
    throw new ApiError(
      503,
      "RESERVATION_CONFLICT",
      "Multiple active reservations found.",
    );
  }

  const reservation = matches[0];

  return {
    valid: Boolean(reservation),
    reservation_id: reservation
      ? reservation.reservation_id
      : null,
    spot_id: reservation
      ? reservation.spot_id
      : null,
    vehicle_plate: reservation
      ? reservation.vehicle_plate
      : null,
  };
}

// Expire outdated reservations and process waiting requests.
async function sweep() {
  const clock = now();
  const entries = await repo.list("requests");

  let expired = 0;

  for (const r of entries) {
    if (
      ["waitlisted", "allocated"].includes(r.status) &&
      r.end_time <= clock
    ) {
      const row = await closeRequest(
        r.request_id,
        { role: "admin" },
        "expired",
      );

      if (row.status === "expired") {
        expired++;
      }
    }
  }

  const groups = new Map();

  for (const w of await repo.list("waiting")) {
    groups.set(w.zone_id + "/" + w.spot_type, w);
  }

  for (const scope of groups.values()) {
    await promote(scope);
  }

  return {
    expired,
    groups_checked: groups.size,
  };
}

module.exports = {
  owned,
  requests,
  queue,
  price,
  submit,
  edit,
  closeRequest,
  cancelReservation,
  renew,
  validity,
  lookupReservation,
  sweep,
  promote,
  booking,
};
