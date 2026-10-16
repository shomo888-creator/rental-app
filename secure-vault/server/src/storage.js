// 檔案儲存（Cloudflare R2 或任何 S3 相容服務）。
// 伺服器只簽發短效網址，檔案由手機直接上傳/下載，且內容早已在手機上加密。
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const UPLOAD_URL_TTL = 60 * 60; // 1 小時
const DOWNLOAD_URL_TTL = 15 * 60; // 15 分鐘

export function createStorage(cfg) {
  const s3 = new S3Client({
    endpoint: cfg.endpoint,
    region: cfg.region,
    forcePathStyle: cfg.forcePathStyle,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
  });
  const Bucket = cfg.bucket;

  const prefix = (userId, fileId) => `u/${userId}/${fileId}/`;

  return {
    chunkKey: (userId, fileId, i) => `${prefix(userId, fileId)}c${i}`,
    thumbKey: (userId, fileId) => `${prefix(userId, fileId)}thumb`,

    // Content-Length 納入簽章：上傳大小必須與事先申報的完全一致，無法偷塞大檔案。
    presignPut(Key, size) {
      return getSignedUrl(s3, new PutObjectCommand({ Bucket, Key, ContentLength: size }), {
        expiresIn: UPLOAD_URL_TTL,
        signableHeaders: new Set(['content-length']),
      });
    },

    presignGet(Key) {
      return getSignedUrl(s3, new GetObjectCommand({ Bucket, Key }), { expiresIn: DOWNLOAD_URL_TTL });
    },

    async listSizes(userId, fileId) {
      const sizes = new Map();
      let ContinuationToken;
      do {
        const res = await s3.send(
          new ListObjectsV2Command({ Bucket, Prefix: prefix(userId, fileId), ContinuationToken }),
        );
        for (const o of res.Contents ?? []) sizes.set(o.Key, o.Size);
        ContinuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
      } while (ContinuationToken);
      return sizes;
    },

    async deleteFile(userId, fileId) {
      const keys = [...(await this.listSizes(userId, fileId)).keys()];
      for (let i = 0; i < keys.length; i += 1000) {
        await s3.send(
          new DeleteObjectsCommand({
            Bucket,
            Delete: { Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })), Quiet: true },
          }),
        );
      }
    },
  };
}
