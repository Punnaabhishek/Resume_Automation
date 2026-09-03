export class AppError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (message: string, details?: unknown) => new AppError(400, message, 'bad_request', details);
export const unauthorized = (message = 'Authentication required') => new AppError(401, message, 'unauthorized');
export const forbidden = (message = 'Not permitted') => new AppError(403, message, 'forbidden');
export const notFound = (what = 'Resource') => new AppError(404, `${what} not found`, 'not_found');
export const conflict = (message: string, details?: unknown) => new AppError(409, message, 'conflict', details);
export const unprocessable = (message: string, details?: unknown) => new AppError(422, message, 'unprocessable', details);
