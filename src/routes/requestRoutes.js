
const express = require("express");
const c = require("../controllers/requestController");
const auth = require("../middleware/auth");

const router = express.Router();

// Internal service authentication
router.get(
  "/internal/reservations/:id/validity",
  auth.internal,
  c.validity
);

// Cognito login
router.post("/auth/login", auth.login);

// Require authentication for protected routes
router.use(auth.user);

// Parking requests
router.post("/requests", c.create);
router.get("/requests", c.list);
router.get("/requests/:id", c.read);
router.patch("/requests/:id", c.edit);
router.post("/requests/:id/cancel", c.cancel);

// Administrator assignment
router.post("/requests/:id/assign", auth.admin, c.assign);

// Reservations
router.get("/reservations/:id", c.reservation);
router.patch("/reservations/:id/cancel", c.cancelReservation);
router.post("/reservations/:id/renew", c.renew);

// Waitlist
router.get("/waitlist/me", c.waitlist);

// Dynamic pricing
router.post("/pricing/quote", c.quote);

// Administrator maintenance
router.post("/admin/maintenance", auth.admin, c.maintain);

module.exports = router;
