
const assert = require("node:assert/strict");
require("dotenv").config({ quiet: true });

const base =
  "http://127.0.0.1:" +
  (process.env.PORT || 3001) +
  "/api/allocation";

async function call(method, path, token, body) {
  const headers = {
    "Content-Type": "application/json",
  };

  if (token) {
    headers.Authorization = "Bearer " + token;
  }

  const response = await fetch(base + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  return {
    status: response.status,
    body: await response.json(),
  };
}

async function login(username, password) {
  const result = await call("POST", "/auth/login", null, {
    username,
    password,
  });

  assert.equal(result.status, 200);
  assert.ok(result.body.data.access_token);

  return result.body.data.access_token;
}

async function run() {
  assert.equal(process.env.AUTH_MODE, "cognito");
  assert.equal(process.env.INVENTORY_MODE, "sample");

  const a = await login(
    "student1",
    process.env.DEMO_USER1_PASSWORD
  );

  const b = await login(
    "student2",
    process.env.DEMO_USER2_PASSWORD
  );

  console.log("PASS: Both students logged in");

  const start = Date.now() + 86400000;

  let requestId;

  try {
    const created = await call("POST", "/requests", a, {
      zone_id: "zone_1",
      spot_type: "standard",
      request_type: "daily",
      vehicle_plate: "ABC123",
      start_time: new Date(start).toISOString(),
      end_time: new Date(start + 3600000).toISOString(),
    });

    assert.ok(
      created.status === 200 || created.status === 201
    );

    const request = created.body.data;

    requestId = request.request_id;

    assert.equal(request.status, "allocated");
    assert.ok(request.reservation_id);

    const path = "/reservations/" + request.reservation_id;

    console.log("PASS: Student 1 received a reservation");

    // Owner accesses their reservation
    const own = await call("GET", path, a);

    assert.equal(own.status, 200);

    console.log("PASS: Owner can view reservation");

    // Another student attempts to view it
    const unauthorizedRead = await call("GET", path, b);

    assert.equal(unauthorizedRead.status, 404);

    console.log("PASS: Unauthorized read blocked (404)");

    // Another student attempts to cancel it
    const unauthorizedCancel = await call(
      "PATCH",
      path + "/cancel",
      b
    );

    assert.equal(unauthorizedCancel.status, 404);

    console.log("PASS: Unauthorized cancellation blocked (404)");

    // Verify reservation was not affected
    const unchanged = await call("GET", path, a);

    assert.equal(unchanged.status, 200);
    assert.equal(unchanged.body.data.status, "confirmed");

    console.log("PASS: Reservation remains confirmed");

    // Owner cancels their own reservation
    const cancelled = await call(
      "PATCH",
      path + "/cancel",
      a
    );

    assert.equal(cancelled.status, 200);

    const after = await call("GET", path, a);
    assert.equal(after.status, 200);
    assert.equal(after.body.data.status, "cancelled");

    console.log("PASS: Owner can cancel reservation");

    console.log("PASS: All ownership security tests");

  } finally {
    if (requestId) {
      const cleanup = await call(
        "POST",
        "/requests/" + requestId + "/cancel",
        a
      );

      if (cleanup.status !== 200) {
        console.error("Cleanup failed:", cleanup.status);
        process.exitCode = 1;
      }
    }
  }
}

run().catch(error => {
  console.error("FAIL:", error.message);
  process.exitCode = 1;
});
