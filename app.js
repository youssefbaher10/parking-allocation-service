require("dotenv").config({ quiet: true });
const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const { rateLimit } = require("express-rate-limit");
const { secret } = require("./src/middleware/auth");
const { ApiError } = require("./src/services/errors");
const routes = require("./src/routes/requestRoutes");
const app = express();
secret("AUTH_SECRET");
secret("INTERNAL_TOKEN");
if (process.env.AUTH_SECRET === process.env.INTERNAL_TOKEN)
  throw new Error("Use separate secrets for users and service calls.");
if (!["sample", "http"].includes(process.env.INVENTORY_MODE))
  throw new Error("Set INVENTORY_MODE to sample or http.");
if (
  process.env.INVENTORY_MODE === "http" &&
  (!process.env.INVENTORY_URL || !process.env.INVENTORY_TOKEN)
) {
  throw new Error("Set INVENTORY_URL and INVENTORY_TOKEN for Ahmed's API.");
}
app.disable("x-powered-by");
app.use(helmet());
app.use(cors({ origin: process.env.FRONTEND_ORIGIN || false }));
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
        }),
      );
    }
  });
  next();
});
app.get("/", (req, res) =>
  res.json({ message: "Parking Allocation Service is running!" }),
);
app.get("/health", (req, res) =>
  res.json({ status: "ok", service: "parking-allocation-service" }),
);
app.use(
  "/api",
  rateLimit({
    windowMs: 60000,
    limit: Number(process.env.RATE_LIMIT || 120),
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: {
      success: false,
      error: { code: "RATE_LIMITED", message: "Try again in one minute." },
    },
  }),
);
app.use((req, res, next) => {
  const hasBody =
    Number(req.get("content-length")) > 0 || req.get("transfer-encoding");
  if (hasBody && !req.is("application/json"))
    return next(
      new ApiError(415, "UNSUPPORTED_MEDIA", "Use application/json."),
    );
  next();
});
app.use(express.json({ limit: "16kb" }));
app.use("/api/allocation", routes);
app.use((req, res, next) =>
  next(new ApiError(404, "NOT_FOUND", "Route not found.")),
);
app.use((err, req, res, next) => {
  let status = 500,
    code = "INTERNAL_ERROR",
    message = "An unexpected error occurred.";
  if (err instanceof ApiError) ({ status, code, message } = err);
  else if (err.type === "entity.parse.failed") {
    status = 400;
    code = "INVALID_JSON";
    message = "Malformed JSON.";
  } else if (err.type === "entity.too.large") {
    status = 413;
    code = "BODY_TOO_LARGE";
    message = "Body too large.";
  } else console.error(JSON.stringify({ event: "error", name: err.name }));
  res.status(status).json({ success: false, error: { code, message } });
});
module.exports = app;
