import { z } from 'zod';

// 每個欄位都嚴格驗證型別與長度，不合法的請求一律拒絕。

const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

// 解碼 base64 並檢查 bytes 長度在 [min, max] 之間。
export const b64 = (min, max = min) =>
  z
    .string()
    .max(Math.ceil((max * 4) / 3) + 4)
    .regex(B64_RE)
    .transform((s, ctx) => {
      const buf = Buffer.from(s, 'base64');
      if (buf.length < min || buf.length > max) {
        ctx.addIssue({ code: 'custom', message: `長度必須介於 ${min}-${max} bytes` });
        return z.NEVER;
      }
      return buf;
    });

export const email = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/);

export const uuid = z
  .string()
  .regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/)
  .transform((s) => s.toLowerCase());

// Argon2id 參數下限：低於這個強度的設定一律拒絕（手機端也會檢查同樣的下限）。
export const KDF_MIN_OPS = 3;
export const KDF_MIN_MEM = 64 * 1024 * 1024;
export const DEFAULT_KDF = { ops: KDF_MIN_OPS, mem: KDF_MIN_MEM };

export const kdf = z.object({
  salt: b64(16),
  ops: z.number().int().min(KDF_MIN_OPS).max(20),
  mem: z.number().int().min(KDF_MIN_MEM).max(1024 * 1024 * 1024),
});

const KEY = 32;
// 被包起來的金鑰 = 24 bytes nonce + 32 bytes 金鑰 + 16 bytes 驗證碼
const WRAPPED_KEY = 24 + KEY + 16;

export const authKey = b64(KEY);
export const wrappedKey = b64(WRAPPED_KEY);
export const totpCode = z.string().regex(/^\d{6}$/);
export const deviceName = z.string().max(100).default('');

// 加密的密碼項目最大 64KB；加密檔案區塊最大 4MiB + 40 bytes 加密開銷。
export const MAX_ITEM_BYTES = 64 * 1024;
export const CHUNK_PLAINTEXT = 4 * 1024 * 1024;
export const MAX_CHUNK_BYTES = CHUNK_PLAINTEXT + 40;
export const MAX_THUMB_BYTES = 512 * 1024;
export const MIN_SEALED = 41;

export function parse(schema, data) {
  const r = schema.safeParse(data);
  if (!r.success) {
    const err = new Error('請求格式不正確');
    err.statusCode = 400;
    throw err;
  }
  return r.data;
}
