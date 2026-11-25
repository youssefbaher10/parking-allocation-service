// Set DEMO_USER1_PASSWORD and DEMO_USER2_PASSWORD temporarily in Git Bash.
// This creates two real records and cancels them at the end.
const assert = require("node:assert/strict");
require("dotenv").config({ quiet: true });
const base =
  "http://127.0.0.1:" + (process.env.PORT || 3001) + "/api/allocation";
async function call(method, path, token, body) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = "Bearer " + token;
  const res = await fetch(base + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const result = await res.json();
  if (!res.ok)
    throw new Error(
      method +
        " " +
        path +
        " returned " +
        res.status +
        " " +
        result.error?.message,
    );
  return result.data;
}
async function login(name, password) {
  if (!password)
    throw new Error("Set both demo password variables. See README.");
  return (await call("POST", "/auth/login", null, { username: name, password }))
    .access_token;
}
async function run() {
  const a = await login("student1", process.env.DEMO_USER1_PASSWORD);
  const b = await login("student2", process.env.DEMO_USER2_PASSWORD);
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
    const first = await call("POST", "/requests", a, body);
    cleanup.push([first.request_id, a]);
    console.log("Student 1:", first.status);
    assert.equal(
      first.status,
      "allocated",
      "Use an available one-spot sample window for this walkthrough.",
    );
    const second = await call("POST", "/requests", b, {
      ...body,
      vehicle_plate: "XYZ789",
    });
    cleanup.push([second.request_id, b]);
    console.log("Student 2:", second.status);
    assert.equal(second.status, "waitlisted");
    await call("POST", "/requests/" + first.request_id + "/cancel", a);
    const promoted = await call("GET", "/requests/" + second.request_id, b);
    assert.equal(promoted.status, "allocated");
    console.log(
      "After cancellation, student 2 is allocated.",
      promoted.reservation_id,
    );
  } finally {
    for (const [id, token] of cleanup)
      await call("POST", "/requests/" + id + "/cancel", token);
  }
}
run().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
