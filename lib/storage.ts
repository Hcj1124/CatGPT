import { env } from 'cloudflare:workers';

export function getAvatarBucket(): R2Bucket {
  const bucket = (env as unknown as { AVATARS?: R2Bucket }).AVATARS;
  if (!bucket) throw new Error('頭像儲存空間尚未設定。');
  return bucket;
}
