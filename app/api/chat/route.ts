import { NextResponse } from 'next/server';
import { assertSameOrigin, getSessionUser } from '@/lib/auth';
import { addAssistantMessage, addUserMessage, ensureConversation } from '@/lib/conversations';
import { completeRequest, failRequest, getAuthorizedModel, reserveRequest } from '@/lib/models';
import { createProviderResponse, getCredential, type ProviderAttachment } from '@/lib/providers';

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_REQUEST_BYTES = 15 * 1024 * 1024;
const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp']);
const FILE_EXTENSIONS = new Set([
  ...IMAGE_EXTENSIONS,
  'pdf', 'txt', 'md', 'json', 'html', 'xml', 'csv', 'tsv',
  'doc', 'docx', 'rtf', 'odt', 'ppt', 'pptx', 'xls', 'xlsx',
  'js', 'jsx', 'ts', 'tsx', 'py', 'java', 'c', 'cpp', 'css', 'yaml', 'yml',
]);

function parseAttachment(value: unknown): ProviderAttachment | undefined {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== 'object') throw new Error('附件格式無效。');

  const candidate = value as { name?: unknown; dataUrl?: unknown };
  const rawName = typeof candidate.name === 'string' ? candidate.name.trim() : '';
  const name = rawName.split(/[\\/]/).pop() || '';
  const dataUrl = typeof candidate.dataUrl === 'string' ? candidate.dataUrl : '';
  if (!name || name.length > 180) throw new Error('附件檔名無效或過長。');

  const extension = name.includes('.') ? name.split('.').pop()?.toLowerCase() || '' : '';
  if (!FILE_EXTENSIONS.has(extension)) throw new Error('不支援此附件格式。');

  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(dataUrl);
  if (!match) throw new Error('附件內容格式無效。');
  const base64 = match[2];
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  const decodedBytes = Math.floor((base64.length * 3) / 4) - padding;
  if (decodedBytes <= 0 || decodedBytes > MAX_ATTACHMENT_BYTES) {
    throw new Error('附件需小於 10 MB，且內容不可為空。');
  }

  const mimeType = match[1].toLowerCase();
  if (IMAGE_EXTENSIONS.has(extension) && !mimeType.startsWith('image/')) {
    throw new Error('圖片附件格式無效。');
  }
  return {
    name,
    mimeType,
    dataUrl,
    kind: IMAGE_EXTENSIONS.has(extension) ? 'image' : 'file',
  };
}

export async function POST(request: Request) {
  if (!assertSameOrigin(request)) return NextResponse.json({ error: '來源驗證失敗。' }, { status: 403 });
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ error: '請先登入後再開始對話。' }, { status: 401 });
  const contentLength = Number(request.headers.get('content-length') || 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    return NextResponse.json({ error: '附件過大，請上傳小於 10 MB 的檔案。' }, { status: 413 });
  }

  let reservation: { usageId: string; reservedCostMicros: number; maxOutputTokens: number } | null = null;
  try {
    const body = await request.json() as {
      message?: unknown;
      model?: unknown;
      mode?: unknown;
      conversationId?: unknown;
      temporary?: unknown;
      attachment?: unknown;
    };
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    const modelId = typeof body.model === 'string' ? body.model : '';
    const mode = body.mode === 'work' ? 'work' : 'chat';
    const temporary = body.temporary === true;
    const requestedConversationId = typeof body.conversationId === 'string' && body.conversationId
      ? body.conversationId
      : null;

    let attachment: ProviderAttachment | undefined;
    try {
      attachment = parseAttachment(body.attachment);
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : '附件格式無效。' }, { status: 400 });
    }
    if ((!message && !attachment) || message.length > 20_000) {
      return NextResponse.json({ error: '請輸入訊息或加入附件，且訊息長度需少於 20,000 字元。' }, { status: 400 });
    }
    const storedMessage = attachment
      ? `${message || '請分析附件'}\n\n[附件：${attachment.name}]`
      : message;
    const model = await getAuthorizedModel(user.id, modelId);
    if (!model) return NextResponse.json({ error: '此模型目前不可使用，請重新選擇模型。' }, { status: 403 });
    const ownerType = model.access_mode === 'platform' ? 'platform' : 'user';
    const ownerId = model.access_mode === 'platform' ? 'platform' : user.id;
    const credential = await getCredential(ownerType, ownerId, model.provider);
    if (!credential) return NextResponse.json({ error: '找不到此模型所需的 API Key。' }, { status: 503 });
    const conversation = temporary
      ? null
      : await ensureConversation(user.id, requestedConversationId, storedMessage, mode);
    if (conversation) await addUserMessage(conversation.id, storedMessage);
    reservation = await reserveRequest(user.id, model, storedMessage);
    const result = await createProviderResponse(
      model.provider,
      credential.apiKey,
      model.provider_model_id,
      message,
      mode === 'work'
        ? 'You are a focused work assistant. Help the user plan, analyze, organize, and produce clear deliverables. Reply in Traditional Chinese unless asked otherwise.'
        : 'You are a helpful conversational AI assistant. Reply in Traditional Chinese unless asked otherwise.',
      reservation.maxOutputTokens,
      credential.endpointUrl,
      attachment,
    );
    await completeRequest(reservation.usageId, user.id, model, reservation.reservedCostMicros, result.usage, result.requestId);
    if (conversation) {
      await addAssistantMessage(
        conversation.id,
        result.text,
        model.provider,
        model.provider_model_id,
        model.access_mode,
        result.usage,
      );
    }
    return NextResponse.json({ reply: result.text, usage: result.usage, conversation });
  } catch (error) {
    if (reservation) {
      await failRequest(
        reservation.usageId,
        user.id,
        reservation.reservedCostMicros,
        error instanceof Error ? error.message : 'unknown_error',
      );
    }
    console.error('Model request failed', error);
    return NextResponse.json({ error: error instanceof Error ? error.message : '模型目前無法回應。' }, { status: 502 });
  }
}
