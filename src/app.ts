import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import fs from 'node:fs';
import { env } from './config/env';
import { errorHandler, notFoundHandler } from './middleware/error-handler';
import { requestLogger } from './middleware/request-context';
import { authRouter } from './modules/auth/auth.routes';
import { usersRouter } from './modules/users/users.routes';
import { portalsRouter } from './modules/portals/portals.routes';
import { proxiesRouter } from './modules/proxies/proxies.routes';
import { filtersRouter } from './modules/filters/filters.routes';
import { resumesRouter } from './modules/resumes/resumes.routes';
import { applicationsRouter } from './modules/applications/applications.routes';
import { runsRouter } from './modules/runs/runs.routes';
import { exceptionsRouter } from './modules/exceptions/exceptions.routes';
import { statsRouter } from './modules/stats/stats.routes';
import { reportsRouter } from './modules/reports/reports.routes';
import { workerRouter } from './modules/worker/worker.routes';
import { getPool } from './db/pool';

export function createApp(): express.Express {
  for (const dir of [env.storage.resumes, env.storage.sessions, env.storage.reports]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const app = express();

  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(
    cors({
      origin: env.corsOrigins.length > 0 ? env.corsOrigins : false,
      credentials: true,
    }),
  );
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use(requestLogger);

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', env: env.nodeEnv, time: new Date().toISOString() });
  });

  app.get('/health/ready', async (_req, res) => {
    try {
      await getPool().query('SELECT 1');
      res.json({ status: 'ready' });
    } catch {
      res.status(503).json({ status: 'db_unavailable' });
    }
  });

  // Machine-to-machine, and mounted BEFORE the dashboard router. That order is load-bearing:
  // several dashboard routers are mounted at '/' and apply `requireMember` via `router.use`,
  // so they match any path under the base path — including /worker/* — and would reject
  // worker requests with a member-auth 401 before routing ever reached this mount.
  //
  // Separate mount also means no shared rate limiter: a worker polling for work cannot
  // exhaust the dashboard's budget, or vice versa.
  app.use(`${env.apiBasePath}/worker`, workerRouter);

  const api = express.Router();

  // Ops dashboard surface. Rate-limited as a whole; the login route adds a tighter limit
  // of its own.
  api.use(
    rateLimit({
      windowMs: 60 * 1000,
      limit: 300,
      standardHeaders: true,
      legacyHeaders: false,
    }),
  );

  api.use('/auth', authRouter);
  api.use('/users', usersRouter);
  api.use('/applications', applicationsRouter);
  api.use('/runs', runsRouter);
  api.use('/exceptions', exceptionsRouter);
  api.use('/proxies', proxiesRouter);
  api.use('/stats', statsRouter);

  // These mount routes under both /users/:userId/... and their own resource path, so they
  // sit at the API root rather than under a single prefix.
  //
  // Consequence worth knowing: each of these routers applies `requireMember` via
  // `router.use`, and they are mounted at '/', so an *unauthenticated* request to an
  // unknown API path is rejected with 401 before routing decides it is a 404. That is the
  // intended order — it keeps route existence from being probed without credentials.
  // Authenticated requests to unknown paths still get a normal 404.
  api.use('/', portalsRouter);
  api.use('/', filtersRouter);
  api.use('/', resumesRouter);
  api.use('/', reportsRouter);

  app.use(env.apiBasePath, api);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
