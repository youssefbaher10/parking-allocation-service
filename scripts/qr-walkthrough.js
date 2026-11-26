
require("dotenv").config({ quiet: true });

const assert = require("node:assert/strict");
const fs = require("node:fs");

const base = "http://127.0.0.1:8080/api/allocation";

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
      method + " " + path + " returned " + res.status
    );
  }

  return result.data;
}

async function run() {
  if (!process.env.DEMO_USER1_PASSWORD) {
    throw new Error("Set DEMO_USER1_PASSWORD first.");
  }

  if (process.env.INVENTORY_MODE !== "sample") {
    throw new Error("Use sample Inventory mode.");
  }

  const login = await call("POST", "/auth/login", null, {
    username: "student1",
    password: process.env.DEMO_USER1_PASSWORD,
  });

  const token = login.access_token;

  assert.ok(token);

  console.log("PASS: Cognito authentication");

  const start = Date.now() + 7 * 86400000;

  let request;

  try {
    request = await call("POST", "/requests", token, {
      zone_id: "zone_1",
      spot_type: "standard",
      request_type: "daily",
      vehicle_plate: "QRTEST123",
      start_time: new Date(start).toISOString(),
      end_time: new Date(start + 3600000).toISOString(),
    });

    assert.equal(request.status, "allocated");

    console.log("PASS: Reservation allocated");
    console.log("Reservation ID:", request.reservation_id);

    const response = await fetch(
      base + "/reservations/" +
      request.reservation_id + "/qr",
      {
        headers: {
          Authorization: "Bearer " + token,
        },
      }
    );

    console.log("QR HTTP status:", response.status);
    console.log(
      "Content-Type:",
      response.headers.get("content-type")
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/png");
    assert.equal(response.headers.get("cache-control"), "no-store");

    const image = Buffer.from(
      await response.arrayBuffer()
    );

    const signature = Buffer.from([
      137, 80, 78, 71, 13, 10, 26, 10,
    ]);

    assert.ok(image.subarray(0, 8).equals(signature));

    console.log("PASS: PNG signature verified");
    console.log("PASS: Secure cache-control header");
    console.log("Image size:", image.length, "bytes");

    fs.mkdirSync(".local/runtime", {
      recursive: true,
    });

    fs.writeFileSync(
      ".local/runtime/qr-permit.png",
      image
    );

    console.log("QR saved: .local/runtime/qr-permit.png");
    console.log("PASS: External QR API integration");

  } finally {
    if (request?.request_id) {
      await call(
        "POST",
        "/requests/" + request.request_id + "/cancel",
        token
      );

      console.log("PASS: Test reservation cancelled");
    }
  }
}

run().catch((error) => {
  console.error("FAIL:", error.message);
  process.exitCode = 1;
});
