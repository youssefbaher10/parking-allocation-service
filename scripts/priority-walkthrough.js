
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

  const res = await fetch(base + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const result = await res.json();

  if (!res.ok) {
    throw new Error(
      method + " " + path +
      " returned " + res.status +
      " " + result.error?.message
    );
  }

  return result.data;
}

async function login(username, password) {
  if (!password) {
    throw new Error("Missing password for " + username);
  }

  const result = await call("POST", "/auth/login", null, {
    username,
    password,
  });

  assert.ok(result.access_token);

  return result.access_token;
}

async function run() {
  if (process.env.AUTH_MODE !== "cognito") {
    throw new Error("Use Cognito authentication mode.");
  }

  if (process.env.INVENTORY_MODE !== "sample") {
    throw new Error("Use sample inventory for this test.");
  }

  const a = await login(
    "student1",
    process.env.DEMO_USER1_PASSWORD
  );

  const b = await login(
    "student2",
    process.env.DEMO_USER2_PASSWORD
  );

  const p = await login(
    "priority1",
    process.env.DEMO_PRIORITY_PASSWORD
  );

  console.log("PASS: All three users logged in");

  const start = Date.now() + 86400000;

  const body = {
    zone_id: "zone_1",
    spot_type: "standard",
    request_type: "daily",
    vehicle_plate: "ABC123",
    start_time: new Date(start).toISOString(),
    end_time: new Date(start + 3600000).toISOString(),
  };

  const cleanup = [];

  try {
    // Student 1 occupies the available parking spot
    const first = await call("POST", "/requests", a, body);

    cleanup.push([first.request_id, a]);

    assert.equal(first.status, "allocated");
    assert.equal(first.priority, 1);

    console.log("Student 1:", first.status);

    // Student 2 joins the waiting list
    const second = await call("POST", "/requests", b, {
      ...body,
      vehicle_plate: "XYZ789",
    });

    cleanup.push([second.request_id, b]);

    assert.equal(second.status, "waitlisted");
    assert.equal(second.priority, 1);

    console.log("Student 2:", second.status);
    console.log("Student 2 priority:", second.priority);

    // High-priority student joins the waiting list later
    const priority = await call("POST", "/requests", p, {
      ...body,
      vehicle_plate: "PRI123",
    });

    cleanup.push([priority.request_id, p]);

    assert.equal(priority.status, "waitlisted");
    assert.equal(priority.priority, 2);

    console.log("Priority user:", priority.status);
    console.log("Priority user level:", priority.priority);

    // Student 1 releases the parking spot
    await call(
      "POST",
      "/requests/" + first.request_id + "/cancel",
      a
    );

    console.log("Student 1 cancelled the reservation");

    // Check which student receives the released spot
    const promoted = await call(
      "GET",
      "/requests/" + priority.request_id,
      p
    );

    const waiting = await call(
      "GET",
      "/requests/" + second.request_id,
      b
    );

    assert.equal(promoted.status, "allocated");
    assert.equal(waiting.status, "waitlisted");

    console.log("Priority user:", promoted.status);
    console.log("Student 2:", waiting.status);

    console.log("PASS: Priority-based allocation");
    console.log("PASS: Automatic waitlist promotion");
    console.log("PASS: Parking priority preserved with Cognito");

  } finally {
    // Clean up only the requests created by this test
    for (const [id, token] of cleanup.reverse()) {
      try {
        await call(
          "POST",
          "/requests/" + id + "/cancel",
          token
        );
      } catch (error) {
        console.error("Cleanup failed:", error.message);
        process.exitCode = 1;
      }
    }
  }
}

run().catch((error) => {
  console.error("FAIL:", error.message);
  process.exitCode = 1;
});
