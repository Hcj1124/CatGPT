import { ensureDatabase } from './db';
import type { Provider, ProviderUsage } from './providers';
import { randomId } from './security';

export type AvailableModel = {
  id: string;
  provider: Provider;
  providerModelId: string;
  name: string;
  accessMode: 'platform' | 'byok';
  maxOutputTokens: number;
};

type ModelRow = {
  id: string;
  provider: Provider;
  provider_model_id: string;
  display_name: string;
  access_mode: 'platform' | 'byok';
  max_output_tokens: number;
  input_price_micros: number;
  output_price_micros: number;
};

type LimitRow = {
  requests_per_minute: number;
  requests_per_day: number;
  tokens_per_month: number;
  platform_cost_limit_micros: number;
  max_output_tokens: number;
};

export async function getAvailableModels(userId: string): Promise<AvailableModel[]> {
  const database = await ensureDatabase();
  const result = await database.prepare(`
    SELECT m.id, m.provider, m.provider_model_id, m.display_name, m.access_mode,
           m.max_output_tokens, m.input_price_micros, m.output_price_micros
    FROM model_catalog m
    WHERE m.enabled = 1 AND (
      (m.access_mode = 'platform' AND EXISTS (
        SELECT 1 FROM provider_credentials c
        WHERE c.owner_type = 'platform' AND c.owner_id = 'platform'
          AND c.provider = m.provider AND c.status = 'active'
      ))
      OR
      (m.access_mode = 'byok' AND EXISTS (
        SELECT 1 FROM provider_credentials c
        WHERE c.owner_type = 'user' AND c.owner_id = ?
          AND c.provider = m.provider AND c.status = 'active'
      ))
    )
    ORDER BY CASE m.access_mode WHEN 'platform' THEN 0 ELSE 1 END, m.display_name
  `).bind(userId).all<ModelRow>();
  return result.results.map(toAvailableModel);
}

export async function getAuthorizedModel(userId: string, modelId: string): Promise<ModelRow | null> {
  const models = await getAvailableModelRows(userId);
  return models.find((model) => model.id === modelId) ?? null;
}

export async function getUsageSummary(userId: string): Promise<{
  requests: number;
  tokens: number;
  platformCostMicros: number;
  limits: LimitRow;
}> {
  const database = await ensureDatabase();
  const limits = await getLimits(userId);
  const period = monthPeriod();
  const balance = await database.prepare(`
    SELECT requests_used, tokens_used, platform_cost_used_micros
    FROM usage_balances WHERE user_id = ? AND period = ?
  `).bind(userId, period).first<{ requests_used: number; tokens_used: number; platform_cost_used_micros: number }>();
  return {
    requests: balance?.requests_used ?? 0,
    tokens: balance?.tokens_used ?? 0,
    platformCostMicros: balance?.platform_cost_used_micros ?? 0,
    limits,
  };
}

export async function reserveRequest(
  userId: string,
  model: ModelRow,
  message: string,
): Promise<{ usageId: string; reservedCostMicros: number; maxOutputTokens: number }> {
  const database = await ensureDatabase();
  const limits = await getLimits(userId);
  const minuteKey = `chat:${userId}:${Math.floor(Date.now() / 60_000)}`;
  await database.prepare(`
    INSERT INTO rate_limit_windows (key, window_start, count, updated_at)
    VALUES (?, ?, 1, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET count = count + 1, updated_at = datetime('now')
  `).bind(minuteKey, Math.floor(Date.now() / 60_000)).run();
  const minute = await database.prepare('SELECT count FROM rate_limit_windows WHERE key = ?')
    .bind(minuteKey).first<{ count: number }>();
  if ((minute?.count ?? 0) > limits.requests_per_minute) throw new Error('每分鐘請求次數已達上限，請稍後再試。');

  const daily = dayPeriod();
  const dailyResult = await database.prepare(`
    INSERT INTO usage_balances (user_id, period, requests_used, updated_at)
    VALUES (?, ?, 1, datetime('now'))
    ON CONFLICT(user_id, period) DO UPDATE SET
      requests_used = requests_used + 1,
      updated_at = datetime('now')
    WHERE requests_used < ?
  `).bind(userId, daily, limits.requests_per_day).run();
  if ((dailyResult.meta.changes ?? 0) === 0) throw new Error('今日訊息額度已用完。');

  const maxOutputTokens = Math.min(model.max_output_tokens, limits.max_output_tokens);
  const estimatedInputTokens = Math.max(1, Math.ceil(message.length / 4));
  const estimatedOutputTokens = Math.min(maxOutputTokens, 1024);
  const reservedCostMicros = model.access_mode === 'platform'
    ? Math.ceil((estimatedInputTokens * model.input_price_micros + estimatedOutputTokens * model.output_price_micros) / 1_000_000)
    : 0;
  const monthly = monthPeriod();
  const monthlyResult = await database.prepare(`
    INSERT INTO usage_balances (user_id, period, requests_used, reserved_cost_micros, updated_at)
    VALUES (?, ?, 1, ?, datetime('now'))
    ON CONFLICT(user_id, period) DO UPDATE SET
      requests_used = requests_used + 1,
      reserved_cost_micros = reserved_cost_micros + excluded.reserved_cost_micros,
      updated_at = datetime('now')
    WHERE tokens_used < ?
      AND platform_cost_used_micros + reserved_cost_micros + excluded.reserved_cost_micros <= ?
  `).bind(userId, monthly, reservedCostMicros, limits.tokens_per_month, limits.platform_cost_limit_micros).run();
  if ((monthlyResult.meta.changes ?? 0) === 0) throw new Error('本月平台額度已用完，請使用自己的 API Key 或聯絡管理員。');

  const usageId = randomId('usage');
  await database.prepare(`
    INSERT INTO usage_events (
      id, user_id, provider, model_id, credential_source, estimated_cost_micros, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'reserved', datetime('now'))
  `).bind(usageId, userId, model.provider, model.provider_model_id, model.access_mode, reservedCostMicros).run();
  return { usageId, reservedCostMicros, maxOutputTokens };
}

export async function completeRequest(
  usageId: string,
  userId: string,
  model: ModelRow,
  reservedCostMicros: number,
  usage: ProviderUsage,
  providerRequestId?: string,
): Promise<void> {
  const database = await ensureDatabase();
  const actualCost = model.access_mode === 'platform'
    ? Math.ceil((usage.inputTokens * model.input_price_micros + usage.outputTokens * model.output_price_micros) / 1_000_000)
    : 0;
  await database.batch([
    database.prepare(`
      UPDATE usage_events SET input_tokens = ?, cached_tokens = ?, output_tokens = ?,
        estimated_cost_micros = ?, status = 'completed', provider_request_id = ?, completed_at = datetime('now')
      WHERE id = ?
    `).bind(usage.inputTokens, usage.cachedTokens, usage.outputTokens, actualCost, providerRequestId ?? null, usageId),
    database.prepare(`
      UPDATE usage_balances SET
        tokens_used = tokens_used + ?,
        platform_cost_used_micros = platform_cost_used_micros + ?,
        reserved_cost_micros = MAX(0, reserved_cost_micros - ?),
        updated_at = datetime('now')
      WHERE user_id = ? AND period = ?
    `).bind(usage.inputTokens + usage.outputTokens, actualCost, reservedCostMicros, userId, monthPeriod()),
  ]);
}

export async function failRequest(usageId: string, userId: string, reservedCostMicros: number, errorCode: string): Promise<void> {
  const database = await ensureDatabase();
  await database.batch([
    database.prepare(`
      UPDATE usage_events SET status = 'failed', error_code = ?, completed_at = datetime('now') WHERE id = ?
    `).bind(errorCode.slice(0, 120), usageId),
    database.prepare(`
      UPDATE usage_balances SET reserved_cost_micros = MAX(0, reserved_cost_micros - ?), updated_at = datetime('now')
      WHERE user_id = ? AND period = ?
    `).bind(reservedCostMicros, userId, monthPeriod()),
  ]);
}

async function getAvailableModelRows(userId: string): Promise<ModelRow[]> {
  const database = await ensureDatabase();
  const result = await database.prepare(`
    SELECT m.id, m.provider, m.provider_model_id, m.display_name, m.access_mode,
           m.max_output_tokens, m.input_price_micros, m.output_price_micros
    FROM model_catalog m
    WHERE m.enabled = 1 AND (
      (m.access_mode = 'platform' AND EXISTS (
        SELECT 1 FROM provider_credentials c WHERE c.owner_type = 'platform'
          AND c.owner_id = 'platform' AND c.provider = m.provider AND c.status = 'active'
      )) OR
      (m.access_mode = 'byok' AND EXISTS (
        SELECT 1 FROM provider_credentials c WHERE c.owner_type = 'user'
          AND c.owner_id = ? AND c.provider = m.provider AND c.status = 'active'
      ))
    )
  `).bind(userId).all<ModelRow>();
  return result.results;
}

async function getLimits(userId: string): Promise<LimitRow> {
  const database = await ensureDatabase();
  await database.prepare(`
    INSERT OR IGNORE INTO user_limits (user_id, updated_at) VALUES (?, datetime('now'))
  `).bind(userId).run();
  const limits = await database.prepare('SELECT * FROM user_limits WHERE user_id = ?').bind(userId).first<LimitRow>();
  if (!limits) throw new Error('無法讀取使用者額度。');
  return limits;
}

function toAvailableModel(row: ModelRow): AvailableModel {
  return {
    id: row.id,
    provider: row.provider,
    providerModelId: row.provider_model_id,
    name: row.display_name,
    accessMode: row.access_mode,
    maxOutputTokens: row.max_output_tokens,
  };
}

function dayPeriod(): string {
  return `day:${new Date().toISOString().slice(0, 10)}`;
}

function monthPeriod(): string {
  return `month:${new Date().toISOString().slice(0, 7)}`;
}
