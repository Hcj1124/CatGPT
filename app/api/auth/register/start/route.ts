import { NextResponse } from 'next/server';
import { assertSameOrigin, createSession, setSessionCookie, writeAudit } from '@/lib/auth';
import { ensureDatabase } from '@/lib/db';
import { hashPassword, normalizeEmail, randomId, sha256 } from '@/lib/security';

export async function POST(request: Request) {
  if (!assertSameOrigin(request)) return NextResponse.json({ error: '來源驗證失敗。' }, { status: 403 });
  try {
    const body = await request.json() as Record<string, unknown>;
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const email = normalizeEmail(typeof body.email === 'string' ? body.email : '');
    const displayEmail = typeof body.email === 'string' ? body.email.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const confirmPassword = typeof body.confirmPassword === 'string' ? body.confirmPassword : '';
    if (username.length < 2 || username.length > 40) return NextResponse.json({ error: '使用者名稱需為 2–40 個字元。' }, { status: 400 });
    if (!/^\S+@\S+\.\S+$/.test(email) || email.length > 254) return NextResponse.json({ error: 'Email 格式不正確。' }, { status: 400 });
    if (password.length < 8 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
      return NextResponse.json({ error: '密碼至少 8 個字元，並須包含英文字母與數字。' }, { status: 400 });
    }
    if (password !== confirmPassword) return NextResponse.json({ error: '兩次輸入的密碼不一致。' }, { status: 400 });

    const database = await ensureDatabase();
    const existing = await database.prepare('SELECT 1 AS found FROM users WHERE email = ?').bind(email).first();
    if (existing) return NextResponse.json({ error: '此 Email 已註冊，請直接登入。' }, { status: 409 });

    const windowStart = Math.floor(Date.now() / 600_000);
    const requester = request.headers.get('cf-connecting-ip') || request.headers.get('x-real-ip') || 'unknown';
    const emailRateKey = 'register-email:' + (await sha256(email)).slice(0, 18) + ':' + windowStart;
    const requesterRateKey = 'register-origin:' + (await sha256(requester)).slice(0, 18) + ':' + windowStart;
    const incrementRateSql = "INSERT INTO rate_limit_windows (key, window_start, count, updated_at) VALUES (?, ?, 1, datetime('now')) ON CONFLICT(key) DO UPDATE SET count = count + 1, updated_at = datetime('now')";
    await database.batch([
      database.prepare(incrementRateSql).bind(emailRateKey, windowStart),
      database.prepare(incrementRateSql).bind(requesterRateKey, windowStart),
    ]);
    const [emailRate, requesterRate] = await Promise.all([
      database.prepare('SELECT count FROM rate_limit_windows WHERE key = ?').bind(emailRateKey).first<{ count: number }>(),
      database.prepare('SELECT count FROM rate_limit_windows WHERE key = ?').bind(requesterRateKey).first<{ count: number }>(),
    ]);
    if ((emailRate?.count ?? 0) > 3 || (requesterRate?.count ?? 0) > 12) {
      return NextResponse.json({ error: '註冊要求過於頻繁，請稍後再試。' }, { status: 429 });
    }

    const passwordData = await hashPassword(password);
    const userId = randomId('usr');
    const now = new Date().toISOString();
    await database.batch([
      database.prepare(`
        INSERT INTO users (
          id, email, display_email, username, role, password_hash, password_salt,
          email_verified_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'user', ?, ?, ?, ?, ?)
      `).bind(userId, email, displayEmail, username, passwordData.hash, passwordData.salt, now, now, now),
      database.prepare('INSERT INTO user_limits (user_id, updated_at) VALUES (?, ?)').bind(userId, now),
    ]);

    const token = await createSession(userId);
    const response = NextResponse.json({ ok: true, role: 'user' });
    setSessionCookie(response, token);
    await writeAudit(userId, 'auth.register', 'user', userId, { role: 'user', emailVerification: 'disabled' });
    return response;
  } catch (error) {
    console.error('Registration failed', error);
    return NextResponse.json({ error: '目前無法建立帳號，請稍後再試。' }, { status: 500 });
  }
}
