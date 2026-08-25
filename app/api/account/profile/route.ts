import { NextResponse } from 'next/server';
import { assertSameOrigin, getSessionUser, writeAudit } from '@/lib/auth';
import { ensureDatabase } from '@/lib/db';
import { randomId } from '@/lib/security';
import { getAvatarBucket } from '@/lib/storage';

const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const ALLOWED_AVATAR_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

export async function GET(request: Request) {
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ error: '請先登入。' }, { status: 401 });
  return NextResponse.json({ user });
}

export async function PATCH(request: Request) {
  if (!assertSameOrigin(request)) return NextResponse.json({ error: '不允許跨站請求。' }, { status: 403 });
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ error: '請先登入。' }, { status: 401 });

  const body = await request.json() as { username?: unknown };
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  if (username.length < 2 || username.length > 40) {
    return NextResponse.json({ error: '使用者名稱需為 2–40 個字元。' }, { status: 400 });
  }

  const database = await ensureDatabase();
  await database.prepare('UPDATE users SET username = ?, updated_at = ? WHERE id = ?')
    .bind(username, new Date().toISOString(), user.id).run();
  await writeAudit(user.id, 'profile.username.updated', 'user', user.id);
  return NextResponse.json({ ok: true });
}

export async function POST(request: Request) {
  if (!assertSameOrigin(request)) return NextResponse.json({ error: '不允許跨站請求。' }, { status: 403 });
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ error: '請先登入。' }, { status: 401 });

  const form = await request.formData();
  const avatar = form.get('avatar');
  if (!(avatar instanceof File)) return NextResponse.json({ error: '請選擇頭像圖片。' }, { status: 400 });
  if (!ALLOWED_AVATAR_TYPES.has(avatar.type)) return NextResponse.json({ error: '頭像僅支援 JPG、PNG 或 WebP。' }, { status: 400 });
  if (avatar.size === 0 || avatar.size > MAX_AVATAR_BYTES) return NextResponse.json({ error: '頭像大小需小於 2 MB。' }, { status: 400 });

  const database = await ensureDatabase();
  const previous = await database.prepare('SELECT avatar_key FROM user_profiles WHERE user_id = ?')
    .bind(user.id).first<{ avatar_key: string | null }>();
  const extension = avatar.type === 'image/png' ? 'png' : avatar.type === 'image/webp' ? 'webp' : 'jpg';
  const key = `profiles/${user.id}/${randomId('avatar')}.${extension}`;
  const bucket = getAvatarBucket();
  await bucket.put(key, avatar.stream(), {
    httpMetadata: { contentType: avatar.type, cacheControl: 'private, no-store' },
    customMetadata: { ownerId: user.id },
  });

  const now = new Date().toISOString();
  if (previous) {
    await database.prepare('UPDATE user_profiles SET avatar_key = ?, updated_at = ? WHERE user_id = ?')
      .bind(key, now, user.id).run();
  } else {
    await database.prepare('INSERT INTO user_profiles (user_id, avatar_key, updated_at) VALUES (?, ?, ?)')
      .bind(user.id, key, now).run();
  }
  if (previous?.avatar_key) await bucket.delete(previous.avatar_key);
  await writeAudit(user.id, 'profile.avatar.updated', 'user', user.id);
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: Request) {
  if (!assertSameOrigin(request)) return NextResponse.json({ error: '不允許跨站請求。' }, { status: 403 });
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ error: '請先登入。' }, { status: 401 });

  const database = await ensureDatabase();
  const profile = await database.prepare('SELECT avatar_key FROM user_profiles WHERE user_id = ?')
    .bind(user.id).first<{ avatar_key: string | null }>();
  await database.prepare('DELETE FROM user_profiles WHERE user_id = ?').bind(user.id).run();
  if (profile?.avatar_key) await getAvatarBucket().delete(profile.avatar_key);
  await writeAudit(user.id, 'profile.avatar.deleted', 'user', user.id);
  return NextResponse.json({ ok: true });
}
