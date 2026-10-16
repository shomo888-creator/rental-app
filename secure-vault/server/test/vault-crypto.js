// 手機端加密格式的參考實作（與 iOS 的 VaultCrypto.swift 完全相同的演算法與格式）。
// 測試用它扮演真正的客戶端，證明伺服器從頭到尾只接觸密文。
import crypto from 'node:crypto';
import _sodium from 'libsodium-wrappers-sumo';

await _sodium.ready;
const sodium = _sodium;

const hkdf = (ikm, info) =>
  Buffer.from(crypto.hkdfSync('sha256', ikm, Buffer.alloc(0), info, 32));

export const randomKey = () => Buffer.from(sodium.randombytes_buf(32));

// 主密碼 → Argon2id → 主金鑰 → (authKey 給伺服器驗證身分, encKey 只留在手機)
export function deriveKeys(password, { salt, ops, mem }) {
  const master = sodium.crypto_pwhash(
    32, Buffer.from(password.normalize('NFKC'), 'utf8'), salt, ops, mem,
    sodium.crypto_pwhash_ALG_ARGON2ID13,
  );
  return { authKey: hkdf(master, 'secure-vault/auth/v1'), encKey: hkdf(master, 'secure-vault/enc/v1') };
}

export function deriveRecoveryKeys(recoveryKey) {
  return {
    authKey: hkdf(recoveryKey, 'secure-vault/recovery-auth/v1'),
    encKey: hkdf(recoveryKey, 'secure-vault/recovery-enc/v1'),
  };
}

// 密文格式：24 bytes 隨機 nonce || XChaCha20-Poly1305 密文（含 16 bytes 驗證碼）
export function seal(key, plaintext, aad) {
  const nonce = sodium.randombytes_buf(24);
  const ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(plaintext, aad, null, nonce, key);
  return Buffer.concat([nonce, ct]);
}

export function open(key, sealed, aad) {
  return Buffer.from(
    sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, sealed.subarray(24), aad, sealed.subarray(0, 24), key),
  );
}

// AAD 把密文綁定在「用途 + ID」上，伺服器無法把 A 項目的密文換成 B 項目的。
export const aad = {
  vaultKey: 'secure-vault/vault-key/v1',
  item: (id) => `secure-vault/item/v1/${id}`,
  fileMeta: (id) => `secure-vault/file-meta/v1/${id}`,
  chunk: (id, i, last) => `secure-vault/chunk/v1/${id}/${i}/${last ? 1 : 0}`,
  thumb: (id) => `secure-vault/thumb/v1/${id}`,
};

export const CHUNK_SIZE = 4 * 1024 * 1024;
