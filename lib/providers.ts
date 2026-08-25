import OpenAI from 'openai';
import { decryptSecret, encryptSecret, randomId, sha256 } from './security';
import { ensureDatabase } from './db';

export type Provider = 'openai' | 'anthropic' | 'google' | 'cloudflare' | 'huggingface' | 'compatible';
export type CredentialOwner = 'platform' | 'user';

export type ProviderUsage = {
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
};

export type ProviderReply = {
  text: string;
  requestId?: string;
  usage: ProviderUsage;
};

export type ProviderAttachment = {
  name: string;
  mimeType: string;
  dataUrl: string;
  kind: 'image' | 'file';
};

type CredentialRow = {
  encrypted_key: string;
  key_iv: string;
  endpoint_url: string;
};

export async function validateProviderKey(provider: Provider, apiKey: string, endpointUrl = ''): Promise<boolean> {
  const key = apiKey.trim();
  if (key.length < 12) return false;
  const compatibleBaseUrl = resolveCompatibleBaseUrl(provider, endpointUrl);
  const endpoint = compatibleBaseUrl
    ? `${compatibleBaseUrl}/models`
    : provider === 'openai'
    ? 'https://api.openai.com/v1/models'
    : provider === 'anthropic'
      ? 'https://api.anthropic.com/v1/models?limit=1'
      : `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}&pageSize=1`;
  const headers: Record<string, string> = provider === 'openai' || compatibleBaseUrl
    ? { Authorization: `Bearer ${key}` }
    : provider === 'anthropic'
      ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
      : {};
  try {
    const response = await fetch(endpoint, { headers });
    if (response.ok) return true;
    if (response.status === 401) throw new Error('API Key 無效，請確認是否已完整複製。');
    if (response.status === 403) throw new Error('API Key 已被拒絕，請確認該 Project 的權限。');
    throw new Error(`供應商驗證失敗（HTTP ${response.status}）。`);
  } catch (error) {
    if (error instanceof Error && /^API Key |供應商驗證失敗/.test(error.message)) throw error;
    throw new Error('本機伺服器無法連線至模型供應商，請先允許開發伺服器使用外部網路。');
  }
}

export async function validateProviderModel(
  provider: Provider,
  apiKey: string,
  modelId: string,
  endpointUrl = '',
): Promise<boolean> {
  const key = apiKey.trim();
  const model = modelId.trim();
  if (!key || !model) return false;

  try {
    if (provider === 'openai') {
      const response = await fetch(`https://api.openai.com/v1/models/${encodeURIComponent(model)}`, {
        headers: { Authorization: `Bearer ${key}` },
      });
      return response.ok;
    }

    if (provider === 'anthropic') {
      const response = await fetch(`https://api.anthropic.com/v1/models/${encodeURIComponent(model)}`, {
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      });
      return response.ok;
    }

    if (provider === 'google') {
      const normalizedModel = model.replace(/^models\//, '');
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(normalizedModel)}?key=${encodeURIComponent(key)}`,
      );
      return response.ok;
    }

    const baseUrl = resolveCompatibleBaseUrl(provider, endpointUrl);
    if (!baseUrl) return false;
    const response = await fetch(`${baseUrl}/models`, { headers: { Authorization: `Bearer ${key}` } });
    if (!response.ok) return false;
    const payload = await response.json() as { data?: Array<{ id?: string }> };
    return payload.data?.some((item) => item.id === model) ?? false;
  } catch {
    return false;
  }
}

export async function saveCredential(
  ownerType: CredentialOwner,
  ownerId: string,
  provider: Provider,
  apiKey: string,
  endpointUrl = '',
): Promise<{ last4: string; fingerprint: string }> {
  const normalizedEndpoint = resolveCompatibleBaseUrl(provider, endpointUrl) ?? '';
  if (provider === 'cloudflare' && !normalizedEndpoint) throw new Error('請輸入 Cloudflare Workers AI 的 Account ID。');
  if (provider === 'compatible' && !normalizedEndpoint) throw new Error('請輸入有效的 HTTPS OpenAI-compatible 端點。');
  if (!(await validateProviderKey(provider, apiKey, endpointUrl))) throw new Error('API Key 格式不正確。');
  const database = await ensureDatabase();
  const cleanKey = apiKey.trim();
  const encrypted = await encryptSecret(cleanKey);
  const fingerprint = (await sha256(cleanKey)).slice(0, 16);
  const last4 = cleanKey.slice(-4);
  const now = new Date().toISOString();
  const existing = await database.prepare(`
    SELECT id FROM provider_credentials
    WHERE owner_type = ? AND owner_id = ? AND provider = ?
  `).bind(ownerType, ownerId, provider).first<{ id: string }>();
  try {
    if (existing) {
      await database.prepare(`
        UPDATE provider_credentials SET encrypted_key = ?, key_iv = ?, endpoint_url = ?, key_last4 = ?,
          key_fingerprint = ?, verified_at = ?, status = 'active', updated_at = ?
        WHERE id = ?
      `).bind(
        encrypted.ciphertext, encrypted.iv, normalizedEndpoint, last4, fingerprint, now, now, existing.id,
      ).run();
    } else {
      await database.prepare(`
        INSERT INTO provider_credentials (
          id, owner_type, owner_id, provider, encrypted_key, key_iv, endpoint_url, key_last4,
          key_fingerprint, verified_at, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
      `).bind(
        randomId('cred'), ownerType, ownerId, provider, encrypted.ciphertext, encrypted.iv, normalizedEndpoint,
        last4, fingerprint, now, now, now,
      ).run();
    }
  } catch (error) {
    console.error('Credential storage failed:', error instanceof Error ? error.message : error);
    throw new Error('API Key 已通過供應商驗證，但儲存至資料庫失敗。');
  }
  return { last4, fingerprint };
}

export async function deleteCredential(ownerType: CredentialOwner, ownerId: string, provider: Provider): Promise<void> {
  const database = await ensureDatabase();
  await database.prepare(`
    UPDATE provider_credentials SET status = 'revoked', updated_at = datetime('now')
    WHERE owner_type = ? AND owner_id = ? AND provider = ?
  `).bind(ownerType, ownerId, provider).run();
}

export async function getCredential(ownerType: CredentialOwner, ownerId: string, provider: Provider): Promise<{ apiKey: string; endpointUrl: string } | null> {
  const database = await ensureDatabase();
  const row = await database.prepare(`
    SELECT encrypted_key, key_iv, endpoint_url FROM provider_credentials
    WHERE owner_type = ? AND owner_id = ? AND provider = ? AND status = 'active'
  `).bind(ownerType, ownerId, provider).first<CredentialRow>();
  return row ? { apiKey: await decryptSecret(row.encrypted_key, row.key_iv), endpointUrl: row.endpoint_url } : null;
}

export async function createProviderResponse(
  provider: Provider,
  apiKey: string,
  model: string,
  message: string,
  instructions: string,
  maxOutputTokens: number,
  endpointUrl = '',
  attachment?: ProviderAttachment,
  signal?: AbortSignal,
): Promise<ProviderReply> {
  if (provider === 'openai') {
    const client = new OpenAI({ apiKey });
    const input = attachment
      ? [{
          role: 'user' as const,
          content: [
            { type: 'input_text' as const, text: message || '請分析這份附件。' },
            attachment.kind === 'image'
              ? { type: 'input_image' as const, image_url: attachment.dataUrl, detail: 'auto' as const }
              : { type: 'input_file' as const, filename: attachment.name, file_data: attachment.dataUrl },
          ],
        }]
      : message;
    const response = await client.responses.create(
      {
        model,
        instructions,
        input,
        max_output_tokens: maxOutputTokens,
        store: false,
      },
      { signal },
    );
    return {
      text: response.output_text,
      requestId: response.id,
      usage: {
        inputTokens: response.usage?.input_tokens ?? 0,
        cachedTokens: response.usage?.input_tokens_details?.cached_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
      },
    };
  }

  if (attachment) throw new Error('附件目前僅支援 OpenAI 模型。');

  if (provider === 'anthropic') {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        system: instructions,
        messages: [{ role: 'user', content: message }],
        max_tokens: maxOutputTokens,
      }),
      signal,
    });
    const data = await response.json() as {
      id?: string;
      content?: Array<{ type: string; text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
      error?: { message?: string };
    };
    if (!response.ok) throw new Error(data.error?.message || `Anthropic API 錯誤（${response.status}）`);
    return {
      text: data.content?.filter((item) => item.type === 'text').map((item) => item.text || '').join('\n') || '',
      requestId: data.id,
      usage: {
        inputTokens: data.usage?.input_tokens ?? 0,
        cachedTokens: data.usage?.cache_read_input_tokens ?? 0,
        outputTokens: data.usage?.output_tokens ?? 0,
      },
    };
  }

  if (provider === 'cloudflare' || provider === 'huggingface' || provider === 'compatible') {
    const baseURL = resolveCompatibleBaseUrl(provider, endpointUrl);
    if (!baseURL) throw new Error('OpenAI-compatible 端點尚未設定。');
    const client = new OpenAI({ apiKey, baseURL });
    const response = await client.chat.completions.create(
      {
        model,
        messages: [
          { role: 'system', content: instructions },
          { role: 'user', content: message },
        ],
        max_tokens: maxOutputTokens,
      },
      { signal },
    );
    return {
      text: response.choices[0]?.message?.content || '',
      requestId: response.id,
      usage: {
        inputTokens: response.usage?.prompt_tokens ?? 0,
        cachedTokens: response.usage?.prompt_tokens_details?.cached_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
      },
    };
  }

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: instructions }] },
        contents: [{ role: 'user', parts: [{ text: message }] }],
        generationConfig: { maxOutputTokens },
      }),
      signal,
    },
  );
  const data = await response.json() as {
    responseId?: string;
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    usageMetadata?: { promptTokenCount?: number; cachedContentTokenCount?: number; candidatesTokenCount?: number };
    error?: { message?: string };
  };
  if (!response.ok) throw new Error(data.error?.message || `Google API 錯誤（${response.status}）`);
  return {
    text: data.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('') || '',
    requestId: data.responseId,
    usage: {
      inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
      cachedTokens: data.usageMetadata?.cachedContentTokenCount ?? 0,
      outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
    },
  };
}

function resolveCompatibleBaseUrl(provider: Provider, value: string): string | null {
  if (provider === 'huggingface') return 'https://router.huggingface.co/v1';
  if (provider === 'cloudflare') {
    const accountId = value.trim();
    if (!/^[a-f0-9]{32}$/i.test(accountId)) return null;
    return `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`;
  }
  if (provider !== 'compatible') return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:') return null;
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}
