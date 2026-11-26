
require("dotenv").config({ quiet: true });

const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const { rateLimit } = require("express-rate-limit");
const { secret } = require("./src/middleware/auth");
const { ApiError } = require("./src/services/errors");

const app = express();

// Require Cognito authentication
if (process.env.AUTH_MODE !== "cognito") {
  throw new Error("Set AUTH_MODE to cognito.");
}

// Validate internal service authentication
secret("INTERNAL_TOKEN");

// Validate Cognito configuration
const required = [
  "COGNITO_REGION",
  "COGNITO_ENDPOINT",
  "COGNITO_USER_POOL_ID",
  "COGNITO_CLIENT_ID",
  "COGNITO_ISSUER",
  "COGNITO_JWKS_URL",
];

for (const name of required) {
  if (!process.env[name]?.trim()) {
    throw new Error("Missing Cognito configuration: " + name);
  }
}

// Require identity mapping from local file or Secrets Manager
if (
  !process.env.COGNITO_USERS_FILE?.trim() &&
  !process.env.COGNITO_USERS_JSON?.trim()
) {
  throw new Error("Missing Cognito user identity mapping.");
}

// Validate inventory configuration
if (!["sample", "http"].includes(process.env.INVENTORY_MODE)) {
  throw new Error("Set INVENTORY_MODE to sample or http.");
}

if (
  process.env.INVENTORY_MODE === "http" &&
  (!process.env.INVENTORY_URL || !process.env.INVENTORY_TOKEN)
) {
  throw new Error(
    "Set INVENTORY_URL and INVENTORY_TOKEN for the Inventory API."
  );
}

const routes = require("./src/routes/requestRoutes");

// Disable Express identification
app.disable("x-powered-by");

// Security headers
app.use(helmet());

// Cross-origin access configuration
app.use(
  cors({
    origin: process.env.FRONTEND_ORIGIN || false,
  })
);

// API logging and cache protection
app.use((req, res, next) => {
  res.set("Cache-Control", "no-store");

  res.on("finish", () => {
    if (req.method !== "GET" || res.statusCode >= 400) {
      console.log(
        JSON.stringify({
          event: "api_access",
          method: req.method,
          route: req.route?.path || "other",
          status: res.statusCode,
          user_id: req.actor?.user_id,
        })
      );
    }
  });

  next();
});

// Root endpoint
app.get("/", (req, res) =>
  res.json({
    message: "Parking Allocation Service is running!",
  })
);

// Health check endpoint
app.get("/health", (req, res) =>
  res.json({
    status: "ok",
    service: "parking-allocation-service",
  })
);

// API rate limiting
app.use(
  "/api",
  rateLimit({
    windowMs: 60000,
    limit: Number(process.env.RATE_LIMIT || 120),
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: {
      success: false,
      error: {
        code: "RATE_LIMITED",
        message: "Try again in one minute.",
      },
    },
  })
);

// Validate request content type
app.use((req, res, next) => {
  const hasBody =
    Number(req.get("content-length")) > 0 ||
    req.get("transfer-encoding");

  if (hasBody && !req.is("application/json")) {
    return next(
      new ApiError(
        415,
        "UNSUPPORTED_MEDIA",
        "Use application/json."
      )
    );
  }

  next();
});

// Limit JSON request body size
app.use(express.json({ limit: "16kb" }));

// Allocation Service routes
app.use("/api/allocation", routes);

// Handle unknown routes
app.use((req, res, next) =>
  next(new ApiError(404, "NOT_FOUND", "Route not found."))
);

// Centralized error handling
app.use((err, req, res, next) => {
  let status = 500;
  let code = "INTERNAL_ERROR";
  let message = "An unexpected error occurred.";

  if (err instanceof ApiError) {
    ({ status, code, message } = err);

  } else if (err.type === "entity.parse.failed") {
    status = 400;
    code = "INVALID_JSON";
    message = "Malformed JSON.";

  } else if (err.type === "entity.too.large") {
    status = 413;
    code = "BODY_TOO_LARGE";
    message = "Body too large.";

  } else {
    console.error(
      JSON.stringify({
        event: "error",
        name: err.name,
      })
    );
  }

  res.status(status).json({
    success: false,
    error: { code, message },
  });
});

module.exports = app;
