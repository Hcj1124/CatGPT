export async function sendVerificationEmail(email: string, code: string): Promise<{ devCode?: string }> {
  if (process.env.AUTH_DEV_MODE === 'true') {
    return { devCode: process.env.AUTH_DEV_VERIFICATION_CODE || code };
  }

  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  if (!apiKey || !from) throw new Error('尚未設定 RESEND_API_KEY 與 EMAIL_FROM。');

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': `catgpt-verify-${email}-${Math.floor(Date.now() / 60_000)}`,
    },
    body: JSON.stringify({
      from,
      to: [email],
      subject: 'CatGPT 電子郵件驗證碼',
      html: `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;padding:28px"><h2>驗證你的 CatGPT 帳號</h2><p>你的六位數驗證碼是：</p><p style="font-size:32px;font-weight:700;letter-spacing:8px">${code}</p><p>驗證碼將於 10 分鐘後失效。若你沒有註冊 CatGPT，請忽略這封信。</p></div>`,
    }),
  });
  if (!response.ok) throw new Error(`驗證信寄送失敗（${response.status}）。`);
  return {};
}
