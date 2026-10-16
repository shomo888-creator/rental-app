// 端對端測試：用參考客戶端（真正的加密）跑完整流程，並確認資料庫裡找不到任何明文。
// 需要 PostgreSQL：TEST_DATABASE_URL=postgres://... npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import pg from 'pg';
import S3rver from 's3rver';
import * as OTPAuth from 'otpauth';
import { buildApp } from '../src/app.js';
import {
  deriveKeys, deriveRecoveryKeys, randomKey, seal, open, aad, CHUNK_SIZE,
} from './vault-crypto.js';

const DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5433/vault_test';
const BUCKET = 'vault-test';
const REG_CODE = 'test-registration-code-123';
const KDF = { ops: 3, mem: 64 * 1024 * 1024 };

let app, s3, s3dir;
let base;

before(async () => {
  const admin = new pg.Pool({ connectionString: DB_URL });
  await admin.query('DROP TABLE IF EXISTS files, items, sessions, users CASCADE');
  await admin.end();

  s3dir = await fs.mkdtemp(path.join(os.tmpdir(), 's3rver-'));
  s3 = new S3rver({ port: 0, address: '127.0.0.1', silent: true, directory: s3dir, configureBuckets: [{ name: BUCKET }] });
  const { port: s3port } = await s3.run();

  app = await buildApp(
    {
      port: 0,
      databaseUrl: DB_URL,
      serverSecret: crypto.randomBytes(32),
      registrationCode: REG_CODE,
      sessionTtlDays: 30,
      authRateLimit: 1000,
      maxStorageBytes: 20 * 1024 * 1024,
      maxFileBytes: 15 * 1024 * 1024,
      trustProxy: false,
      s3: {
        endpoint: `http://127.0.0.1:${s3port}`, region: 'us-east-1', bucket: BUCKET,
        accessKeyId: 'S3RVER', secretAccessKey: 'S3RVER', forcePathStyle: true,
      },
    },
    { logger: false },
  );
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${app.server.address().port}`;
});

after(async () => {
  await app?.close();
  await s3?.close();
  if (s3dir) await fs.rm(s3dir, { recursive: true, force: true });
});

async function api(method, url, body, token) {
  const res = await fetch(base + url, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

// 等到下一個 30 秒區間，取得新的一組 TOTP 驗證碼
const nextTotpWindow = () => new Promise((r) => setTimeout(r, 30_000 - (Date.now() % 30_000) + 100));

const b64 = (b) => Buffer.from(b).toString('base64');

// ---- 參考客戶端流程 ----

async function register(email, password) {
  const salt = crypto.randomBytes(16);
  const kdf = { salt: b64(salt), ...KDF };
  const keys = deriveKeys(password, { salt, ...KDF });
  const vaultKey = randomKey();
  const recoveryKey = randomKey();
  const rec = deriveRecoveryKeys(recoveryKey);
  const res = await api('POST', '/api/auth/register', {
    email, registrationCode: REG_CODE, kdf,
    authKey: b64(keys.authKey),
    protectedVaultKey: b64(seal(keys.encKey, vaultKey, aad.vaultKey)),
    recoveryAuthKey: b64(rec.authKey),
    recoveryProtectedVaultKey: b64(seal(rec.encKey, vaultKey, aad.vaultKey)),
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return { vaultKey, recoveryKey };
}

async function login(email, password, extra = {}) {
  const pre = await api('POST', '/api/auth/prelogin', { email });
  const k = pre.body.kdf;
  const keys = deriveKeys(password, { salt: Buffer.from(k.salt, 'base64'), ops: k.ops, mem: k.mem });
  const res = await api('POST', '/api/auth/login', { email, authKey: b64(keys.authKey), deviceName: 'test', ...extra });
  if (res.status !== 200) return { ...res, keys };
  const vaultKey = open(keys.encKey, Buffer.from(res.body.protectedVaultKey, 'base64'), aad.vaultKey);
  return { ...res, keys, token: res.body.token, vaultKey };
}

const ALICE = 'alice@example.com';
const ALICE_PW = '我的超強主密碼 correct horse battery staple';
const SECRET_PASSWORD = 'Bank-P@ssw0rd-絕對不能外洩';
let alice;

test('沒有正確註冊碼不能註冊', async () => {
  const res = await api('POST', '/api/auth/register', {
    email: 'x@example.com', registrationCode: 'wrong-code-wrong-code',
    authKey: b64(randomKey()), kdf: { salt: b64(crypto.randomBytes(16)), ...KDF },
    protectedVaultKey: b64(crypto.randomBytes(72)), recoveryAuthKey: b64(randomKey()),
    recoveryProtectedVaultKey: b64(crypto.randomBytes(72)),
  });
  assert.equal(res.status, 403);
});

test('拒絕過弱的 Argon2id 參數', async () => {
  const res = await api('POST', '/api/auth/register', {
    email: 'weak@example.com', registrationCode: REG_CODE,
    authKey: b64(randomKey()), kdf: { salt: b64(crypto.randomBytes(16)), ops: 1, mem: 8 * 1024 * 1024 },
    protectedVaultKey: b64(crypto.randomBytes(72)), recoveryAuthKey: b64(randomKey()),
    recoveryProtectedVaultKey: b64(crypto.randomBytes(72)),
  });
  assert.equal(res.status, 400);
});

test('註冊、登入並在手機端解開資料金鑰', async () => {
  const reg = await register(ALICE, ALICE_PW);
  alice = await login(ALICE, ALICE_PW);
  assert.equal(alice.status, 200);
  assert.deepEqual(alice.vaultKey, reg.vaultKey);
  alice.recoveryKey = reg.recoveryKey;

  const dup = await api('POST', '/api/auth/register', {
    email: ALICE, registrationCode: REG_CODE, authKey: b64(randomKey()),
    kdf: { salt: b64(crypto.randomBytes(16)), ...KDF }, protectedVaultKey: b64(crypto.randomBytes(72)),
    recoveryAuthKey: b64(randomKey()), recoveryProtectedVaultKey: b64(crypto.randomBytes(72)),
  });
  assert.equal(dup.status, 409);
});

test('prelogin 不洩漏帳號是否存在', async () => {
  const a = await api('POST', '/api/auth/prelogin', { email: 'nobody@example.com' });
  const b = await api('POST', '/api/auth/prelogin', { email: 'nobody@example.com' });
  assert.equal(a.status, 200);
  assert.deepEqual(a.body, b.body); // 每次都一樣，看起來就像真的帳號
  assert.equal(Buffer.from(a.body.kdf.salt, 'base64').length, 16);
  const login = await api('POST', '/api/auth/login', { email: 'nobody@example.com', authKey: b64(randomKey()) });
  assert.equal(login.status, 401);
  assert.equal(login.body.error, '帳號或密碼錯誤');
});

test('錯誤密碼不能登入，未登入不能存取資料', async () => {
  const bad = await login(ALICE, 'wrong password');
  assert.equal(bad.status, 401);
  assert.equal((await api('GET', '/api/items')).status, 401);
  assert.equal((await api('GET', '/api/items', null, 'A'.repeat(43))).status, 401);
});

test('帳密項目：加密儲存、讀取、版本衝突、刪除', async () => {
  const id = crypto.randomUUID();
  const item = { type: 'login', name: '玉山銀行', username: 'alice', password: SECRET_PASSWORD, url: 'https://bank.example' };
  const data = seal(alice.vaultKey, Buffer.from(JSON.stringify(item)), aad.item(id));

  const put = await api('PUT', `/api/items/${id}`, { data: b64(data), revision: 0 }, alice.token);
  assert.equal(put.status, 200);
  assert.equal(put.body.revision, 1);

  const list = await api('GET', '/api/items', null, alice.token);
  const got = list.body.items.find((i) => i.id === id);
  const decrypted = JSON.parse(open(alice.vaultKey, Buffer.from(got.data, 'base64'), aad.item(id)));
  assert.equal(decrypted.password, SECRET_PASSWORD);

  // 用舊版本號覆寫會被拒絕（另一台裝置已經改過）
  const stale = await api('PUT', `/api/items/${id}`, { data: b64(data), revision: 0 }, alice.token);
  assert.equal(stale.status, 409);
  assert.equal(stale.body.currentRevision, 1);

  // 伺服器若把密文搬到別的 ID，手機端解密會失敗
  assert.throws(() => open(alice.vaultKey, Buffer.from(got.data, 'base64'), aad.item(crypto.randomUUID())));

  const id2 = crypto.randomUUID();
  await api('PUT', `/api/items/${id2}`, { data: b64(seal(alice.vaultKey, Buffer.from('{}'), aad.item(id2))), revision: 0 }, alice.token);
  assert.equal((await api('DELETE', `/api/items/${id2}`, null, alice.token)).status, 200);
  assert.equal((await api('DELETE', `/api/items/${id2}`, null, alice.token)).status, 404);
});

test('不同使用者完全隔離', async () => {
  await register('bob@example.com', 'bob password long enough');
  const bob = await login('bob@example.com', 'bob password long enough');
  const aliceItems = (await api('GET', '/api/items', null, alice.token)).body.items;
  const target = aliceItems[0].id;

  assert.equal((await api('GET', '/api/items', null, bob.token)).body.items.length, 0);
  const hijack = await api('PUT', `/api/items/${target}`, { data: b64(crypto.randomBytes(80)), revision: 1 }, bob.token);
  assert.equal(hijack.status, 404);
  assert.equal((await api('DELETE', `/api/items/${target}`, null, bob.token)).status, 404);
  assert.equal((await api('GET', '/api/files', null, bob.token)).body.files.length, 0);
});

// ---- 照片影片 ----

function encryptFile(vaultKey, bytes, meta) {
  const id = crypto.randomUUID();
  const fileKey = randomKey();
  const count = Math.max(1, Math.ceil(bytes.length / CHUNK_SIZE));
  const chunks = [];
  for (let i = 0; i < count; i++) {
    const part = bytes.subarray(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
    chunks.push(seal(fileKey, part, aad.chunk(id, i, i === count - 1)));
  }
  const thumb = seal(fileKey, Buffer.from('fake-jpeg-thumbnail'), aad.thumb(id));
  const sealedMeta = seal(
    vaultKey,
    Buffer.from(JSON.stringify({ ...meta, size: bytes.length, chunkCount: count, fileKey: b64(fileKey) })),
    aad.fileMeta(id),
  );
  return { id, chunks, thumb, sealedMeta };
}

async function uploadFile(token, enc) {
  const create = await api('POST', '/api/files', {
    id: enc.id, meta: b64(enc.sealedMeta),
    chunkSizes: enc.chunks.map((c) => c.length), thumbSize: enc.thumb.length,
  }, token);
  if (create.status !== 201) return create;
  const urls = await api('POST', `/api/files/${enc.id}/upload-urls`, { chunks: enc.chunks.map((_, i) => i), thumb: true }, token);
  for (const { index, url } of urls.body.chunks) {
    const r = await fetch(url, { method: 'PUT', body: enc.chunks[index] });
    assert.equal(r.status, 200);
  }
  assert.equal((await fetch(urls.body.thumb, { method: 'PUT', body: enc.thumb })).status, 200);
  return api('POST', `/api/files/${enc.id}/complete`, {}, token);
}

test('照片影片：分塊加密上傳、下載解密', async () => {
  const video = crypto.randomBytes(CHUNK_SIZE * 2 + 12345); // 3 個區塊
  const enc = encryptFile(alice.vaultKey, video, { name: '家人的影片.mov', mime: 'video/quicktime' });

  // 還沒上傳就標記完成 → 拒絕
  await api('POST', '/api/files', {
    id: enc.id, meta: b64(enc.sealedMeta), chunkSizes: enc.chunks.map((c) => c.length), thumbSize: enc.thumb.length,
  }, alice.token);
  const early = await api('POST', `/api/files/${enc.id}/complete`, {}, alice.token);
  assert.equal(early.status, 400);
  assert.deepEqual(early.body.missingChunks, [0, 1, 2]);
  // 未完成的檔案不會出現在清單
  assert.equal((await api('GET', '/api/files', null, alice.token)).body.files.length, 0);

  const urls = await api('POST', `/api/files/${enc.id}/upload-urls`, { chunks: [0, 1, 2], thumb: true }, alice.token);
  // 上傳網址把大小簽進簽章
  assert.match(urls.body.chunks[0].url, /X-Amz-SignedHeaders=[^&]*content-length/);
  for (const { index, url } of urls.body.chunks) {
    await fetch(url, { method: 'PUT', body: enc.chunks[index] });
  }
  await fetch(urls.body.thumb, { method: 'PUT', body: enc.thumb });
  const done = await api('POST', `/api/files/${enc.id}/complete`, {}, alice.token);
  assert.equal(done.status, 200);

  const list = await api('GET', '/api/files', null, alice.token);
  const f = list.body.files.find((x) => x.id === enc.id);
  const meta = JSON.parse(open(alice.vaultKey, Buffer.from(f.meta, 'base64'), aad.fileMeta(f.id)));
  assert.equal(meta.name, '家人的影片.mov');
  const fileKey = Buffer.from(meta.fileKey, 'base64');

  const dl = await api('POST', `/api/files/${f.id}/download-urls`, { chunks: [0, 1, 2], thumb: true }, alice.token);
  const parts = [];
  for (const { index, url } of dl.body.chunks) {
    const sealed = Buffer.from(await (await fetch(url)).arrayBuffer());
    parts.push(open(fileKey, sealed, aad.chunk(f.id, index, index === meta.chunkCount - 1)));
  }
  assert.ok(Buffer.concat(parts).equals(video));
  const thumb = Buffer.from(await (await fetch(dl.body.thumb)).arrayBuffer());
  assert.equal(open(fileKey, thumb, aad.thumb(f.id)).toString(), 'fake-jpeg-thumbnail');

  // R2 上存的是密文，不是原始影片
  const raw = Buffer.from(await (await fetch(dl.body.chunks[0].url)).arrayBuffer());
  assert.ok(!raw.subarray(24, 24 + 1000).equals(video.subarray(0, 1000)));

  // 被截斷的檔案（少了最後一塊）會被發現：倒數第二塊不能冒充最後一塊
  const sealed1 = Buffer.from(await (await fetch(dl.body.chunks[1].url)).arrayBuffer());
  assert.throws(() => open(fileKey, sealed1, aad.chunk(f.id, 1, true)));

  // 別人拿不到下載網址
  const bob = await login('bob@example.com', 'bob password long enough');
  assert.equal((await api('POST', `/api/files/${f.id}/download-urls`, { chunks: [0] }, bob.token)).status, 404);
  assert.equal((await api('DELETE', `/api/files/${f.id}`, null, bob.token)).status, 404);

  assert.equal((await api('DELETE', `/api/files/${f.id}`, null, alice.token)).status, 200);
  assert.equal((await api('GET', '/api/files', null, alice.token)).body.files.length, 0);
});

test('容量限制', async () => {
  const big = encryptFile(alice.vaultKey, crypto.randomBytes(CHUNK_SIZE * 4), { name: 'big.mov', mime: 'video/quicktime' });
  const res = await api('POST', '/api/files', {
    id: big.id, meta: b64(big.sealedMeta), chunkSizes: big.chunks.map((c) => c.length),
  }, alice.token);
  assert.equal(res.status, 413);

  const ok = encryptFile(alice.vaultKey, crypto.randomBytes(1000), { name: 'a.jpg', mime: 'image/jpeg' });
  assert.equal((await uploadFile(alice.token, ok)).status, 200);
});

test('資料庫裡找不到任何明文', async () => {
  const db = new pg.Pool({ connectionString: DB_URL });
  const dump = [];
  for (const t of ['users', 'items', 'files', 'sessions']) {
    const { rows } = await db.query(`SELECT * FROM ${t}`);
    for (const r of rows) {
      for (const v of Object.values(r)) dump.push(Buffer.isBuffer(v) ? v.toString('latin1') + v.toString('utf8') : String(v));
    }
  }
  await db.end();
  const all = dump.join('\n');
  for (const secret of [SECRET_PASSWORD, '玉山銀行', 'bank.example', '家人的影片', 'a.jpg', ALICE_PW, alice.token]) {
    assert.ok(!all.includes(secret), `資料庫中出現明文：${secret}`);
  }
});

test('兩步驟驗證：啟用、登入需要驗證碼、驗證碼不能重複使用', async () => {
  const setup = await api('POST', '/api/auth/totp/setup', { authKey: b64(alice.keys.authKey) }, alice.token);
  assert.equal(setup.status, 200);
  const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(setup.body.secret) });
  assert.equal((await api('POST', '/api/auth/totp/enable', { code: totp.generate() }, alice.token)).status, 200);

  // 啟用時用過的驗證碼不能再拿來登入
  assert.equal((await login(ALICE, ALICE_PW, { totp: totp.generate() })).status, 401);

  const noCode = await login(ALICE, ALICE_PW);
  assert.equal(noCode.status, 401);
  assert.equal(noCode.body.totpRequired, true);

  await nextTotpWindow();
  const code = totp.generate();
  const ok = await login(ALICE, ALICE_PW, { totp: code });
  assert.equal(ok.status, 200);
  const replay = await login(ALICE, ALICE_PW, { totp: code });
  assert.equal(replay.status, 401);
  alice.token = ok.token;
  alice.totp = totp;

  const acct = await api('GET', '/api/account', null, alice.token);
  assert.equal(acct.body.totpEnabled, true);
});

test('變更主密碼：舊密碼失效、其他裝置被登出、資料仍可解開', async () => {
  const other = await api('GET', '/api/auth/sessions', null, alice.token);
  assert.ok(other.body.sessions.length >= 2);

  const NEW_PW = '全新的主密碼 2026 longer passphrase';
  const salt = crypto.randomBytes(16);
  const keys = deriveKeys(NEW_PW, { salt, ...KDF });
  const res = await api('POST', '/api/auth/change-password', {
    currentAuthKey: b64(alice.keys.authKey), newAuthKey: b64(keys.authKey),
    newKdf: { salt: b64(salt), ...KDF },
    newProtectedVaultKey: b64(seal(keys.encKey, alice.vaultKey, aad.vaultKey)),
  }, alice.token);
  assert.equal(res.status, 200);

  const after = await api('GET', '/api/auth/sessions', null, alice.token);
  assert.equal(after.body.sessions.length, 1);

  await nextTotpWindow();
  assert.equal((await login(ALICE, ALICE_PW, { totp: alice.totp.generate() })).status, 401);
  const ok = await login(ALICE, NEW_PW, { totp: alice.totp.generate() });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.vaultKey, alice.vaultKey);
});

test('復原金鑰：忘記主密碼時救回帳號', async () => {
  const rec = deriveRecoveryKeys(alice.recoveryKey);
  const wrong = await api('POST', '/api/auth/recover/start', { email: ALICE, recoveryAuthKey: b64(randomKey()) });
  assert.equal(wrong.status, 401);

  const start = await api('POST', '/api/auth/recover/start', { email: ALICE, recoveryAuthKey: b64(rec.authKey) });
  assert.equal(start.status, 200);
  const vaultKey = open(rec.encKey, Buffer.from(start.body.recoveryProtectedVaultKey, 'base64'), aad.vaultKey);
  assert.deepEqual(vaultKey, alice.vaultKey);

  const PW = '用復原金鑰設定的新密碼 abc';
  const salt = crypto.randomBytes(16);
  const keys = deriveKeys(PW, { salt, ...KDF });
  const finish = await api('POST', '/api/auth/recover/finish', {
    email: ALICE, recoveryAuthKey: b64(rec.authKey), newAuthKey: b64(keys.authKey),
    newKdf: { salt: b64(salt), ...KDF }, newProtectedVaultKey: b64(seal(keys.encKey, vaultKey, aad.vaultKey)),
  });
  assert.equal(finish.status, 200);
  // 所有舊 session 失效
  assert.equal((await api('GET', '/api/items', null, alice.token)).status, 401);
  const ok = await login(ALICE, PW); // 兩步驟驗證已被重設
  assert.equal(ok.status, 200);
  const items = (await api('GET', '/api/items', null, ok.token)).body.items;
  assert.equal(JSON.parse(open(ok.vaultKey, Buffer.from(items[0].data, 'base64'), aad.item(items[0].id))).password, SECRET_PASSWORD);
});

test('連續輸錯 5 次會鎖定帳號（即使之後輸入正確密碼）', async () => {
  await register('carol@example.com', 'carol correct password');
  for (let i = 0; i < 5; i++) {
    const r = await api('POST', '/api/auth/login', { email: 'carol@example.com', authKey: b64(randomKey()) });
    assert.equal(r.status, 401);
  }
  const locked = await login('carol@example.com', 'carol correct password');
  assert.equal(locked.status, 429);
});

test('登出後 token 立即失效', async () => {
  await register('dave@example.com', 'dave correct password');
  const d = await login('dave@example.com', 'dave correct password');
  assert.equal((await api('POST', '/api/auth/logout', {}, d.token)).status, 200);
  assert.equal((await api('GET', '/api/items', null, d.token)).status, 401);
});
