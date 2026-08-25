import { NextResponse } from 'next/server';
import { assertSameOrigin, createSession, setSessionCookie, writeAudit } from '@/lib/auth';
import { ensureDatabase } from '@/lib/db';
import { normalizeEmail, verifyPassword } from '@/lib/security';

type LoginRow = {
  id: string;
  password_hash: string;
  password_salt: string;
  status: 'active' | 'suspended';
};

export async function POST(request: Request) {
  if (!assertSameOrigin(request)) return NextResponse.json({ error: '來源驗證失敗。' }, { status: 403 });
  try {
    const body = await request.json() as { email?: unknown; password?: unknown };
    const email = normalizeEmail(typeof body.email === 'string' ? body.email : '');
    const password = typeof body.password === 'string' ? body.password : '';
    const database = await ensureDatabase();
    const user = await database.prepare(`
      SELECT id, password_hash, password_salt, status FROM users WHERE email = ?
    `).bind(email).first<LoginRow>();
    if (!user || !(await verifyPassword(password, user.password_salt, user.password_hash))) {
      return NextResponse.json({ error: '電子郵件或密碼不正確。' }, { status: 401 });
    }
    if (user.status !== 'active') return NextResponse.json({ error: '此帳號已停用。' }, { status: 403 });
    const token = await createSession(user.id);
    const response = NextResponse.json({ ok: true });
    setSessionCookie(response, token);
    await writeAudit(user.id, 'auth.login', 'user', user.id);
    return response;
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : '登入失敗。' }, { status: 500 });
  }
}
