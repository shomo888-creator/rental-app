// 所有設定都從環境變數讀取（在 Zeabur 的「環境變數」頁面設定）。
// 缺少必要設定時直接拒絕啟動，避免在不安全的狀態下運作。

export function loadConfig(env = process.env) {
  const required = (name) => {
    if (!env[name]) throw new Error(`缺少必要環境變數 ${name}`);
    return env[name];
  };
  const int = (name, def) => {
    if (env[name] === undefined || env[name] === '') return def;
    const n = Number(env[name]);
    if (!Number.isSafeInteger(n) || n < 0) throw new Error(`環境變數 ${name} 必須是正整數`);
    return n;
  };

  const serverSecret = Buffer.from(required('SERVER_SECRET'), 'base64');
  if (serverSecret.length < 32) {
    throw new Error('SERVER_SECRET 必須是至少 32 bytes 的 base64 字串（openssl rand -base64 32）');
  }
  const registrationCode = env.REGISTRATION_CODE || '';
  if (registrationCode && registrationCode.length < 16) {
    throw new Error('REGISTRATION_CODE 至少要 16 個字元');
  }

  return {
    port: int('PORT', 8080),
    databaseUrl: required('DATABASE_URL'),
    serverSecret,
    // 沒設定 REGISTRATION_CODE 時完全關閉註冊。
    registrationCode,
    sessionTtlDays: int('SESSION_TTL_DAYS', 30),
    authRateLimit: int('AUTH_RATE_LIMIT_PER_MINUTE', 10),
    maxStorageBytes: int('MAX_STORAGE_BYTES', 50 * 1024 ** 3),
    maxFileBytes: int('MAX_FILE_BYTES', 10 * 1024 ** 3),
    trustProxy: env.TRUST_PROXY !== 'false',
    s3: {
      endpoint: required('S3_ENDPOINT'),
      region: env.S3_REGION || 'auto',
      bucket: required('S3_BUCKET'),
      accessKeyId: required('S3_ACCESS_KEY_ID'),
      secretAccessKey: required('S3_SECRET_ACCESS_KEY'),
      forcePathStyle: env.S3_FORCE_PATH_STYLE === 'true',
    },
  };
}
