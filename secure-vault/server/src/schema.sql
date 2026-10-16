-- 伺服器只保存「加密後」的資料。所有 *_key / data / meta 欄位都是 iPhone 端加密的密文，
-- 伺服器沒有任何解密所需的金鑰。

CREATE TABLE IF NOT EXISTS users (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email                       text NOT NULL UNIQUE,
  -- Argon2id 參數（由手機用來從主密碼推導金鑰）
  kdf_salt                    bytea NOT NULL,
  kdf_ops                     integer NOT NULL,
  kdf_mem                     integer NOT NULL,
  -- 伺服器端再對 authKey 做一次 Argon2id，資料庫外洩也無法直接拿來登入
  auth_hash                   text NOT NULL,
  -- 被主密碼衍生金鑰包起來的資料金鑰（密文）
  protected_vault_key         bytea NOT NULL,
  recovery_auth_hash          text NOT NULL,
  -- 被復原金鑰包起來的資料金鑰（密文）
  recovery_protected_vault_key bytea NOT NULL,
  -- 兩步驟驗證：密鑰以 SERVER_SECRET 加密儲存
  totp_secret_enc             bytea,
  totp_pending_enc            bytea,
  totp_last_step              bigint NOT NULL DEFAULT 0,
  failed_logins               integer NOT NULL DEFAULT 0,
  locked_until                timestamptz,
  created_at                  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 只存 token 的 SHA-256，資料庫外洩也拿不到可用的 token
  token_hash    bytea NOT NULL UNIQUE,
  device_name   text NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);

CREATE TABLE IF NOT EXISTS items (
  id          uuid PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  data        bytea NOT NULL,
  revision    integer NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS items_user_idx ON items(user_id);

CREATE TABLE IF NOT EXISTS files (
  id           uuid PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  meta         bytea NOT NULL,
  chunk_sizes  integer[] NOT NULL,
  thumb_size   integer,
  total_size   bigint NOT NULL,
  status       text NOT NULL DEFAULT 'pending',
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS files_user_idx ON files(user_id);
