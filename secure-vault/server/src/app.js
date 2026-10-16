import Fastify from 'fastify';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { createPool, migrate } from './db.js';
import { makeSecretBox, sha256 } from './secrets.js';
import { createStorage } from './storage.js';
import { httpError } from './errors.js';
import authRoutes from './routes/auth.js';
import itemRoutes from './routes/items.js';
import fileRoutes from './routes/files.js';

export async function buildApp(cfg, { logger = true } = {}) {
  const app = Fastify({
    trustProxy: cfg.trustProxy, // Zeabur 前面有反向代理，要取得真實 IP 才能正確限流
    bodyLimit: 256 * 1024,
    logger: logger && {
      // 絕不把 token 寫進日誌
      redact: ['req.headers.authorization'],
    },
  });

  const pool = createPool(cfg.databaseUrl);
  await migrate(pool);
  app.addHook('onClose', () => pool.end());

  const box = makeSecretBox(cfg.serverSecret);
  const storage = createStorage(cfg.s3);

  await app.register(helmet);
  await app.register(rateLimit, { global: true, max: 300, timeWindow: '1 minute' });

  app.setErrorHandler((err, req, reply) => {
    let status = err.statusCode ?? 500;
    if (err.validation) status = 400;
    if (status >= 500) req.log.error(err);
    reply.code(status).send({
      error: status >= 500 ? '伺服器錯誤' : status === 429 && !err.extra ? '請求太頻繁，請稍後再試' : err.message,
      ...err.extra,
    });
  });

  // 登入驗證：Authorization: Bearer <token>，資料庫只比對 token 的 SHA-256。
  app.decorate('authenticate', async (req) => {
    const m = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization ?? '');
    if (!m) throw httpError(401, '請重新登入');
    const { rows } = await pool.query(
      `UPDATE sessions SET last_used_at = now()
       WHERE token_hash = $1 AND expires_at > now()
       RETURNING id, user_id`,
      [sha256(m[1])],
    );
    if (!rows[0]) throw httpError(401, '請重新登入');
    req.session = { id: rows[0].id };
    req.user = { id: rows[0].user_id };
  });

  app.addHook('onSend', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
  });

  app.get('/health', async () => ({ ok: true }));

  const deps = { cfg, pool, box, storage };
  await app.register(authRoutes, deps);
  await app.register(itemRoutes, deps);
  await app.register(fileRoutes, deps);

  return app;
}
