import type { Request, Response, NextFunction, ErrorRequestHandler, RequestHandler } from 'express';

/**
 * Express 4 does not catch a rejected promise from a route handler: an `async` handler that
 * throws after its first `await` leaves the request HANGING (the client waits for its timeout)
 * and the error surfaces only as an "unhandled rejection" in the server log. Every async route
 * goes through this, which hands the error to `apiErrorHandler` like a synchronous throw.
 */
export function asyncRoute<P extends Record<string, string> = Record<string, string>>(
  fn: (req: Request<P>, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler<P> {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

/**
 * The last middleware: an error no route answered becomes a JSON 500 with its message — what
 * every client of this API parses — instead of Express's default HTML page with a stack trace.
 */
export const apiErrorHandler: ErrorRequestHandler = (err, req, res, next) => {
  console.error(`[api] ${req.method} ${req.originalUrl} failed:`, err);
  if (res.headersSent) return next(err);
  const status = typeof err?.status === 'number' && err.status >= 400 && err.status < 600 ? err.status : 500;
  res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
};
