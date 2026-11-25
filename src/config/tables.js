// The fourth table holds the tariff and a small version counter used by all workers.
module.exports = {
  requests: {
    name: process.env.PARKING_REQUESTS_TABLE || "ParkingRequests",
    key: "request_id",
  },
  reservations: {
    name: process.env.RESERVATIONS_TABLE || "Reservations",
    key: "reservation_id",
  },
  waiting: {
    name: process.env.WAITLIST_TABLE || "ParkingWaitlist",
    key: "request_id",
  },
  rules: { name: process.env.PRICING_TABLE || "PricingRules", key: "rule_id" },
};
