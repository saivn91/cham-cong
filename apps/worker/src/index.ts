import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import type { AppEnv } from './env';
import { devices } from './routes/devices';
import { employees } from './routes/employees;

const app = new Hono<AppEnv>();

cosnt allowedOrigins = (value?: string) =>
  (value ?? 'http://localhost:5173').split(',').map((v) => v.trim()).filter(Boolean);
  
app.use(
  '/api/*',
  cors({
    origin: (origin, c) => (allowedOrigins(c.env.ALLOWED_ORIGIN).includes(origin) ? origin : ''),
    allowedMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    exposeHeaders: ['Content-Length'],
    maxAge: 86400,
    credentials: true,
  }),
);

// Công khai, dùng cho giám sát uptime.
app.get('/api/health', (c) => c.json({ok: true, service: 'timekepping-worker', timestamp: new Date().toISOString()}));
app.route('/api/employees', employees);
app.route('/api/devices', devices);

// HTTPException mang mã lỗi nghiệp vụ; lỗi khác ẩn chi tiết để không lộ thông tin nội bộ.
app.onError((error, c) => {
  if(error instanceof HTTPException) return c.json({ error: error.message, details: error.cause }, error.status);
  console.error(error);
  return c.json({error: 'INTERNAL_SERVER_ERROR'}, 500);
});















