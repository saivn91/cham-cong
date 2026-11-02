import { Hono } from 'hono';
import { cors } from 'hono/cors';

export type Env = {
  Bindings: {
    SUPABASE_URL: string;
    SUPABASE_ANON_KEY: string;
    SUPABASE_SERVICE_ROLE_KEY: string;
    ALLOWED_ORIGIN?: string;
  };
};

const app = new Hono<Env>();

app.use(
  '/api/*',
  cors({
    origin: (origin, c) => {
      const allowedOrigin = c.env.ALLOWED_ORIGIN;
      if (!allowedOrigin) return origin;
      return origin === allowedOrigin ? origin : allowedOrigin;
    },
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    exposeHeaders: ['Content-Length'],
    maxAge: 86400,
    credentials: true,
  }),
);

app.get('/api/health', (c) => {
  return c.json({
    ok: true,
    service: 'timekeeping-worker',
    timestamp: new Date().toISOString(),
  });
});

// Reserved for the 5 privileged endpoints requiring service_role in upcoming phases.

export default app;
