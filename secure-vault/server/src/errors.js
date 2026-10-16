export const httpError = (statusCode, message, extra = {}) =>
  Object.assign(new Error(message), { statusCode, extra });
