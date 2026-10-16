// 帳號密碼等項目。每筆 data 都是 iPhone 端用資料金鑰加密後的密文，
// 伺服器看不到網站名稱、帳號或密碼，只負責保存與同步。
import { z } from 'zod';
import { parse, uuid, b64, MAX_ITEM_BYTES, MIN_SEALED } from '../validation.js';
import { withTx } from '../db.js';
import { httpError } from '../errors.js';

const out = (r) => ({
  id: r.id, data: r.data.toString('base64'), revision: r.revision, updatedAt: r.updated_at,
});

export default async function itemRoutes(app, { pool }) {
  const authed = { preHandler: app.authenticate };

  app.get('/api/items', authed, async (req) => {
    const { rows } = await pool.query(
      'SELECT id, data, revision, updated_at FROM items WHERE user_id = $1 ORDER BY updated_at',
      [req.user.id],
    );
    return { items: rows.map(out) };
  });

  // 新增或更新。revision 用來避免兩台裝置同時修改時互相覆蓋（新項目傳 0）。
  app.put('/api/items/:id', authed, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const body = parse(
      z.object({ data: b64(MIN_SEALED, MAX_ITEM_BYTES), revision: z.number().int().min(0) }),
      req.body,
    );
    return withTx(pool, async (db) => {
      const { rows } = await db.query('SELECT user_id, revision FROM items WHERE id = $1 FOR UPDATE', [id]);
      const existing = rows[0];
      if (existing && existing.user_id !== req.user.id) throw httpError(404, '找不到項目');
      if ((existing?.revision ?? 0) !== body.revision) {
        throw httpError(409, '項目已在其他裝置被修改，請重新同步', { currentRevision: existing?.revision ?? 0 });
      }
      const res = existing
        ? await db.query(
            `UPDATE items SET data = $2, revision = revision + 1, updated_at = now()
             WHERE id = $1 RETURNING id, data, revision, updated_at`,
            [id, body.data],
          )
        : await db.query(
            `INSERT INTO items (id, user_id, data, revision) VALUES ($1, $2, $3, 1)
             RETURNING id, data, revision, updated_at`,
            [id, req.user.id, body.data],
          );
      return out(res.rows[0]);
    });
  });

  app.delete('/api/items/:id', authed, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const r = await pool.query('DELETE FROM items WHERE id = $1 AND user_id = $2', [id, req.user.id]);
    if (r.rowCount === 0) throw httpError(404, '找不到項目');
    return { ok: true };
  });
}
