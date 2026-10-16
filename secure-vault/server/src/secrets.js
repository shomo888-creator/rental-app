// 伺服器端的密碼學工具。注意：這裡沒有任何能解開使用者資料的東西，
// 只處理登入驗證、session token 與兩步驟驗證密鑰。
import crypto from 'node:crypto';
import argon2 from 'argon2';

// authKey 已經在手機上經過高強度 Argon2id，這裡的參數主要是防止資料庫外洩後被直接重放。
const SERVER_HASH_OPTS = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 };

export const hashAuthKey = (authKey) => argon2.hash(authKey, SERVER_HASH_OPTS);

// 帳號不存在時也跑一次驗證，讓回應時間一致，避免被拿來探測帳號是否存在。
let dummyHash;
export async function verifyAuthKey(hash, authKey) {
  if (!hash) {
    dummyHash ??= await hashAuthKey(crypto.randomBytes(32));
    await argon2.verify(dummyHash, authKey).catch(() => false);
    return false;
  }
  return argon2.verify(hash, authKey).catch(() => false);
}

export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest();

export const newSessionToken = () => crypto.randomBytes(32).toString('base64url');

export function timingSafeEqualStr(a, b) {
  const ha = sha256(Buffer.from(a));
  const hb = sha256(Buffer.from(b));
  return crypto.timingSafeEqual(ha, hb);
}

export function makeSecretBox(serverSecret) {
  const encKey = crypto.hkdfSync('sha256', serverSecret, Buffer.alloc(0), 'server/totp-enc/v1', 32);
  const saltKey = crypto.hkdfSync('sha256', serverSecret, Buffer.alloc(0), 'server/fake-salt/v1', 32);

  return {
    seal(plaintext) {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', Buffer.from(encKey), iv);
      const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
      return Buffer.concat([iv, c.getAuthTag(), ct]);
    },
    open(blob) {
      const d = crypto.createDecipheriv('aes-256-gcm', Buffer.from(encKey), blob.subarray(0, 12));
      d.setAuthTag(blob.subarray(12, 28));
      return Buffer.concat([d.update(blob.subarray(28)), d.final()]).toString('utf8');
    },
    // 不存在的帳號回傳固定的假 salt，外人無法分辨帳號是否存在。
    fakeSalt(email) {
      return crypto.createHmac('sha256', Buffer.from(saltKey)).update(email).digest().subarray(0, 16);
    },
  };
}
