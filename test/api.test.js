// Uses fresh, uniquely named DynamoDB tables, never the user's existing parking records.
require("dotenv").config({ quiet: true });
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID, randomBytes, scryptSync } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const jwt = require("jsonwebtoken");
const suffix = randomUUID().slice(0, 8);
const endpoint = new URL(
  process.env.DYNAMODB_ENDPOINT || "http://localhost:4566",
);
if (!["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname))
  throw new Error("API tests require a local emulator.");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "parking-test-"));
Object.assign(process.env, {
  DYNAMODB_ENDPOINT: endpoint.href,
  AWS_REGION: "us-east-1",
  AWS_ACCESS_KEY_ID: "test",
  AWS_SECRET_ACCESS_KEY: "test",
  AUTH_SECRET: randomBytes(32).toString("hex"),
  INTERNAL_TOKEN: randomBytes(32).toString("hex"),
  INVENTORY_MODE: "sample",
  ACCOUNTS_FILE: path.join(temp, "accounts.json"),
  RATE_LIMIT: "300",
  PARKING_REQUESTS_TABLE: "TestRequests" + suffix,
  RESERVATIONS_TABLE: "TestReservations" + suffix,
  WAITLIST_TABLE: "TestWait" + suffix,
  PRICING_TABLE: "TestRules" + suffix,
});
delete process.env.AWS_PROFILE;
const password = randomBytes(12).toString("hex");
fs.writeFileSync(
  process.env.ACCOUNTS_FILE,
  JSON.stringify([
    {
      user_id: "one",
      role: "user",
      priority: 1,
      salt: "test-salt",
      hash: scryptSync(password, "test-salt", 64).toString("hex"),
    },
  ]),
);
const setup = require("../scripts/setup");
const app = require("../app");
const db = require("../src/config/dynamodb");
const tables = require("../src/config/tables");
const { PutCommand } = require("@aws-sdk/lib-dynamodb");
const { DeleteTableCommand } = require("@aws-sdk/client-dynamodb");
let server, base;
function token(sub, role = "user", priority = 1) {
  return jwt.sign({ sub, role, priority }, process.env.AUTH_SECRET, {
    expiresIn: "1h",
    issuer: process.env.AUTH_ISSUER || "parking-team",
    audience: process.env.AUTH_AUDIENCE || "parking-api",
  });
}
const one = token("one"),
  two = token("two"),
  high = token("high", "user", 2),
  admin = token("admin", "admin");
const start = Date.now() + 86400000;
function slot(n) {
  return {
    zone_id: "zone_1",
    spot_type: "standard",
    request_type: "daily",
    vehicle_plate: "ABC123",
    start_time: new Date(start + n * 7200000).toISOString(),
    end_time: new Date(start + n * 7200000 + 3600000).toISOString(),
  };
}
async function api(method, url, actor, body, headers = {}) {
  const options = { method, headers: { ...headers } };
  if (actor) options.headers.Authorization = "Bearer " + actor;
  if (body !== undefined) {
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }
  const res = await fetch(base + url, options);
  return { status: res.status, ...(await res.json()) };
}
before(async () => {
  await setup();
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = "http://127.0.0.1:" + server.address().port + "/api/allocation";
});
after(async () => {
  if (server) await new Promise((r) => server.close(r));
  for (const t of Object.values(tables)) {
    try {
      await db.send(new DeleteTableCommand({ TableName: t.name }));
    } catch (e) {
      if (e.name !== "ResourceNotFoundException") throw e;
    }
  }
  db.destroy();
  fs.rmSync(temp, { recursive: true, force: true });
});
test("missing and expired credentials return 401", async () => {
  assert.equal((await api("GET", "/requests")).status, 401);
  const expired = jwt.sign(
    { sub: "one", role: "user", exp: 1 },
    process.env.AUTH_SECRET,
  );
  assert.equal((await api("GET", "/requests", expired)).status, 401);
});
test("login succeeds with the password and rejects an incorrect password", async () => {
  assert.equal(
    (
      await api("POST", "/auth/login", null, {
        username: "one",
        password: "incorrect",
      })
    ).status,
    401,
  );
  const login = await api("POST", "/auth/login", null, {
    username: "one",
    password,
  });
  assert.equal(
    (await api("GET", "/requests", login.data.access_token)).status,
    200,
  );
});
test("role, field validation, media type and malformed JSON", async () => {
  assert.equal((await api("POST", "/admin/maintenance", one)).status, 403);
  assert.equal(
    (await api("POST", "/requests", one, { ...slot(1), user_id: "two" }))
      .status,
    400,
  );
  const bad = await fetch(base + "/requests", { method: "POST", body: "text" });
  assert.equal(bad.status, 415);
  const json = await fetch(base + "/requests", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{",
  });
  assert.equal(json.status, 400);
});
test("create, read, ownership, filters, idempotency and price", async () => {
  const headers = { "Idempotency-Key": "first" },
    body = slot(2);
  const first = await api("POST", "/requests", one, body, headers);
  assert.equal(first.status, 201);
  assert.equal(first.data.status, "allocated");
  const id = first.data.request_id;
  assert.equal(
    (await api("POST", "/requests", one, body, headers)).data.request_id,
    id,
  );
  assert.equal(
    (
      await api(
        "POST",
        "/requests",
        one,
        { ...body, vehicle_plate: "Z" },
        headers,
      )
    ).status,
    409,
  );
  assert.equal((await api("GET", "/requests/" + id, two)).status, 404);
  assert.equal(
    (await api("GET", "/requests/" + id, admin)).data.request_id,
    id,
  );
  assert.equal(
    (await api("GET", "/requests?status=allocated", two)).data.length,
    0,
  );
  assert.equal(
    (await api("POST", "/pricing/quote", one, body)).data.total_piastres,
    1250,
  );
});
test("two simultaneous writes cannot book the same spot; priority wins on release", async () => {
  const body = slot(3);
  const out = await Promise.all([
    api("POST", "/requests", one, body),
    api("POST", "/requests", two, body),
  ]);
  assert.ok(out.every((r) => r.status === 201));
  const ids = out.map((r) => r.data.request_id);
  const persisted = await Promise.all(
    ids.map((id) => api("GET", "/requests/" + id, admin)),
  );
  assert.deepEqual(persisted.map((r) => r.data.status).sort(), [
    "allocated",
    "waitlisted",
  ]);
  const premium = await api("POST", "/requests", high, body);
  assert.equal((await api("GET", "/waitlist/me", high)).data[0].queue_rank, 1);
  const active = persisted.find((r) => r.data.status === "allocated").data;
  assert.equal(
    (
      await api(
        "PATCH",
        "/reservations/" + active.reservation_id + "/cancel",
        admin,
      )
    ).status,
    200,
  );
  assert.equal(
    (await api("GET", "/requests/" + premium.data.request_id, high)).data
      .status,
    "allocated",
  );
});
test("edit waiting request, cancel it, manual assignment cannot take occupied spot", async () => {
  const body = slot(4);
  await api("POST", "/requests", one, body);
  const w = (await api("POST", "/requests", two, body)).data;
  assert.equal(
    (
      await api("POST", "/requests/" + w.request_id + "/assign", admin, {
        spot_id: "A1",
      })
    ).status,
    409,
  );
  const edit = await api("PATCH", "/requests/" + w.request_id, two, {
    vehicle_plate: "XYZ",
  });
  assert.equal(edit.data.vehicle_plate, "XYZ");
  assert.equal(
    (await api("POST", "/requests/" + w.request_id + "/cancel", two)).data
      .status,
    "cancelled",
  );
});
test("renew, accept adjacent booking and reject conflicting extension", async () => {
  const body = slot(5);
  const a = (await api("POST", "/requests", one, body)).data;
  const url = "/reservations/" + a.reservation_id + "/renew";
  const end_time = new Date(Date.parse(body.end_time) + 600000).toISOString();
  assert.equal(
    (await api("POST", url, one, { end_time })).data.end_time,
    end_time,
  );
  const later = {
    ...body,
    start_time: end_time,
    end_time: new Date(Date.parse(end_time) + 600000).toISOString(),
  };
  assert.equal(
    (await api("POST", "/requests", two, later)).data.status,
    "allocated",
  );
  assert.equal(
    (await api("POST", url, one, { end_time: later.end_time })).status,
    409,
  );
});
test("expiry, service-only permit check, and maintenance replay", async () => {
  const b = slot(6);
  const r = (await api("POST", "/requests", one, b)).data;
  const reservation = (
    await api("GET", "/reservations/" + r.reservation_id, one)
  ).data;
  const url = "/internal/reservations/" + r.reservation_id + "/validity";
  assert.equal((await api("GET", url, one)).status, 401);
  assert.equal(
    (await api("GET", url, process.env.INTERNAL_TOKEN)).data.valid,
    false,
  );
  // Advance only this fixture's times, so the test runs immediately.
  const past = new Date(Date.now() - 60000).toISOString();
  await db.send(
    new PutCommand({
      TableName: tables.reservations.name,
      Item: { ...reservation, start_time: past },
    }),
  );
  assert.equal(
    (await api("GET", url, process.env.INTERNAL_TOKEN)).data.valid,
    true,
  );
  for (const [t, item] of [
    ["requests", r],
    ["reservations", reservation],
  ]) {
    await db.send(
      new PutCommand({
        TableName: tables[t].name,
        Item: { ...item, start_time: past, end_time: past },
      }),
    );
  }
  assert.equal(
    (await api("POST", "/admin/maintenance", admin)).data.expired,
    1,
  );
  assert.equal(
    (await api("GET", url, process.env.INTERNAL_TOKEN)).data.valid,
    false,
  );
  assert.equal(
    (await api("POST", "/admin/maintenance", admin)).data.expired,
    0,
  );
});
test("HTTP catalogue contract and failure handling", async () => {
  process.env.INVENTORY_MODE = "http";
  process.env.INVENTORY_TOKEN = "local-test";
  const catalogue = http
    .createServer((req, res) => {
      assert.equal(req.headers.authorization, "Bearer local-test");
      if (
        !req.url.startsWith(
          "/api/inventory/spots?zone_id=zone_1&spot_type=standard",
        )
      )
        return res.writeHead(400).end();
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          data: [
            {
              spot_id: "B1",
              zone_id: "zone_1",
              spot_type: "standard",
              active: true,
            },
          ],
        }),
      );
    })
    .listen(0, "127.0.0.1");
  await new Promise((r) => catalogue.once("listening", r));
  process.env.INVENTORY_URL = "http://127.0.0.1:" + catalogue.address().port;
  try {
    const r = await api("POST", "/requests", one, slot(8));
    assert.equal(r.data.status, "allocated");
    assert.equal(
      (await api("GET", "/reservations/" + r.data.reservation_id, one)).data
        .spot_id,
      "B1",
    );
  } finally {
    await new Promise((r) => catalogue.close(r));
  }
  try {
    assert.equal((await api("POST", "/requests", one, slot(9))).status, 503);
  } finally {
    process.env.INVENTORY_MODE = "sample";
  }
});
test("admin assigns a matching spot after Inventory activates it", async () => {
  const body = { ...slot(10), zone_id: "zone_new" };
  const request = (await api("POST", "/requests", one, body)).data;
  assert.equal(request.status, "waitlisted");
  const catalogue = http
    .createServer((req, res) => {
      res.end(
        JSON.stringify({
          data: [
            {
              spot_id: "N1",
              zone_id: "zone_new",
              spot_type: "standard",
              active: true,
            },
          ],
        }),
      );
    })
    .listen(0, "127.0.0.1");
  await new Promise((r) => catalogue.once("listening", r));
  process.env.INVENTORY_MODE = "http";
  process.env.INVENTORY_URL = "http://127.0.0.1:" + catalogue.address().port;
  try {
    const path = "/requests/" + request.request_id + "/assign";
    assert.equal((await api("POST", path, one, { spot_id: "N1" })).status, 403);
    assert.equal(
      (await api("POST", path, admin, { spot_id: "N1" })).data.spot_id,
      "N1",
    );
  } finally {
    process.env.INVENTORY_MODE = "sample";
    await new Promise((r) => catalogue.close(r));
  }
});
test("security headers and rate limit", async () => {
  const res = await fetch(base + "/requests", {
    headers: { Authorization: "Bearer " + one },
  });
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  let status = 200;
  for (let i = 0; i <= 300 && status !== 429; i++)
    status = (await fetch(base + "/requests")).status;
  assert.equal(status, 429);
});
