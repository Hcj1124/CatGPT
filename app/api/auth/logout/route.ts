import { NextResponse } from 'next/server';
import { assertSameOrigin, clearSessionCookie, getSessionUser, revokeSession, writeAudit } from '@/lib/auth';

export async function POST(request: Request) {
  if (!assertSameOrigin(request)) return NextResponse.json({ error: '來源驗證失敗。' }, { status: 403 });
  const user = await getSessionUser(request);
  await revokeSession(request);
  const response = NextResponse.json({ ok: true });
  clearSessionCookie(response);
  if (user) await writeAudit(user.id, 'auth.logout', 'user', user.id);
  return response;
}
