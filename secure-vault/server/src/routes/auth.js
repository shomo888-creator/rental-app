import { z } from 'zod';
import * as OTPAuth from 'otpauth';
import {
  parse, email, uuid, authKey, wrappedKey, kdf, totpCode, deviceName, DEFAULT_KDF,
} from '../validation.js';
import { hashAuthKey, verifyAuthKey, newSessionToken, sha256, timingSafeEqualStr } from '../secrets.js';
import { withTx } from '../db.js';
import { httpError } from '../errors.js';

const LOGIN_FAIL = '帳號或密碼錯誤';
const MAX_FAILS_BEFORE_LOCK = 5;

// 交易內若直接 throw 會 ROLLBACK，連失敗次數也一起被還原。
// 所以失敗時回傳 fail(...)，等交易 COMMIT 之後才丟出錯誤。
const FAIL = Symbol('fail');
const fail = (...args) => ({ [FAIL]: httpError(...args) });

export default async function authRoutes(app, { cfg, pool, box }) {
  // 敏感端點：每個 IP 每分鐘最多 cfg.authRateLimit 次（預設 10）
  const strict = { config: { rateLimit: { max: cfg.authRateLimit, timeWindow: '1 minute' } } };

  async function tx(fn) {
    const r = await withTx(pool, fn);
    if (r?.[FAIL]) throw r[FAIL];
    return r;
  }

  const totpFor = (secretB32, label) =>
    new OTPAuth.TOTP({
      issuer: 'SecureVault', label, algorithm: 'SHA1', digits: 6, period: 30,
      secret: OTPAuth.Secret.fromBase32(secretB32),
    });

  // 驗證 TOTP 並防止同一組驗證碼被重複使用。
  async function checkTotp(db, user, code) {
    const delta = totpFor(box.open(user.totp_secret_enc), user.email).validate({ token: code, window: 1 });
    if (delta === null) return false;
    const step = Math.floor(Date.now() / 30000) + delta;
    const r = await db.query(
      'UPDATE users SET totp_last_step = $2 WHERE id = $1 AND totp_last_step < $2',
      [user.id, step],
    );
    return r.rowCount === 1;
  }

  async function recordFailure(db, user) {
    const fails = user.failed_logins + 1;
    const lockMs =
      fails >= MAX_FAILS_BEFORE_LOCK
        ? Math.min(15 * 60_000 * 2 ** (fails - MAX_FAILS_BEFORE_LOCK), 24 * 3600_000)
        : 0;
    await db.query(
      'UPDATE users SET failed_logins = $2, locked_until = $3 WHERE id = $1',
      [user.id, fails, lockMs ? new Date(Date.now() + lockMs) : null],
    );
  }

  // 共用的身分驗證流程：帳號鎖定檢查 → 驗證金鑰 → 失敗計數。
  async function verifyUser(db, emailAddr, key, hashField) {
    const { rows } = await db.query('SELECT * FROM users WHERE email = $1 FOR UPDATE', [emailAddr]);
    const user = rows[0];
    if (user?.locked_until && user.locked_until > new Date()) {
      throw httpError(429, '嘗試次數過多，帳號暫時鎖定，請稍後再試');
    }
    const ok = await verifyAuthKey(user?.[hashField], key);
    if (!ok) {
      if (user) await recordFailure(db, user);
      return null;
    }
    return user;
  }

  async function createSession(db, userId, device) {
    const token = newSessionToken();
    await db.query(
      `INSERT INTO sessions (user_id, token_hash, device_name, expires_at)
       VALUES ($1, $2, $3, now() + make_interval(days => $4))`,
      [userId, sha256(token), device, cfg.sessionTtlDays],
    );
    return token;
  }

  const kdfOut = (u) => ({ salt: u.kdf_salt.toString('base64'), ops: u.kdf_ops, mem: u.kdf_mem });

  // 登入第一步：取得 Argon2id 參數。帳號不存在時回傳假的 salt，不洩漏帳號是否存在。
  app.post('/api/auth/prelogin', strict, async (req) => {
    const body = parse(z.object({ email }), req.body);
    const { rows } = await pool.query('SELECT kdf_salt, kdf_ops, kdf_mem FROM users WHERE email = $1', [body.email]);
    if (rows[0]) return { kdf: kdfOut(rows[0]) };
    return { kdf: { salt: box.fakeSalt(body.email).toString('base64'), ...DEFAULT_KDF } };
  });

  app.post('/api/auth/register', strict, async (req, reply) => {
    if (!cfg.registrationCode) throw httpError(403, '註冊功能已關閉');
    const body = parse(
      z.object({
        email, registrationCode: z.string().max(200), authKey, kdf,
        protectedVaultKey: wrappedKey, recoveryAuthKey: authKey, recoveryProtectedVaultKey: wrappedKey,
      }),
      req.body,
    );
    if (!timingSafeEqualStr(body.registrationCode, cfg.registrationCode)) {
      throw httpError(403, '註冊碼錯誤');
    }
    const [authHash, recoveryHash] = await Promise.all([
      hashAuthKey(body.authKey), hashAuthKey(body.recoveryAuthKey),
    ]);
    const r = await pool.query(
      `INSERT INTO users (email, kdf_salt, kdf_ops, kdf_mem, auth_hash, protected_vault_key,
                          recovery_auth_hash, recovery_protected_vault_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (email) DO NOTHING`,
      [body.email, body.kdf.salt, body.kdf.ops, body.kdf.mem, authHash,
        body.protectedVaultKey, recoveryHash, body.recoveryProtectedVaultKey],
    );
    if (r.rowCount === 0) throw httpError(409, '此帳號已存在');
    reply.code(201);
    return { ok: true };
  });

  app.post('/api/auth/login', strict, async (req) => {
    const body = parse(z.object({ email, authKey, totp: totpCode.optional(), deviceName }), req.body);
    return tx(async (db) => {
      const user = await verifyUser(db, body.email, body.authKey, 'auth_hash');
      if (!user) return fail(401, LOGIN_FAIL);
      if (user.totp_secret_enc) {
        if (!body.totp) throw httpError(401, '請輸入兩步驟驗證碼', { totpRequired: true });
        if (!(await checkTotp(db, user, body.totp))) {
          await recordFailure(db, user);
          return fail(401, '驗證碼錯誤', { totpRequired: true });
        }
      }
      await db.query('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = $1', [user.id]);
      const token = await createSession(db, user.id, body.deviceName);
      return {
        token,
        protectedVaultKey: user.protected_vault_key.toString('base64'),
        kdf: kdfOut(user),
        totpEnabled: !!user.totp_secret_enc,
      };
    });
  });

  // 用復原金鑰找回帳號（忘記主密碼時）。第一步：取回被復原金鑰包起來的資料金鑰。
  app.post('/api/auth/recover/start', strict, async (req) => {
    const body = parse(z.object({ email, recoveryAuthKey: authKey }), req.body);
    return tx(async (db) => {
      const user = await verifyUser(db, body.email, body.recoveryAuthKey, 'recovery_auth_hash');
      if (!user) return fail(401, '復原金鑰錯誤');
      return { recoveryProtectedVaultKey: user.recovery_protected_vault_key.toString('base64') };
    });
  });

  // 第二步：設定新主密碼。會登出所有裝置並關閉兩步驟驗證（遺失手機時才能救回帳號）。
  app.post('/api/auth/recover/finish', strict, async (req) => {
    const body = parse(
      z.object({ email, recoveryAuthKey: authKey, newAuthKey: authKey, newKdf: kdf, newProtectedVaultKey: wrappedKey }),
      req.body,
    );
    const newHash = await hashAuthKey(body.newAuthKey);
    return tx(async (db) => {
      const user = await verifyUser(db, body.email, body.recoveryAuthKey, 'recovery_auth_hash');
      if (!user) return fail(401, '復原金鑰錯誤');
      await db.query(
        `UPDATE users SET auth_hash=$2, kdf_salt=$3, kdf_ops=$4, kdf_mem=$5, protected_vault_key=$6,
                totp_secret_enc=NULL, totp_pending_enc=NULL, failed_logins=0, locked_until=NULL
         WHERE id=$1`,
        [user.id, newHash, body.newKdf.salt, body.newKdf.ops, body.newKdf.mem, body.newProtectedVaultKey],
      );
      await db.query('DELETE FROM sessions WHERE user_id = $1', [user.id]);
      return { ok: true };
    });
  });

  // ---- 以下需要登入 ----
  const authed = { preHandler: app.authenticate };
  const authedStrict = { ...strict, preHandler: app.authenticate };

  app.get('/api/account', authed, async (req) => {
    const { rows } = await pool.query(
      `SELECT u.email, u.totp_secret_enc IS NOT NULL AS totp_enabled,
              COALESCE((SELECT sum(total_size) FROM files WHERE user_id = u.id), 0)::bigint AS used
       FROM users u WHERE u.id = $1`,
      [req.user.id],
    );
    return {
      email: rows[0].email,
      totpEnabled: rows[0].totp_enabled,
      storageUsed: Number(rows[0].used),
      storageLimit: cfg.maxStorageBytes,
    };
  });

  app.post('/api/auth/logout', authed, async (req) => {
    await pool.query('DELETE FROM sessions WHERE id = $1', [req.session.id]);
    return { ok: true };
  });

  app.post('/api/auth/logout-all', authed, async (req) => {
    await pool.query('DELETE FROM sessions WHERE user_id = $1', [req.user.id]);
    return { ok: true };
  });

  app.get('/api/auth/sessions', authed, async (req) => {
    const { rows } = await pool.query(
      'SELECT id, device_name, created_at, last_used_at FROM sessions WHERE user_id = $1 ORDER BY last_used_at DESC',
      [req.user.id],
    );
    return {
      sessions: rows.map((s) => ({
        id: s.id, deviceName: s.device_name, createdAt: s.created_at,
        lastUsedAt: s.last_used_at, current: s.id === req.session.id,
      })),
    };
  });

  app.delete('/api/auth/sessions/:id', authed, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    await pool.query('DELETE FROM sessions WHERE id = $1 AND user_id = $2', [id, req.user.id]);
    return { ok: true };
  });

  // 變更主密碼：資料金鑰不變，所以不需要重新加密所有資料。其他裝置會被登出。
  app.post('/api/auth/change-password', authedStrict, async (req) => {
    const body = parse(
      z.object({ currentAuthKey: authKey, newAuthKey: authKey, newKdf: kdf, newProtectedVaultKey: wrappedKey }),
      req.body,
    );
    const newHash = await hashAuthKey(body.newAuthKey);
    return tx(async (db) => {
      const { rows } = await db.query('SELECT email FROM users WHERE id = $1', [req.user.id]);
      const user = await verifyUser(db, rows[0].email, body.currentAuthKey, 'auth_hash');
      if (!user) return fail(403, '目前的主密碼錯誤');
      await db.query(
        `UPDATE users SET auth_hash=$2, kdf_salt=$3, kdf_ops=$4, kdf_mem=$5, protected_vault_key=$6,
                failed_logins=0 WHERE id=$1`,
        [user.id, newHash, body.newKdf.salt, body.newKdf.ops, body.newKdf.mem, body.newProtectedVaultKey],
      );
      await db.query('DELETE FROM sessions WHERE user_id = $1 AND id <> $2', [user.id, req.session.id]);
      return { ok: true };
    });
  });

  // 兩步驟驗證設定：需要再輸入一次主密碼。
  app.post('/api/auth/totp/setup', authedStrict, async (req) => {
    const body = parse(z.object({ authKey }), req.body);
    return tx(async (db) => {
      const { rows } = await db.query('SELECT email FROM users WHERE id = $1', [req.user.id]);
      const user = await verifyUser(db, rows[0].email, body.authKey, 'auth_hash');
      if (!user) return fail(403, '主密碼錯誤');
      const secret = new OTPAuth.Secret({ size: 20 }).base32;
      await db.query('UPDATE users SET totp_pending_enc = $2 WHERE id = $1', [user.id, box.seal(secret)]);
      return { secret, uri: totpFor(secret, user.email).toString() };
    });
  });

  app.post('/api/auth/totp/enable', authedStrict, async (req) => {
    const body = parse(z.object({ code: totpCode }), req.body);
    const { rows } = await pool.query('SELECT email, totp_pending_enc FROM users WHERE id = $1', [req.user.id]);
    if (!rows[0].totp_pending_enc) throw httpError(400, '請先執行設定步驟');
    const secret = box.open(rows[0].totp_pending_enc);
    const delta = totpFor(secret, rows[0].email).validate({ token: body.code, window: 1 });
    if (delta === null) throw httpError(400, '驗證碼錯誤');
    await pool.query(
      `UPDATE users SET totp_secret_enc = totp_pending_enc, totp_pending_enc = NULL, totp_last_step = $2
       WHERE id = $1`,
      [req.user.id, Math.floor(Date.now() / 30000) + delta],
    );
    return { ok: true };
  });

  app.post('/api/auth/totp/disable', authedStrict, async (req) => {
    const body = parse(z.object({ authKey, code: totpCode }), req.body);
    return tx(async (db) => {
      const { rows } = await db.query('SELECT email FROM users WHERE id = $1', [req.user.id]);
      const user = await verifyUser(db, rows[0].email, body.authKey, 'auth_hash');
      if (!user) return fail(403, '主密碼錯誤');
      if (!user.totp_secret_enc || !(await checkTotp(db, user, body.code))) {
        return fail(400, '驗證碼錯誤');
      }
      await db.query('UPDATE users SET totp_secret_enc = NULL WHERE id = $1', [user.id]);
      return { ok: true };
    });
  });
}
