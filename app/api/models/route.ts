import { NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { getAvailableModels } from '@/lib/models';

export async function GET(request: Request) {
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ models: [] });
  return NextResponse.json({ models: await getAvailableModels(user.id) });
}
