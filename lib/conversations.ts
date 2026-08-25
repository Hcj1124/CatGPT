import { ensureDatabase } from './db';
import type { Provider, ProviderUsage } from './providers';
import { randomId } from './security';

export type ConversationMode = 'chat' | 'work';

export type ConversationSummary = {
  id: string;
  title: string;
  mode: ConversationMode;
  isPinned: boolean;
  createdAt: string;
  updatedAt: string;
};

export type StoredMessage = {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  provider: string | null;
  modelId: string | null;
  credentialSource: 'platform' | 'byok' | null;
  status: 'completed' | 'failed';
  createdAt: string;
};

type ConversationRow = {
  id: string;
  title: string;
  mode: ConversationMode;
  isPinned: number;
  createdAt: string;
  updatedAt: string;
};

export async function listConversations(userId: string, search = ''): Promise<ConversationSummary[]> {
  const database = await ensureDatabase();
  const normalizedSearch = search.replace(/\s+/g, ' ').trim();
  if (normalizedSearch) {
    const pattern = `%${escapeLikePattern(normalizedSearch)}%`;
    const result = await database.prepare(`
      SELECT c.id, c.title, c.mode, c.is_pinned AS isPinned,
        c.created_at AS createdAt, c.updated_at AS updatedAt
      FROM conversations c
      WHERE c.user_id = ? AND (
        c.title LIKE ? ESCAPE '\\' COLLATE NOCASE
        OR EXISTS (
          SELECT 1 FROM messages m
          WHERE m.conversation_id = c.id
            AND m.content LIKE ? ESCAPE '\\' COLLATE NOCASE
        )
      )
      ORDER BY c.is_pinned DESC, c.updated_at DESC
      LIMIT 50
    `).bind(userId, pattern, pattern).all<ConversationRow>();
    return result.results.map(toSummary);
  }
  const result = await database.prepare(`
    SELECT id, title, mode, is_pinned AS isPinned, created_at AS createdAt, updated_at AS updatedAt
    FROM conversations
    WHERE user_id = ?
    ORDER BY is_pinned DESC, updated_at DESC
    LIMIT 100
  `).bind(userId).all<ConversationRow>();
  return result.results.map(toSummary);
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

export async function getConversationDetail(
  userId: string,
  conversationId: string,
): Promise<{ conversation: ConversationSummary; messages: StoredMessage[] } | null> {
  const database = await ensureDatabase();
  const conversation = await database.prepare(`
    SELECT id, title, mode, is_pinned AS isPinned, created_at AS createdAt, updated_at AS updatedAt
    FROM conversations WHERE id = ? AND user_id = ?
  `).bind(conversationId, userId).first<ConversationRow>();
  if (!conversation) return null;
  const messages = await database.prepare(`
    SELECT id, role, content, provider, model_id AS modelId, credential_source AS credentialSource,
      status, created_at AS createdAt
    FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid
  `).bind(conversationId).all<StoredMessage>();
  return { conversation: toSummary(conversation), messages: messages.results };
}

export async function ensureConversation(
  userId: string,
  conversationId: string | null,
  message: string,
  mode: ConversationMode,
  newConversationId: string | null = null,
): Promise<ConversationSummary> {
  const database = await ensureDatabase();
  if (conversationId) {
    const existing = await database.prepare(`
      SELECT id, title, mode, is_pinned AS isPinned, created_at AS createdAt, updated_at AS updatedAt
      FROM conversations WHERE id = ? AND user_id = ?
    `).bind(conversationId, userId).first<ConversationRow>();
    if (existing) return toSummary(existing);
    if (conversationId !== newConversationId) throw new Error('找不到這段對話，或你沒有存取權限。');
  }

  const id = newConversationId || randomId('conv');
  const now = new Date().toISOString();
  const title = makeConversationTitle(message);
  await database.prepare(`
    INSERT INTO conversations (id, user_id, title, mode, is_pinned, created_at, updated_at)
    VALUES (?, ?, ?, ?, 0, ?, ?)
  `).bind(id, userId, title, mode, now, now).run();
  return { id, title, mode, isPinned: false, createdAt: now, updatedAt: now };
}

export async function addUserMessage(conversationId: string, content: string): Promise<void> {
  const database = await ensureDatabase();
  const now = new Date().toISOString();
  await database.prepare(`
    INSERT INTO messages (id, conversation_id, role, content, status, created_at)
    VALUES (?, ?, 'user', ?, 'completed', ?)
  `).bind(randomId('msg'), conversationId, content, now).run();
  await database.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?')
    .bind(now, conversationId).run();
}

export async function replaceLastUserMessage(
  userId: string,
  conversationId: string,
  content: string,
): Promise<boolean> {
  const database = await ensureDatabase();
  const lastMessage = await database.prepare(`
    SELECT m.id, m.role
    FROM messages m
    INNER JOIN conversations c ON c.id = m.conversation_id
    WHERE m.conversation_id = ? AND c.user_id = ?
    ORDER BY m.created_at DESC, m.rowid DESC
    LIMIT 1
  `).bind(conversationId, userId).first<{ id: string; role: string }>();
  if (!lastMessage || lastMessage.role !== 'user') return false;

  const now = new Date().toISOString();
  await database.batch([
    database.prepare('UPDATE messages SET content = ? WHERE id = ?').bind(content, lastMessage.id),
    database.prepare('UPDATE conversations SET updated_at = ? WHERE id = ? AND user_id = ?')
      .bind(now, conversationId, userId),
  ]);
  return true;
}

export async function addAssistantMessage(
  conversationId: string,
  content: string,
  provider: Provider,
  modelId: string,
  credentialSource: 'platform' | 'byok',
  usage: ProviderUsage,
): Promise<void> {
  const database = await ensureDatabase();
  const now = new Date().toISOString();
  await database.prepare(`
    INSERT INTO messages (
      id, conversation_id, role, content, provider, model_id, credential_source,
      input_tokens, cached_tokens, output_tokens, status, created_at
    ) VALUES (?, ?, 'assistant', ?, ?, ?, ?, ?, ?, ?, 'completed', ?)
  `).bind(
    randomId('msg'), conversationId, content, provider, modelId, credentialSource,
    usage.inputTokens, usage.cachedTokens, usage.outputTokens, now,
  ).run();
  await database.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?')
    .bind(now, conversationId).run();
}

export async function updateConversation(
  userId: string,
  conversationId: string,
  changes: { title?: string; isPinned?: boolean },
): Promise<void> {
  const database = await ensureDatabase();
  const existing = await database.prepare('SELECT title, is_pinned AS isPinned FROM conversations WHERE id = ? AND user_id = ?')
    .bind(conversationId, userId).first<{ title: string; isPinned: number }>();
  if (!existing) throw new Error('找不到這段對話。');
  const title = typeof changes.title === 'string' ? normalizeTitle(changes.title) : existing.title;
  const isPinned = typeof changes.isPinned === 'boolean' ? Number(changes.isPinned) : existing.isPinned;
  await database.prepare(`
    UPDATE conversations SET title = ?, is_pinned = ?, updated_at = ?
    WHERE id = ? AND user_id = ?
  `).bind(title, isPinned, new Date().toISOString(), conversationId, userId).run();
}

export async function deleteConversation(userId: string, conversationId: string): Promise<void> {
  const database = await ensureDatabase();
  const result = await database.prepare('DELETE FROM conversations WHERE id = ? AND user_id = ?')
    .bind(conversationId, userId).run();
  if (!result.meta.changes) throw new Error('找不到這段對話。');
}

function toSummary(row: ConversationRow): ConversationSummary {
  return {
    id: row.id,
    title: row.title,
    mode: row.mode,
    isPinned: Boolean(row.isPinned),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function makeConversationTitle(message: string): string {
  const clean = message.replace(/\[\u9644\u4ef6：[^\]]+\]/g, '').replace(/\s+/g, ' ').trim();
  const characters = Array.from(clean || '新對話');
  return characters.length > 30 ? `${characters.slice(0, 30).join('')}…` : characters.join('');
}

function normalizeTitle(value: string): string {
  const title = value.replace(/\s+/g, ' ').trim();
  if (!title) throw new Error('對話名稱不可為空。');
  return Array.from(title).slice(0, 80).join('');
}
