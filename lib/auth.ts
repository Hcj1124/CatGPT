import { ensureDatabase } from './db';
import { normalizeEmail, randomId } from './security';

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
  email: string;
  display_email: string;
  username: string;
  avatar_key: string | null;
  role: 'user' | 'admin';
  status: 'active' | 'suspended';
};

export async function getSessionUser(request: Request): Promise<SessionUser | null> {
  const identity = readChatGptIdentity(request);
  if (!identity) return null;

  const database = await ensureDatabase();
  const configuredAdminEmail = normalizeEmail(process.env.INITIAL_ADMIN_EMAIL || '');
  const desiredRole: 'user' | 'admin' =
    configuredAdminEmail && identity.email === configuredAdminEmail ? 'admin' : 'user';

  let user = await database.prepare(`
    SELECT u.id, u.email, u.display_email, u.username, u.role, u.status, p.avatar_key
    FROM users u
    LEFT JOIN user_profiles p ON p.user_id = u.id
    WHERE u.chatgpt_user_id = ?
  `).bind(identity.id).first<UserRow>();

  if (!user) {
    const existing = await database.prepare(`
      SELECT u.id, u.email, u.display_email, u.username, u.role, u.status, p.avatar_key
      FROM users u
      LEFT JOIN user_profiles p ON p.user_id = u.id
      WHERE u.email = ?
    `).bind(identity.email).first<UserRow>();

    if (existing) {
      const role = desiredRole === 'admin' ? 'admin' : existing.role;
      await database.prepare(`
        UPDATE users
        SET chatgpt_user_id = ?, display_email = ?, username = ?, role = ?,
            email_verified_at = COALESCE(email_verified_at, datetime('now')),
            updated_at = datetime('now')
        WHERE id = ?
      `).bind(identity.id, identity.displayEmail, identity.username, role, existing.id).run();
      await writeAudit(existing.id, 'auth.chatgpt.link', 'user', existing.id, { linkedExistingAccount: true });
    } else {
      const userId = randomId('usr');
      const now = new Date().toISOString();
      await database.batch([
        database.prepare(`
          INSERT INTO users (
            id, email, display_email, username, chatgpt_user_id, role,
            password_hash, password_salt, email_verified_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, '', '', ?, ?, ?)
        `).bind(
          userId,
          identity.email,
          identity.displayEmail,
          identity.username,
          identity.id,
          desiredRole,
          now,
          now,
          now,
        ),
        database.prepare(`
          INSERT INTO user_limits (user_id, updated_at)
          VALUES (?, ?)
          ON CONFLICT(user_id) DO NOTHING
        `).bind(userId, now),
      ]);
      await writeAudit(userId, 'auth.chatgpt.link', 'user', userId, { linkedExistingAccount: false });
    }

    user = await database.prepare(`
      SELECT u.id, u.email, u.display_email, u.username, u.role, u.status, p.avatar_key
      FROM users u
      LEFT JOIN user_profiles p ON p.user_id = u.id
      WHERE u.chatgpt_user_id = ?
    `).bind(identity.id).first<UserRow>();
  } else {
    const role = desiredRole === 'admin' ? 'admin' : user.role;
    await database.prepare(`
      UPDATE users
      SET display_email = ?, role = ?, updated_at = datetime('now')
      WHERE id = ?
    `).bind(identity.displayEmail, role, user.id).run();
    user = { ...user, display_email: identity.displayEmail, role };
  }

  if (!user || user.status !== 'active') return null;
  return {
    id: user.id,
    email: user.display_email,
    username: user.username,
    avatarUrl: user.avatar_key ? '/api/account/profile/avatar' : null,
    role: user.role,
    status: user.status,
  };
}

function readChatGptIdentity(request: Request): {
  id: string;
  email: string;
  displayEmail: string;
  username: string;
} | null {
  const id = request.headers.get('oai-authenticated-user-id')?.trim();
  const displayEmail = request.headers.get('oai-authenticated-user-email')?.trim();
  if (!id || !displayEmail) return null;

  const email = normalizeEmail(displayEmail);
  if (!/^\S+@\S+\.\S+$/.test(email) || email.length > 254) return null;

  let fullName = '';
  const encodedName = request.headers.get('oai-authenticated-user-full-name');
  const encoding = request.headers.get('oai-authenticated-user-full-name-encoding');
  if (encodedName && encoding === 'percent-encoded-utf-8') {
    try {
      fullName = decodeURIComponent(encodedName).trim();
    } catch {
      fullName = '';
    }
  }
  const username = (fullName || displayEmail.split('@')[0] || 'ChatGPT user').slice(0, 40);
  return { id, email, displayEmail, username };
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
