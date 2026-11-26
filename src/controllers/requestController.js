
const service = require("../services/requestService");
const { only } = require("../services/rules");
const { adminAssign } = require("../services/assignment");

// Keep internal idempotency metadata out of API responses.
function publicRow(row) {
  if (Array.isArray(row)) return row.map(publicRow);
  const { signature, ...data } = row;
  return data;
}

function send(res, data, status = 200) {
  res.status(status).json({
    success: true,
    data: publicRow(data),
  });
}

module.exports = {
  async create(req, res) {
    send(
      res,
      await service.submit(
        req.body,
        req.actor,
        req.get("Idempotency-Key"),
      ),
      201,
    );
  },

  async list(req, res) {
    send(res, await service.requests(req.actor, req.query));
  },

  async read(req, res) {
    send(res, await service.owned("requests", req.params.id, req.actor));
  },

  async edit(req, res) {
    send(res, await service.edit(req.params.id, req.body, req.actor));
  },

  async cancel(req, res) {
    send(
      res,
      await service.closeRequest(req.params.id, req.actor, "cancelled"),
    );
  },

  async reservation(req, res) {
    send(res, await service.owned("reservations", req.params.id, req.actor));
  },

  async cancelReservation(req, res) {
    send(res, await service.cancelReservation(req.params.id, req.actor));
  },

  async renew(req, res) {
    send(res, await service.renew(req.params.id, req.body, req.actor));
  },

  async waitlist(req, res) {
    send(res, await service.queue(req.actor));
  },

  async quote(req, res) {
    send(res, await service.price(req.body));
  },

  async validity(req, res) {
    send(res, await service.validity(req.params.id));
  },

  // Lookup an active reservation by vehicle plate and parking spot.
  async lookupReservation(req, res) {
    send(res, await service.lookupReservation(req.query));
  },

  async assign(req, res) {
    only(req.body, ["spot_id"]);
    send(res, await adminAssign(req.params.id, req.body.spot_id, req.actor));
  },

  async maintain(req, res) {
    send(res, await service.sweep());
  },
};
