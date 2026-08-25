import { NextResponse } from 'next/server';
import { assertSameOrigin, getSessionUser } from '@/lib/auth';
import { deleteConversation, getConversationDetail, listConversations, updateConversation } from '@/lib/conversations';

export async function GET(request: Request) {
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ error: '請先登入。' }, { status: 401 });
  const searchParams = new URL(request.url).searchParams;
  const conversationId = searchParams.get('id');
  const search = (searchParams.get('search') ?? '').slice(0, 100);
  if (!conversationId) return NextResponse.json({ conversations: await listConversations(user.id, search) });
  const detail = await getConversationDetail(user.id, conversationId);
  return detail
    ? NextResponse.json(detail)
    : NextResponse.json({ error: '找不到這段對話。' }, { status: 404 });
}

export async function PATCH(request: Request) {
  if (!assertSameOrigin(request)) return NextResponse.json({ error: '來源驗證失敗。' }, { status: 403 });
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ error: '請先登入。' }, { status: 401 });
  try {
    const body = await request.json() as { id?: unknown; title?: unknown; isPinned?: unknown };
    const id = typeof body.id === 'string' ? body.id : '';
    if (!id) throw new Error('缺少對話 ID。');
    await updateConversation(user.id, id, {
      title: typeof body.title === 'string' ? body.title : undefined,
      isPinned: typeof body.isPinned === 'boolean' ? body.isPinned : undefined,
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : '無法更新對話。' }, { status: 400 });
  }
}

export async function DELETE(request: Request) {
  if (!assertSameOrigin(request)) return NextResponse.json({ error: '來源驗證失敗。' }, { status: 403 });
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ error: '請先登入。' }, { status: 401 });
  try {
    const body = await request.json() as { id?: unknown };
    const id = typeof body.id === 'string' ? body.id : '';
    if (!id) throw new Error('缺少對話 ID。');
    await deleteConversation(user.id, id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : '無法刪除對話。' }, { status: 400 });
  }
}
