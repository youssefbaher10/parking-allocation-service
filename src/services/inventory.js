const { ApiError } = require("./errors");
// Ahmed owns the catalogue. Allocation owns all reservation time windows.
const sample = [
  { spot_id: "A1", zone_id: "zone_1", spot_type: "standard", active: true },
  { spot_id: "A2", zone_id: "zone_1", spot_type: "accessible", active: true },
];
async function spotsFor(request) {
  let rows;
  if (process.env.INVENTORY_MODE === "sample") rows = sample;
  else {
    try {
      const url = new URL("/api/inventory/spots", process.env.INVENTORY_URL);
      url.searchParams.set("zone_id", request.zone_id);
      url.searchParams.set("spot_type", request.spot_type);
      const response = await fetch(url, {
        headers: { Authorization: "Bearer " + process.env.INVENTORY_TOKEN },
        redirect: "error",
        signal: AbortSignal.timeout(3500),
      });
      if (!response.ok) throw new Error();
      const body = await response.json();
      rows = body.data;
      if (
        !Array.isArray(rows) ||
        !rows.every(
          (s) =>
            s &&
            typeof s.spot_id === "string" &&
            s.spot_id.length &&
            typeof s.active === "boolean" &&
            typeof s.zone_id === "string" &&
            typeof s.spot_type === "string",
        )
      )
        throw new Error();
    } catch {
      throw new ApiError(
        503,
        "INVENTORY_UNAVAILABLE",
        "Cannot read parking spots from Inventory.",
      );
    }
  }
  return [
    ...new Set(
      rows
        .filter(
          (s) =>
            s.active &&
            s.zone_id === request.zone_id &&
            s.spot_type === request.spot_type,
        )
        .map((s) => s.spot_id),
    ),
  ].sort();
}
module.exports = { spotsFor };
