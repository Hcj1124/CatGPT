import { NextResponse } from 'next/server';
import { assertSameOrigin, requireAdmin, writeAudit } from '@/lib/auth';
import { ensureDatabase } from '@/lib/db';
import { deleteCredential, getCredential, saveCredential, validateProviderModel, type Provider } from '@/lib/providers';
import { randomId } from '@/lib/security';

const providers = new Set<Provider>(['openai', 'anthropic', 'google', 'cloudflare', 'huggingface', 'compatible']);

export async function GET(request: Request) {
  const admin = await requireAdmin(request);
  if (!admin) return NextResponse.json({ error: '需要管理員權限。' }, { status: 403 });
  const database = await ensureDatabase();
  const [models, credentials, users] = await Promise.all([
    database.prepare(`
      SELECT id, provider, provider_model_id AS providerModelId, display_name AS displayName,
        access_mode AS accessMode, enabled, input_price_micros AS inputPriceMicros,
        output_price_micros AS outputPriceMicros, max_output_tokens AS maxOutputTokens
      FROM model_catalog ORDER BY provider, display_name, access_mode
    `).all(),
    database.prepare(`
      SELECT provider, key_last4 AS last4, verified_at AS verifiedAt, status
      FROM provider_credentials
      WHERE owner_type = 'platform' AND owner_id = 'platform' AND status != 'revoked'
      ORDER BY provider
    `).all(),
    database.prepare(`
      SELECT u.id, u.username, u.display_email AS email, u.role, u.status,
        l.requests_per_minute AS requestsPerMinute, l.requests_per_day AS requestsPerDay,
        l.tokens_per_month AS tokensPerMonth,
        l.platform_cost_limit_micros AS platformCostLimitMicros,
        l.max_output_tokens AS maxOutputTokens
      FROM users u JOIN user_limits l ON l.user_id = u.id
      ORDER BY u.created_at DESC LIMIT 200
    `).all(),
  ]);
  return NextResponse.json({ models: models.results, credentials: credentials.results, users: users.results });
}

export async function POST(request: Request) {
  if (!assertSameOrigin(request)) return NextResponse.json({ error: '來源驗證失敗。' }, { status: 403 });
  const admin = await requireAdmin(request);
  if (!admin) return NextResponse.json({ error: '需要管理員權限。' }, { status: 403 });
  try {
    const body = await request.json() as Record<string, unknown>;
    const action = body.action;
    if (action === 'save-platform-key') {
      const provider = parseProvider(body.provider);
      const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
      if (!provider || !apiKey) throw new Error('請選擇供應商並輸入 API Key。');
      const endpointUrl = typeof body.endpointUrl === 'string' ? body.endpointUrl.trim() : '';
      const result = await saveCredential('platform', 'platform', provider, apiKey, endpointUrl);
      await recordAudit(admin.id, 'credential.platform.save', 'provider', provider, { fingerprint: result.fingerprint });
      return NextResponse.json({ ok: true, last4: result.last4 });
    }

    if (action === 'save-model') {
      const database = await ensureDatabase();
      const provider = parseProvider(body.provider);
      const providerModelId = typeof body.providerModelId === 'string' ? body.providerModelId.trim() : '';
      const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : '';
      const accessMode = body.accessMode === 'byok' ? 'byok' : body.accessMode === 'platform' ? 'platform' : null;
      if (!provider || !providerModelId || !displayName || !accessMode) throw new Error('模型資料不完整。');
      const credential = accessMode === 'platform'
        ? await getCredential('platform', 'platform', provider)
        : await getCredential('user', admin.id, provider) ?? await getCredential('platform', 'platform', provider);
      if (!credential) {
        throw new Error(accessMode === 'platform'
          ? `請先設定 ${provider} 的平台 API Key，再新增平台模型。`
          : `請先在「帳號與 API Key」加入 ${provider} 金鑰，再新增自備金鑰模型。`);
      }
      if (!(await validateProviderModel(provider, credential.apiKey, providerModelId, credential.endpointUrl))) {
        throw new Error('找不到此模型，或目前的 API Key 沒有使用權限。請確認供應商模型 ID。');
      }
      const enabled = body.enabled === false ? 0 : 1;
      const inputPriceMicros = nonNegativeInt(body.inputPriceMicros, 0);
      const outputPriceMicros = nonNegativeInt(body.outputPriceMicros, 0);
      const maxOutputTokens = boundedInt(body.maxOutputTokens, 256, 131072, 4096);
      const existingId = typeof body.id === 'string' ? body.id : '';
      const id = existingId || randomId('model');
      if (existingId) {
        const updated = await database.prepare(`
          UPDATE model_catalog SET provider = ?, provider_model_id = ?, display_name = ?, access_mode = ?,
            enabled = ?, input_price_micros = ?, output_price_micros = ?, max_output_tokens = ?, updated_at = datetime('now')
          WHERE id = ?
        `).bind(provider, providerModelId, displayName, accessMode, enabled, inputPriceMicros, outputPriceMicros, maxOutputTokens, id).run();
        if (!updated.meta.changes) throw new Error('找不到要編輯的模型。');
      } else {
        const duplicate = await database.prepare(
          'SELECT 1 AS found FROM model_catalog WHERE provider = ? AND provider_model_id = ? AND access_mode = ?',
        ).bind(provider, providerModelId, accessMode).first();
        if (duplicate) throw new Error('相同供應商、模型 ID 與使用方式已存在。');
        await database.prepare(`
          INSERT INTO model_catalog (
            id, provider, provider_model_id, display_name, access_mode, enabled,
            input_price_micros, output_price_micros, max_output_tokens, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
        `).bind(id, provider, providerModelId, displayName, accessMode, enabled, inputPriceMicros, outputPriceMicros, maxOutputTokens).run();
      }
      await recordAudit(admin.id, existingId ? 'model.update' : 'model.create', 'model', id, { provider, providerModelId, accessMode, enabled });
      return NextResponse.json({ ok: true });
    }

    if (action === 'set-model-enabled') {
      const database = await ensureDatabase();
      const id = typeof body.id === 'string' ? body.id : '';
      if (!id) throw new Error('缺少模型。');
      const enabled = body.enabled === true ? 1 : 0;
      const updated = await database.prepare(
        'UPDATE model_catalog SET enabled = ?, updated_at = datetime(\'now\') WHERE id = ?',
      ).bind(enabled, id).run();
      if (!updated.meta.changes) throw new Error('找不到指定的模型。');
      await recordAudit(admin.id, 'model.enabled.update', 'model', id, { enabled });
      return NextResponse.json({ ok: true });
    }

    if (action === 'update-user') {
      const database = await ensureDatabase();
      const userId = typeof body.userId === 'string' ? body.userId : '';
      if (!userId) throw new Error('缺少使用者。');
      const status = body.status === 'suspended' ? 'suspended' : 'active';
      const role = body.role === 'admin' ? 'admin' : 'user';
      const current = await database.prepare(`
        SELECT u.status, u.role, l.requests_per_minute AS requestsPerMinute,
          l.requests_per_day AS requestsPerDay, l.tokens_per_month AS tokensPerMonth,
          l.platform_cost_limit_micros AS platformCostLimitMicros,
          l.max_output_tokens AS maxOutputTokens
        FROM users u JOIN user_limits l ON l.user_id = u.id
        WHERE u.id = ?
      `).bind(userId).first<{
        status: 'active' | 'suspended'; role: 'user' | 'admin'; requestsPerMinute: number;
        requestsPerDay: number; tokensPerMonth: number; platformCostLimitMicros: number; maxOutputTokens: number;
      }>();
      if (!current) throw new Error('找不到指定的使用者。');

      const limits = {
        requestsPerMinute: boundedInt(body.requestsPerMinute, 1, 10000, 10),
        requestsPerDay: boundedInt(body.requestsPerDay, 1, 1_000_000, 100),
        tokensPerMonth: boundedInt(body.tokensPerMonth, 1000, 1_000_000_000, 1_000_000),
        platformCostLimitMicros: boundedInt(body.platformCostLimitMicros, 0, 10_000_000_000, 5_000_000),
        maxOutputTokens: boundedInt(body.maxOutputTokens, 256, 131072, 4096),
      };

      if (current.status !== status || current.role !== role) {
        await database.prepare(
          'UPDATE users SET status = ?, role = ?, updated_at = datetime(\'now\') WHERE id = ?',
        ).bind(status, role, userId).run();
      }
      if (
        current.requestsPerMinute !== limits.requestsPerMinute
        || current.requestsPerDay !== limits.requestsPerDay
        || current.tokensPerMonth !== limits.tokensPerMonth
        || current.platformCostLimitMicros !== limits.platformCostLimitMicros
        || current.maxOutputTokens !== limits.maxOutputTokens
      ) {
        await database.prepare(`
          UPDATE user_limits SET requests_per_minute = ?, requests_per_day = ?, tokens_per_month = ?,
            platform_cost_limit_micros = ?, max_output_tokens = ?, updated_at = datetime('now')
          WHERE user_id = ?
        `).bind(
          limits.requestsPerMinute,
          limits.requestsPerDay,
          limits.tokensPerMonth,
          limits.platformCostLimitMicros,
          limits.maxOutputTokens,
          userId,
        ).run();
      }
      await recordAudit(admin.id, 'user.limits.update', 'user', userId, { status, role });
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: '未知的管理操作。' }, { status: 400 });
  } catch (error) {
    const detail = error instanceof Error ? error.message : '管理設定失敗。';
    console.error('Admin configuration failed:', detail);
    const message = /internal error|reference\s*=/i.test(detail) ? '儲存失敗，請重新整理後再試。' : detail;
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function DELETE(request: Request) {
  if (!assertSameOrigin(request)) return NextResponse.json({ error: '來源驗證失敗。' }, { status: 403 });
  const admin = await requireAdmin(request);
  if (!admin) return NextResponse.json({ error: '需要管理員權限。' }, { status: 403 });
  const body = await request.json() as { action?: unknown; id?: unknown; provider?: unknown };
  if (body.action === 'delete-model') {
    const id = typeof body.id === 'string' ? body.id : '';
    if (!id) return NextResponse.json({ error: '缺少模型。' }, { status: 400 });
    const database = await ensureDatabase();
    const deleted = await database.prepare('DELETE FROM model_catalog WHERE id = ?').bind(id).run();
    if (!deleted.meta.changes) return NextResponse.json({ error: '找不到指定的模型。' }, { status: 404 });
    await recordAudit(admin.id, 'model.delete', 'model', id);
    return NextResponse.json({ ok: true });
  }
  const provider = parseProvider(body.provider);
  if (!provider) return NextResponse.json({ error: '供應商不正確。' }, { status: 400 });
  await deleteCredential('platform', 'platform', provider);
  await recordAudit(admin.id, 'credential.platform.delete', 'provider', provider);
  return NextResponse.json({ ok: true });
}

function parseProvider(value: unknown): Provider | null {
  return typeof value === 'string' && providers.has(value as Provider) ? value as Provider : null;
}

function nonNegativeInt(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : fallback;
}

function boundedInt(value: unknown, minimum: number, maximum: number, fallback: number): number {
  return Math.max(minimum, Math.min(maximum, nonNegativeInt(value, fallback)));
}

async function recordAudit(
  actorUserId: string,
  action: string,
  targetType: string,
  targetId: string | null,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  try {
    await writeAudit(actorUserId, action, targetType, targetId, metadata);
  } catch (error) {
    console.error('Audit log write failed:', error instanceof Error ? error.message : error);
  }
}
