import { getSessionUser } from '@/lib/auth';
import { ensureDatabase } from '@/lib/db';
import { getAvatarBucket } from '@/lib/storage';

export async function GET(request: Request) {
  const user = await getSessionUser(request);
  if (!user) return new Response('Unauthorized', { status: 401 });

  const database = await ensureDatabase();
  const profile = await database.prepare('SELECT avatar_key FROM user_profiles WHERE user_id = ?')
    .bind(user.id).first<{ avatar_key: string | null }>();
  if (!profile?.avatar_key) return new Response('Not found', { status: 404 });

  const object = await getAvatarBucket().get(profile.avatar_key);
  if (!object) return new Response('Not found', { status: 404 });
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('Cache-Control', 'private, no-store');
  headers.set('X-Content-Type-Options', 'nosniff');
  return new Response(object.body, { headers });
}
