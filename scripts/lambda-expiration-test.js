
require("dotenv").config({ quiet: true });

const assert = require("node:assert/strict");
const fs = require("node:fs");

const {
  GetCommand,
  TransactWriteCommand,
} = require("@aws-sdk/lib-dynamodb");

const db = require("../src/config/dynamodb");
const tables = require("../src/config/tables");

const base = "http://localhost:3001/api/allocation";

const fixture = ".local/runtime/lambda-expiration-fixture.json";

// Create a controlled demonstration reservation
async function prepare() {
  assert.equal(process.env.INVENTORY_MODE, "sample");

  const endpoint = new URL(process.env.DYNAMODB_ENDPOINT);

  assert.ok(
    ["localhost", "127.0.0.1"].includes(endpoint.hostname),
    "Use local Floci only."
  );

  if (fs.existsSync(fixture)) {
    throw new Error("A test fixture already exists.");
  }

  const password = process.env.DEMO_USER1_PASSWORD;

  if (!password) {
    throw new Error("Set DEMO_USER1_PASSWORD first.");
  }

  // Login through Cognito
  const login = await fetch(base + "/auth/login", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      username: "student1",
      password,
    }),
  });

  assert.equal(login.status, 200);

  const loginData = await login.json();
  const token = loginData.data.access_token;

  // Create a future reservation
  const start = Date.now() + 86400000;

  const response = await fetch(base + "/requests", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + token,
    },
    body: JSON.stringify({
      zone_id: "zone_1",
      spot_type: "standard",
      request_type: "daily",
      vehicle_plate: "LMB123",
      start_time: new Date(start).toISOString(),
      end_time: new Date(start + 3600000).toISOString(),
    }),
  });

  assert.equal(response.status, 201);

  const request = (await response.json()).data;

  assert.equal(request.status, "allocated");

  const ids = {
    request_id: request.request_id,
    reservation_id: request.reservation_id,
  };

  fs.mkdirSync(".local/runtime", {
    recursive: true,
  });

  fs.writeFileSync(
    fixture,
    JSON.stringify(ids, null, 2),
    { flag: "wx" }
  );

  console.log("PASS: Test request allocated.");

  const reservation = await db.send(
    new GetCommand({
      TableName: tables.reservations.name,
      Key: {
        reservation_id: ids.reservation_id,
      },
      ConsistentRead: true,
    })
  );

  assert.equal(reservation.Item.status, "confirmed");

  console.log("PASS: Test reservation confirmed.");

  // Simulate an ended parking period
  const pastStart = new Date(
    Date.now() - 7200000
  ).toISOString();

  const pastEnd = new Date(
    Date.now() - 3600000
  ).toISOString();

  // Modify only the two records created by this test
  await db.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: tables.requests.name,
            Key: {
              request_id: ids.request_id,
            },
            UpdateExpression:
              "SET start_time = :start, end_time = :end",
            ConditionExpression: "#s = :expected",
            ExpressionAttributeNames: {
              "#s": "status",
            },
            ExpressionAttributeValues: {
              ":start": pastStart,
              ":end": pastEnd,
              ":expected": "allocated",
            },
          },
        },
        {
          Update: {
            TableName: tables.reservations.name,
            Key: {
              reservation_id: ids.reservation_id,
            },
            UpdateExpression:
              "SET start_time = :start, end_time = :end",
            ConditionExpression: "#s = :expected",
            ExpressionAttributeNames: {
              "#s": "status",
            },
            ExpressionAttributeValues: {
              ":start": pastStart,
              ":end": pastEnd,
              ":expected": "confirmed",
            },
          },
        },
      ],
    })
  );

  console.log("PASS: Test booking period moved into the past.");
  console.log("Request status: allocated");
  console.log("Reservation status: confirmed");
  console.log("Ready for Lambda invocation.");
}

// Verify the database after Lambda execution
async function verify() {
  const ids = JSON.parse(
    fs.readFileSync(fixture, "utf8")
  );

  const request = await db.send(
    new GetCommand({
      TableName: tables.requests.name,
      Key: {
        request_id: ids.request_id,
      },
      ConsistentRead: true,
    })
  );

  const reservation = await db.send(
    new GetCommand({
      TableName: tables.reservations.name,
      Key: {
        reservation_id: ids.reservation_id,
      },
      ConsistentRead: true,
    })
  );

  assert.equal(request.Item.status, "expired");
  assert.equal(reservation.Item.status, "expired");

  console.log("PASS: Request status is expired.");
  console.log("PASS: Reservation status is expired.");
  console.log("PASS: Lambda updated DynamoDB successfully.");
}

async function main() {
  const mode = process.argv[2];

  if (mode === "prepare") {
    await prepare();
  } else if (mode === "verify") {
    await verify();
  } else {
    throw new Error("Use prepare or verify.");
  }
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => {
    db.destroy();
  });
