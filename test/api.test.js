require("dotenv").config({ quiet: true });
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID, randomBytes } = require("node:crypto");
const http = require("node:http");
const jwt = require("jsonwebtoken");
const suffix = randomUUID().slice(0, 8);
const endpoint = new URL(
  process.env.DYNAMODB_ENDPOINT || "http://localhost:4566",
);
if (!["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname))
  throw new Error("API tests require a local emulator.");
// Never send demo credentials to a non-local Cognito endpoint.
for (const name of ["COGNITO_ENDPOINT", "COGNITO_JWKS_URL"]) {
  const url = new URL(process.env[name]);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      !['http:', 'https:'].includes(url.protocol)) {
    throw new Error(name + " must point to the local emulator.");
  }
}
const accounts = [
  ["student1", "DEMO_USER1_PASSWORD"],
  ["student2", "DEMO_USER2_PASSWORD"],
  ["priority1", "DEMO_PRIORITY_PASSWORD"],
  ["admin1", "DEMO_ADMIN_PASSWORD"],
];
for (const [, name] of accounts) {
  if (!process.env[name]) throw new Error("Set " + name + " before running tests.");
}
const testTables = {
  PARKING_REQUESTS_TABLE: "TestRequests" + suffix,
  RESERVATIONS_TABLE: "TestReservations" + suffix,
  WAITLIST_TABLE: "TestWait" + suffix,
  PRICING_TABLE: "TestRules" + suffix,
};
Object.assign(process.env, {
  ...testTables,
  AUTH_MODE: "cognito",
  DYNAMODB_ENDPOINT: endpoint.href,
  AWS_REGION: "us-east-1",
  AWS_ACCESS_KEY_ID: "test",
  AWS_SECRET_ACCESS_KEY: "test",
  INTERNAL_TOKEN: randomBytes(32).toString("hex"),
  INVENTORY_MODE: "sample",
  RATE_LIMIT: "300",
});
delete process.env.AWS_PROFILE;
delete process.env.AWS_SESSION_TOKEN;
// Cognito does not need a local signing secret or local password file.
// dotenv may reload these keys, but explicit Cognito mode does not use them.
delete process.env.AUTH_SECRET;
delete process.env.ACCOUNTS_FILE;
delete process.env.ACCOUNTS_JSON;
const setup = require("../scripts/setup");
const app = require("../app");
const db = require("../src/config/dynamodb");
const tables = require("../src/config/tables");
const { PutCommand } = require("@aws-sdk/lib-dynamodb");
const { DeleteTableCommand } = require("@aws-sdk/client-dynamodb");
// Guard against accidental use or deletion of the application's real tables.
assert.deepEqual(
  Object.values(tables).map(t => t.name).sort(),
  Object.values(testTables).sort(),
  "Tests must use only the uniquely named temporary tables."
);
let server, base;
let one, two, high, admin;
let setupStarted = false;
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
  setupStarted = true;
  await setup();
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = "http://127.0.0.1:" + server.address().port + "/api/allocation";
  const tokens = [];
  for (const [username, passwordVar] of accounts) {
    const login = await api("POST", "/auth/login", null, {
      username,
      password: process.env[passwordVar],
    });
    assert.equal(login.status, 200, "Cognito login failed for " + username);
    assert.equal(typeof login.data?.access_token, "string");
    const decoded = jwt.decode(login.data.access_token, { complete: true });
    assert.equal(decoded?.header.alg, "RS256");
    assert.equal(decoded?.payload.token_use, "access");
    tokens.push(login.data.access_token);
  }
  [one, two, high, admin] = tokens;
});
after(async () => {
  if (server) await new Promise((r) => server.close(r));
  try {
    if (setupStarted) {
      for (const name of Object.values(testTables)) {
        try {
          await db.send(new DeleteTableCommand({ TableName: name }));
        } catch (e) {
          if (e.name !== "ResourceNotFoundException") throw e;
        }
      }
    }
  } finally {
    db.destroy();
  }
});
test("missing, tampered and expired Cognito credentials return 401", async (t) => {
  assert.equal((await api("GET", "/requests")).status, 401);
  assert.equal((await api("GET", "/requests", one)).status, 200);

  // Modify the payload but leave the original signature unchanged.
  const parts = one.split(".");
  const claims = jwt.decode(one);
  assert.ok(Number.isInteger(claims.exp));
  parts[1] = Buffer.from(JSON.stringify({
    ...claims,
    "cognito:groups": ["admin"],
  })).toString("base64url");
  assert.equal((await api("GET", "/requests", parts.join("."))).status, 401);

  // Simulate the clock moving past the expiry of the ORIGINAL signed JWT.
  // Only this test process is affected; the running app and Floci are unchanged.
  t.mock.timers.enable({ apis: ["Date"], now: (claims.exp + 1) * 1000 });
  try {
    assert.equal((await api("GET", "/requests", one)).status, 401);
  } finally {
    t.mock.timers.reset();
  }
  assert.equal((await api("GET", "/requests", one)).status, 200);
});
test("Cognito login succeeds with the password and rejects an incorrect password", async () => {
  const bad = await api("POST", "/auth/login", null, {
    username: "student1",
    password: "Wrong!" + randomBytes(16).toString("hex"),
  });
  assert.equal(bad.status, 401);
  assert.equal(bad.data?.access_token, undefined);
  const login = await api("POST", "/auth/login", null, {
    username: "student1",
    password: process.env.DEMO_USER1_PASSWORD,
  });
  assert.equal(login.status, 200);
  assert.equal((await api("GET", "/requests", login.data.access_token)).status, 200);
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
  assert.equal(premium.status, 201);
  assert.equal(premium.data.priority, 2);
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
// Reservation lookup tests use only the temporary test tables.
function lookupPath(plate, spot) {
  return "/internal/reservations/lookup?" + new URLSearchParams({
    vehicle_plate: plate,
    spot_id: spot,
  }).toString();
}

async function seedLookupReservation(overrides = {}) {
  const item = {
    reservation_id: "res_lookup_" + randomUUID(),
    vehicle_plate: "LOOKUP123",
    spot_id: "LOOKUP-A1",
    status: "confirmed",
    start_time: new Date(Date.now() - 60000).toISOString(),
    end_time: new Date(Date.now() + 3600000).toISOString(),
    ...overrides,
  };
  await db.send(new PutCommand({
    TableName: tables.reservations.name,
    Item: item,
  }));
  return item;
}

test("reservation lookup matches active plate and spot and rejects inactive periods", async () => {
  const token = process.env.INTERNAL_TOKEN;
  const active = await seedLookupReservation();
  const arabic = await seedLookupReservation({
    vehicle_plate: "أ ب ج 123",
    spot_id: "LOOKUP-AR",
  });
  await seedLookupReservation({
    spot_id: "LOOKUP-FUTURE",
    start_time: new Date(Date.now() + 3600000).toISOString(),
    end_time: new Date(Date.now() + 7200000).toISOString(),
  });
  await seedLookupReservation({
    spot_id: "LOOKUP-PAST",
    start_time: new Date(Date.now() - 7200000).toISOString(),
    end_time: new Date(Date.now() - 3600000).toISOString(),
  });
  await seedLookupReservation({
    spot_id: "LOOKUP-CANCELLED",
    status: "cancelled",
  });
  await seedLookupReservation({
    spot_id: "LOOKUP-EXPIRED",
    status: "expired",
    start_time: new Date(Date.now() - 7200000).toISOString(),
    end_time: new Date(Date.now() - 3600000).toISOString(),
  });

  for (const [plate, expected] of [[" lookup123 ", active], [arabic.vehicle_plate, arabic]]) {
    const result = await api("GET", lookupPath(plate, expected.spot_id), token);
    assert.equal(result.status, 200);
    assert.equal(result.success, true);
    assert.deepEqual(result.data, {
      valid: true,
      reservation_id: expected.reservation_id,
      spot_id: expected.spot_id,
      vehicle_plate: expected.vehicle_plate,
    });
  }

  for (const [plate, spot] of [
    ["WRONG123", active.spot_id],
    [active.vehicle_plate, "LOOKUP-NONE"],
    [active.vehicle_plate, "LOOKUP-FUTURE"],
    [active.vehicle_plate, "LOOKUP-PAST"],
    [active.vehicle_plate, "LOOKUP-CANCELLED"],
    [active.vehicle_plate, "LOOKUP-EXPIRED"],
  ]) {
    const result = await api("GET", lookupPath(plate, spot), token);
    assert.equal(result.status, 200);
    assert.equal(result.success, true);
    assert.deepEqual(result.data, {
      valid: false,
      reservation_id: null,
      spot_id: null,
      vehicle_plate: null,
    });
  }
});

test("reservation lookup requires the internal token, not a user or admin token", async () => {
  const url = lookupPath("LOOKUP123", "LOOKUP-A1");
  for (const token of [undefined, randomBytes(32).toString("hex"), one, admin]) {
    const result = await api("GET", url, token);
    assert.equal(result.status, 401);
    assert.equal(result.data, undefined);
  }
});

test("reservation lookup rejects missing, malformed and unexpected query parameters", async () => {
  const path = "/internal/reservations/lookup";
  const token = process.env.INTERNAL_TOKEN;
  for (const url of [
    path,
    path + "?spot_id=LOOKUP-A1",
    path + "?vehicle_plate=LOOKUP123",
    lookupPath("@@@", "LOOKUP-A1"),
    lookupPath("LOOKUP123", "bad/spot"),
    lookupPath("LOOKUP123", "LOOKUP-A1") + "&vehicle_plate=OTHER",
    lookupPath("LOOKUP123", "LOOKUP-A1") + "&unexpected=true",
  ]) {
    const result = await api("GET", url, token);
    assert.equal(result.status, 400, url);
  }
});

test("reservation lookup reports conflicting active records as an error", async () => {
  const fixture = { vehicle_plate: "CONFLICT123", spot_id: "LOOKUP-CONFLICT" };
  await seedLookupReservation(fixture);
  await seedLookupReservation(fixture);
  const result = await api(
    "GET",
    lookupPath(fixture.vehicle_plate, fixture.spot_id),
    process.env.INTERNAL_TOKEN,
  );
  assert.equal(result.status, 503);
  assert.equal(result.data, undefined);
});

// QR tests mock only the external provider; Cognito, HTTP routes and
// DynamoDB still run against the isolated local integration environment.
const mockPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1sAAAAASUVORK5CYII=",
  "base64",
);

function mockQrProvider(t, reply = () => new Response(mockPng, {
  status: 200,
  headers: { "Content-Type": "image/png" },
})) {
  const originalFetch = globalThis.fetch;
  const calls = [];
  t.mock.method(globalThis, "fetch", async (input, options) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.origin === "https://api.qrserver.com") {
      calls.push({ url, options });
      return reply(url, options);
    }
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
      throw new Error("Unexpected non-local fetch during QR test.");
    }
    return originalFetch(input, options);
  });
  return calls;
}

async function createQrReservation(n) {
  const result = await api("POST", "/requests", one, {
    ...slot(n),
    vehicle_plate: "QRTEST123",
  });
  assert.equal(result.status, 201);
  assert.equal(result.data.status, "allocated");
  return result.data.reservation_id;
}

function qrPath(id) {
  return "/reservations/" + encodeURIComponent(id) + "/qr";
}

async function assertQrImage(id, token) {
  const response = await fetch(base + qrPath(id), {
    headers: { Authorization: "Bearer " + token },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), mockPng);
}

test("QR permit returns PNG for owner and admin and supports future and active reservations", async (t) => {
  const calls = mockQrProvider(t);
  const id = await createQrReservation(11);
  await assertQrImage(id, one);
  await assertQrImage(id, admin);

  const reservation = (await api("GET", "/reservations/" + id, one)).data;
  const active = await seedLookupReservation({
    ...reservation,
    reservation_id: "res_qr_active_" + randomUUID(),
    spot_id: "QR-ACTIVE",
    start_time: new Date(Date.now() - 60000).toISOString(),
    end_time: new Date(Date.now() + 3600000).toISOString(),
  });
  await assertQrImage(active.reservation_id, one);

  assert.equal(calls.length, 3);
  for (const [i, call] of calls.entries()) {
    assert.equal(call.url.pathname, "/v1/create-qr-code/");
    assert.deepEqual(Object.fromEntries(call.url.searchParams), {
      data: i === 2 ? active.reservation_id : id,
      size: "250x250",
      format: "png",
      qzone: "4",
    });
    assert.equal(call.options.method, "GET");
    assert.equal(call.options.redirect, "error");
    assert.equal(new Headers(call.options.headers).has("Authorization"), false);
  }
});

test("QR permit denies unauthenticated users, other owners and missing reservations before contacting provider", async (t) => {
  const calls = mockQrProvider(t);
  const id = await createQrReservation(12);
  for (const [path, token, status] of [
    [qrPath(id), undefined, 401],
    [qrPath(id), two, 404],
    [qrPath(id), process.env.INTERNAL_TOKEN, 401],
    [qrPath("res_missing_" + randomUUID()), one, 404],
  ]) {
    const result = await api("GET", path, token);
    assert.equal(result.status, status);
    assert.equal(result.success, false);
  }
  assert.equal(calls.length, 0);
});

test("QR permit rejects cancelled, expired and ended reservations before contacting provider", async (t) => {
  const calls = mockQrProvider(t);
  const id = await createQrReservation(13);
  const reservation = (await api("GET", "/reservations/" + id, one)).data;
  const cancelled = await api("PATCH", "/reservations/" + id + "/cancel", one);
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.data.status, "cancelled");
  assert.equal((await api("GET", qrPath(id), one)).status, 409);

  for (const status of ["expired", "confirmed"]) {
    const ended = await seedLookupReservation({
      ...reservation,
      reservation_id: "res_qr_ended_" + randomUUID(),
      status,
      spot_id: "QR-ENDED",
      start_time: new Date(Date.now() - 7200000).toISOString(),
      end_time: new Date(Date.now() - 3600000).toISOString(),
    });
    const result = await api("GET", qrPath(ended.reservation_id), one);
    assert.equal(result.status, 409);
    assert.equal(result.success, false);
  }
  assert.equal(calls.length, 0);
});

test("QR provider failures return 503 without changing the reservation", async (t) => {
  const replies = [
    () => { throw new TypeError("Simulated connection failure"); },
    () => { throw new DOMException("Simulated timeout", "TimeoutError"); },
    () => new Response("unavailable", { status: 503 }),
    () => new Response("not an image", {
      headers: { "Content-Type": "text/plain" },
    }),
    () => new Response("invalid PNG", {
      headers: { "Content-Type": "image/png" },
    }),
    () => new Response(Buffer.alloc(1024 * 1024 + 1), {
      headers: { "Content-Type": "image/png" },
    }),
  ];
  const calls = mockQrProvider(t, () => replies[calls.length - 1]());
  const id = await createQrReservation(14);
  const beforeFailure = await api("GET", "/reservations/" + id, one);
  assert.equal(beforeFailure.status, 200);
  for (let i = 0; i < replies.length; i++) {
    const result = await api("GET", qrPath(id), one);
    assert.equal(result.status, 503);
    assert.equal(result.success, false);
    assert.equal(result.error.code, "QR_UNAVAILABLE");
  }
  assert.equal(calls.length, replies.length);
  const afterFailure = await api("GET", "/reservations/" + id, one);
  assert.equal(afterFailure.status, 200);
  assert.deepEqual(afterFailure.data, beforeFailure.data);
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
