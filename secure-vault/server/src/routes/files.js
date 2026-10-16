// 照片與影片。iPhone 把檔案切成 4MB 區塊，每塊各自加密後直接上傳到 R2；
// 伺服器只記錄「加密後的中繼資料」與每塊大小，看不到檔名、內容或縮圖。
import { z } from 'zod';
import {
  parse, uuid, b64, MIN_SEALED, MAX_CHUNK_BYTES, MAX_THUMB_BYTES,
} from '../validation.js';
import { withTx } from '../db.js';
import { httpError } from '../errors.js';

const MAX_URLS_PER_REQUEST = 100;
const PENDING_TTL_HOURS = 24;

// 空檔案加密後也有 40 bytes（nonce + 驗證碼）
const sealedSize = z.number().int().min(40);
const indices = z.array(z.number().int().min(0)).max(MAX_URLS_PER_REQUEST).default([]);

const out = (f) => ({
  id: f.id,
  meta: f.meta.toString('base64'),
  chunkSizes: f.chunk_sizes,
  hasThumb: f.thumb_size !== null,
  totalSize: Number(f.total_size),
  createdAt: f.created_at,
});

export default async function fileRoutes(app, { cfg, pool, storage }) {
  const authed = { preHandler: app.authenticate };

  async function getFile(userId, id, status) {
    const { rows } = await pool.query(
      'SELECT * FROM files WHERE id = $1 AND user_id = $2 AND status = $3',
      [id, userId, status],
    );
    if (!rows[0]) throw httpError(404, '找不到檔案');
    return rows[0];
  }

  function checkIndices(file, list) {
    if (list.some((i) => i >= file.chunk_sizes.length)) throw httpError(400, '區塊編號不正確');
  }

  app.get('/api/files', authed, async (req) => {
    const { rows } = await pool.query(
      `SELECT * FROM files WHERE user_id = $1 AND status = 'ready' ORDER BY created_at DESC`,
      [req.user.id],
    );
    return { files: rows.map(out) };
  });

  // 建立上傳：先申報每塊加密後的大小，伺服器據此檢查容量並簽發「大小固定」的上傳網址。
  app.post('/api/files', authed, async (req, reply) => {
    const body = parse(
      z.object({
        id: uuid,
        meta: b64(MIN_SEALED, 8 * 1024),
        chunkSizes: z.array(sealedSize.max(MAX_CHUNK_BYTES)).min(1),
        thumbSize: sealedSize.max(MAX_THUMB_BYTES).optional(),
      }),
      req.body,
    );
    const total = body.chunkSizes.reduce((a, b) => a + b, 0) + (body.thumbSize ?? 0);
    if (total > cfg.maxFileBytes) throw httpError(413, '檔案太大');

    await withTx(pool, async (db) => {
      // 鎖住使用者，避免同時上傳多個檔案時繞過容量限制
      await db.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [req.user.id]);
      const { rows } = await db.query(
        'SELECT COALESCE(sum(total_size), 0)::bigint AS used FROM files WHERE user_id = $1',
        [req.user.id],
      );
      if (Number(rows[0].used) + total > cfg.maxStorageBytes) throw httpError(413, '儲存空間不足');
      const r = await db.query(
        `INSERT INTO files (id, user_id, meta, chunk_sizes, thumb_size, total_size)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING`,
        [body.id, req.user.id, body.meta, body.chunkSizes, body.thumbSize ?? null, total],
      );
      if (r.rowCount === 0) throw httpError(409, '檔案 ID 重複');
    });
    reply.code(201);
    return { id: body.id };
  });

  // 取得上傳網址（可分批、也可在中斷後重新取得以續傳）。
  app.post('/api/files/:id/upload-urls', authed, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const body = parse(z.object({ chunks: indices, thumb: z.boolean().default(false) }), req.body);
    const file = await getFile(req.user.id, id, 'pending');
    checkIndices(file, body.chunks);
    const chunks = await Promise.all(
      body.chunks.map(async (i) => ({
        index: i,
        url: await storage.presignPut(storage.chunkKey(req.user.id, id, i), file.chunk_sizes[i]),
      })),
    );
    const thumb =
      body.thumb && file.thumb_size !== null
        ? await storage.presignPut(storage.thumbKey(req.user.id, id), file.thumb_size)
        : null;
    return { chunks, thumb };
  });

  // 上傳完成：伺服器向 R2 確認每一塊都存在且大小正確，才標記為可用。
  app.post('/api/files/:id/complete', authed, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const file = await getFile(req.user.id, id, 'pending');
    const sizes = await storage.listSizes(req.user.id, id);
    const missing = file.chunk_sizes
      .map((size, i) => (sizes.get(storage.chunkKey(req.user.id, id, i)) === size ? null : i))
      .filter((i) => i !== null);
    const thumbOk =
      file.thumb_size === null || sizes.get(storage.thumbKey(req.user.id, id)) === file.thumb_size;
    if (missing.length || !thumbOk) {
      throw httpError(400, '檔案尚未完整上傳', { missingChunks: missing, thumbMissing: !thumbOk });
    }
    await pool.query(`UPDATE files SET status = 'ready' WHERE id = $1`, [id]);
    return out({ ...file, status: 'ready' });
  });

  app.post('/api/files/:id/download-urls', authed, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const body = parse(z.object({ chunks: indices, thumb: z.boolean().default(false) }), req.body);
    const file = await getFile(req.user.id, id, 'ready');
    checkIndices(file, body.chunks);
    const chunks = await Promise.all(
      body.chunks.map(async (i) => ({
        index: i, url: await storage.presignGet(storage.chunkKey(req.user.id, id, i)),
      })),
    );
    const thumb =
      body.thumb && file.thumb_size !== null
        ? await storage.presignGet(storage.thumbKey(req.user.id, id))
        : null;
    return { chunks, thumb };
  });

  app.delete('/api/files/:id', authed, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const { rows } = await pool.query('SELECT id FROM files WHERE id = $1 AND user_id = $2', [id, req.user.id]);
    if (!rows[0]) throw httpError(404, '找不到檔案');
    await storage.deleteFile(req.user.id, id);
    await pool.query('DELETE FROM files WHERE id = $1', [id]);
    return { ok: true };
  });

  // 定期清除 24 小時內沒有完成的上傳，釋放空間與容量額度。
  async function cleanupPending() {
    const { rows } = await pool.query(
      `SELECT id, user_id FROM files WHERE status = 'pending'
       AND created_at < now() - make_interval(hours => $1)`,
      [PENDING_TTL_HOURS],
    );
    for (const f of rows) {
      await storage.deleteFile(f.user_id, f.id);
      await pool.query('DELETE FROM files WHERE id = $1', [f.id]);
    }
  }
  const timer = setInterval(() => cleanupPending().catch((e) => app.log.error(e)), 3600_000);
  timer.unref();
  app.addHook('onClose', async () => clearInterval(timer));
}
