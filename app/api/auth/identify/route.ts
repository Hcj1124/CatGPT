import { NextResponse } from 'next/server';
import { assertSameOrigin } from '@/lib/auth';
import { ensureDatabase } from '@/lib/db';
import { normalizeEmail, sha256 } from '@/lib/security';

export async function POST(request: Request) {
  if (!assertSameOrigin(request)) return NextResponse.json({ error: '來源驗證失敗。' }, { status: 403 });
  try {
    const body = await request.json() as { email?: unknown };
    const email = normalizeEmail(typeof body.email === 'string' ? body.email : '');
    if (!/^\S+@\S+\.\S+$/.test(email) || email.length > 254) {
      return NextResponse.json({ error: '請輸入有效的電子郵件地址。' }, { status: 400 });
    }
    const database = await ensureDatabase();
    const key = `identify:${(await sha256(email)).slice(0, 18)}:${Math.floor(Date.now() / 60_000)}`;
    await database.prepare(`
      INSERT INTO rate_limit_windows (key, window_start, count, updated_at)
      VALUES (?, ?, 1, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET count = count + 1, updated_at = datetime('now')
    `).bind(key, Math.floor(Date.now() / 60_000)).run();
    const rate = await database.prepare('SELECT count FROM rate_limit_windows WHERE key = ?').bind(key).first<{ count: number }>();
    if ((rate?.count ?? 0) > 8) return NextResponse.json({ error: '嘗試次數過多，請稍後再試。' }, { status: 429 });
    const existing = await database.prepare('SELECT 1 AS found FROM users WHERE email = ?').bind(email).first<{ found: number }>();
    return NextResponse.json({ exists: Boolean(existing) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : '無法檢查帳號。' }, { status: 500 });
  }
}
