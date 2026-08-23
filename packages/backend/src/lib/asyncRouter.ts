import { Router, type IRouter, type RequestHandler } from 'express';
import { Types } from 'mongoose';

// Express 4 does not catch rejections from async handlers. An unhandled one
// never sends a response, so the caller just hangs until it times out — which
// is worse than a 500, because it looks like the server is unreachable.
// Wrapping every handler routes those rejections to the error middleware.
const wrap = (fn: RequestHandler): RequestHandler => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

export function asyncRouter(): IRouter {
  const router = Router();
  for (const method of ['get', 'post', 'put', 'patch', 'delete'] as const) {
    const original = router[method].bind(router);
    (router as any)[method] = (path: any, ...handlers: RequestHandler[]) =>
      original(path, ...handlers.map(wrap));
  }
  return router;
}

// Mongoose throws a CastError on a malformed id rather than returning null, so
// a mistyped session id has to be rejected before it reaches a query.
export const isObjectId = (value: unknown): value is string =>
  typeof value === 'string' && Types.ObjectId.isValid(value) && String(new Types.ObjectId(value)) === value;

export const requireObjectIdParam = (param = 'id'): RequestHandler => (req, res, next) => {
  if (!isObjectId(req.params[param])) {
    return res.status(404).json({ error: 'Not found' });
  }
  next();
};
