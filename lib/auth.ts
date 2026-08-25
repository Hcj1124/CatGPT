import type { NextResponse } from 'next/server';
import { ensureDatabase } from './db';
import { randomId, randomToken, sha256 } from './security';

export const SESSION_COOKIE = 'catgpt_session';
const SESSION_SECONDS = 60 * 60 * 24 * 7;

export type SessionUser = {
  id: string;
  email: string;
  username: string;
  avatarUrl: string | null;
  role: 'user' | 'admin';
  status: 'active' | 'suspended';
};

type UserRow = {
  id: string;
  display_email: string;
  username: string;
  avatar_key: string | null;
  role: 'user' | 'admin';
  status: 'active' | 'suspended';
};

export async function getSessionUser(request: Request): Promise<SessionUser | null> {
  const token = readCookie(request.headers.get('cookie'), SESSION_COOKIE);
  if (!token) return null;
  const database = await ensureDatabase();
  const tokenHash = await sha256(token);
  const user = await database.prepare(`
    SELECT u.id, u.display_email, u.username, u.role, u.status, p.avatar_key
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    LEFT JOIN user_profiles p ON p.user_id = u.id
    WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > datetime('now')
  `).bind(tokenHash).first<UserRow>();
  if (!user || user.status !== 'active') return null;
  await database.prepare('UPDATE sessions SET last_seen_at = datetime(\'now\') WHERE token_hash = ?').bind(tokenHash).run();
  return {
    id: user.id,
    email: user.display_email,
    username: user.username,
    avatarUrl: user.avatar_key ? '/api/account/profile/avatar' : null,
    role: user.role,
    status: user.status,
  };
}

export async function createSession(userId: string): Promise<string> {
  const database = await ensureDatabase();
  const token = randomToken();
  const tokenHash = await sha256(token);
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_SECONDS * 1000);
  await database.prepare(`
    INSERT INTO sessions (token_hash, user_id, expires_at, last_seen_at, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).bind(tokenHash, userId, expires.toISOString(), now.toISOString(), now.toISOString()).run();
  return token;
}

export function setSessionCookie(response: NextResponse, token: string): void {
  response.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_SECONDS,
  });
}

export async function revokeSession(request: Request): Promise<void> {
  const token = readCookie(request.headers.get('cookie'), SESSION_COOKIE);
  if (!token) return;
  const database = await ensureDatabase();
  await database.prepare('UPDATE sessions SET revoked_at = datetime(\'now\') WHERE token_hash = ?')
    .bind(await sha256(token)).run();
}

export function clearSessionCookie(response: NextResponse): void {
  response.cookies.set(SESSION_COOKIE, '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
}

export async function requireAdmin(request: Request): Promise<SessionUser | null> {
  const user = await getSessionUser(request);
  return user?.role === 'admin' ? user : null;
}

export function assertSameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return true;
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

export async function writeAudit(
  actorUserId: string | null,
  action: string,
  targetType: string,
  targetId: string | null,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  const database = await ensureDatabase();
  await database.prepare(`
    INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, metadata_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
  `).bind(randomId('audit'), actorUserId, action, targetType, targetId, JSON.stringify(metadata)).run();
}

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const item of header.split(';')) {
    const [key, ...rest] = item.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}
