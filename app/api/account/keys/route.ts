import { NextResponse } from 'next/server';
import { assertSameOrigin, getSessionUser, writeAudit } from '@/lib/auth';
import { ensureDatabase } from '@/lib/db';
import { getUsageSummary } from '@/lib/models';
import { deleteCredential, saveCredential, type Provider } from '@/lib/providers';

const providers = new Set<Provider>(['openai', 'anthropic', 'google', 'cloudflare', 'huggingface', 'compatible']);

export async function GET(request: Request) {
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ error: '請先登入。' }, { status: 401 });
  const database = await ensureDatabase();
  const credentials = await database.prepare(`
    SELECT provider, key_last4 AS last4, verified_at AS verifiedAt, status
    FROM provider_credentials
    WHERE owner_type = 'user' AND owner_id = ? AND status != 'revoked'
    ORDER BY provider
  `).bind(user.id).all<{ provider: Provider; last4: string; verifiedAt: string; status: string }>();
  return NextResponse.json({ credentials: credentials.results, usage: await getUsageSummary(user.id) });
}

export async function POST(request: Request) {
  if (!assertSameOrigin(request)) return NextResponse.json({ error: '來源驗證失敗。' }, { status: 403 });
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ error: '請先登入。' }, { status: 401 });
  try {
    const body = await request.json() as { provider?: unknown; apiKey?: unknown; endpointUrl?: unknown };
    const provider = typeof body.provider === 'string' && providers.has(body.provider as Provider)
      ? body.provider as Provider
      : null;
    const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
    if (!provider || !apiKey) return NextResponse.json({ error: '請選擇供應商並輸入 API Key。' }, { status: 400 });
    const endpointUrl = typeof body.endpointUrl === 'string' ? body.endpointUrl.trim() : '';
    const result = await saveCredential('user', user.id, provider, apiKey, endpointUrl);
    await writeAudit(user.id, 'credential.user.save', 'provider', provider, { fingerprint: result.fingerprint });
    return NextResponse.json({ ok: true, last4: result.last4 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : '無法儲存 API Key。' }, { status: 400 });
  }
}

export async function DELETE(request: Request) {
  if (!assertSameOrigin(request)) return NextResponse.json({ error: '來源驗證失敗。' }, { status: 403 });
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ error: '請先登入。' }, { status: 401 });
  const body = await request.json() as { provider?: unknown };
  const provider = typeof body.provider === 'string' && providers.has(body.provider as Provider)
    ? body.provider as Provider
    : null;
  if (!provider) return NextResponse.json({ error: '供應商不正確。' }, { status: 400 });
  await deleteCredential('user', user.id, provider);
  await writeAudit(user.id, 'credential.user.delete', 'provider', provider);
  return NextResponse.json({ ok: true });
}
