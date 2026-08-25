import { NextResponse } from 'next/server';
import { assertSameOrigin } from '@/lib/auth';
import { ensureDatabase } from '@/lib/db';
import { sendVerificationEmail } from '@/lib/email';
import { hashPassword, hashVerificationCode, normalizeEmail, randomVerificationCode } from '@/lib/security';

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
    const passwordData = await hashPassword(password);
    const code = process.env.AUTH_DEV_MODE === 'true' && process.env.AUTH_DEV_VERIFICATION_CODE
      ? process.env.AUTH_DEV_VERIFICATION_CODE
      : randomVerificationCode();
    const codeHash = await hashVerificationCode(email, code);
    const now = new Date();
    const expires = new Date(now.getTime() + 10 * 60_000);
    await database.prepare(`
      INSERT INTO pending_registrations (
        email, display_email, username, password_hash, password_salt, code_hash, attempts, expires_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
      ON CONFLICT(email) DO UPDATE SET
        display_email = excluded.display_email,
        username = excluded.username,
        password_hash = excluded.password_hash,
        password_salt = excluded.password_salt,
        code_hash = excluded.code_hash,
        attempts = 0,
        expires_at = excluded.expires_at,
        created_at = excluded.created_at
    `).bind(email, displayEmail, username, passwordData.hash, passwordData.salt, codeHash, expires.toISOString(), now.toISOString()).run();
    const delivery = await sendVerificationEmail(displayEmail, code);
    return NextResponse.json({ ok: true, devCode: delivery.devCode });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : '無法寄送驗證碼。' }, { status: 500 });
  }
}
