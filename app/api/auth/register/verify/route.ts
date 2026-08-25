import { NextResponse } from 'next/server';
import { assertSameOrigin, createSession, setSessionCookie, writeAudit } from '@/lib/auth';
import { ensureDatabase } from '@/lib/db';
import { hashVerificationCode, normalizeEmail, randomId } from '@/lib/security';

type PendingRow = {
  email: string;
  display_email: string;
  username: string;
  password_hash: string;
  password_salt: string;
  code_hash: string;
  attempts: number;
  expires_at: string;
};

export async function POST(request: Request) {
  if (!assertSameOrigin(request)) return NextResponse.json({ error: '來源驗證失敗。' }, { status: 403 });
  try {
    const body = await request.json() as { email?: unknown; code?: unknown };
    const email = normalizeEmail(typeof body.email === 'string' ? body.email : '');
    const code = typeof body.code === 'string' ? body.code.trim() : '';
    if (!/^\d{6}$/.test(code)) return NextResponse.json({ error: '請輸入六位數驗證碼。' }, { status: 400 });
    const database = await ensureDatabase();
    const pending = await database.prepare('SELECT * FROM pending_registrations WHERE email = ?').bind(email).first<PendingRow>();
    if (!pending || new Date(pending.expires_at).getTime() <= Date.now()) {
      return NextResponse.json({ error: '驗證碼已失效，請重新註冊或重寄。' }, { status: 410 });
    }
    if (pending.attempts >= 5) return NextResponse.json({ error: '驗證失敗次數過多，請重新取得驗證碼。' }, { status: 429 });
    const codeHash = await hashVerificationCode(email, code);
    if (codeHash !== pending.code_hash) {
      await database.prepare('UPDATE pending_registrations SET attempts = attempts + 1 WHERE email = ?').bind(email).run();
      return NextResponse.json({ error: '驗證碼不正確。' }, { status: 400 });
    }
    const userId = randomId('usr');
    const initialAdmin = normalizeEmail(process.env.INITIAL_ADMIN_EMAIL ?? '');
    const role = initialAdmin && initialAdmin === email ? 'admin' : 'user';
    const now = new Date().toISOString();
    await database.batch([
      database.prepare(`
        INSERT INTO users (
          id, email, display_email, username, role, password_hash, password_salt,
          email_verified_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(userId, email, pending.display_email, pending.username, role, pending.password_hash, pending.password_salt, now, now, now),
      database.prepare('INSERT INTO user_limits (user_id, updated_at) VALUES (?, ?)').bind(userId, now),
      database.prepare('DELETE FROM pending_registrations WHERE email = ?').bind(email),
    ]);
    const token = await createSession(userId);
    const response = NextResponse.json({ ok: true, role });
    setSessionCookie(response, token);
    await writeAudit(userId, 'auth.register', 'user', userId, { role });
    return response;
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : '註冊失敗。' }, { status: 500 });
  }
}
