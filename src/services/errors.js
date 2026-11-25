class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
function invalid(message) {
  throw new ApiError(400, "INVALID_INPUT", message);
}
function conflict(message) {
  throw new ApiError(409, "CONFLICT", message);
}
module.exports = { ApiError, invalid, conflict };
