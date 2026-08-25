import { NextResponse } from 'next/server';
import { assertSameOrigin, getSessionUser } from '@/lib/auth';
import { addAssistantMessage, addUserMessage, ensureConversation } from '@/lib/conversations';
import { completeRequest, failRequest, getAuthorizedModel, reserveRequest } from '@/lib/models';
import { createProviderResponse, getCredential } from '@/lib/providers';

export async function POST(request: Request) {
  if (!assertSameOrigin(request)) return NextResponse.json({ error: '來源驗證失敗。' }, { status: 403 });
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ error: '請先登入後再開始對話。' }, { status: 401 });

  let reservation: { usageId: string; reservedCostMicros: number; maxOutputTokens: number } | null = null;
  try {
    const body = await request.json() as {
      message?: unknown;
      model?: unknown;
      mode?: unknown;
      conversationId?: unknown;
      temporary?: unknown;
    };
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    const modelId = typeof body.model === 'string' ? body.model : '';
    const mode = body.mode === 'work' ? 'work' : 'chat';
    const temporary = body.temporary === true;
    const requestedConversationId = typeof body.conversationId === 'string' && body.conversationId
      ? body.conversationId
      : null;

    if (!message || message.length > 20_000) {
      return NextResponse.json({ error: '訊息不可為空，且長度需少於 20,000 字元。' }, { status: 400 });
    }
    const model = await getAuthorizedModel(user.id, modelId);
    if (!model) return NextResponse.json({ error: '此模型目前不可使用，請重新選擇模型。' }, { status: 403 });
    const ownerType = model.access_mode === 'platform' ? 'platform' : 'user';
    const ownerId = model.access_mode === 'platform' ? 'platform' : user.id;
    const credential = await getCredential(ownerType, ownerId, model.provider);
    if (!credential) return NextResponse.json({ error: '找不到此模型所需的 API Key。' }, { status: 503 });
    const conversation = temporary
      ? null
      : await ensureConversation(user.id, requestedConversationId, message, mode);
    if (conversation) await addUserMessage(conversation.id, message);
    reservation = await reserveRequest(user.id, model, message);
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
