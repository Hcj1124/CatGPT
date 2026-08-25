const encoder = new TextEncoder();

type DeliveryResult = { devCode?: string };

export async function sendVerificationEmail(email: string, code: string): Promise<DeliveryResult> {
  if (process.env.AUTH_DEV_MODE === 'true') {
    return { devCode: process.env.AUTH_DEV_VERIFICATION_CODE || code };
  }

  const provider = process.env.EMAIL_PROVIDER?.trim().toLowerCase();
  if (provider === 'brevo' || (!provider && hasBrevoConfiguration())) {
    await sendWithBrevo(email, code);
    return {};
  }
  if (provider === 'gmail' || (!provider && hasGmailConfiguration())) {
    await sendWithGmail(email, code);
    return {};
  }
  if (provider === 'resend' || (!provider && hasResendConfiguration())) {
    await sendWithResend(email, code);
    return {};
  }
  if (provider && provider !== 'brevo' && provider !== 'gmail' && provider !== 'resend') {
    throw new Error('EMAIL_PROVIDER 僅支援 brevo、gmail 或 resend。');
  }
  throw new Error('尚未設定驗證信服務。免費方案請設定 Brevo。');
}

async function sendWithBrevo(email: string, code: string): Promise<void> {
  const apiKey = process.env.BREVO_API_KEY;
  const fromEmail = process.env.BREVO_FROM_EMAIL;
  const fromName = process.env.BREVO_FROM_NAME || 'CatGPT';
  if (!apiKey || !fromEmail) throw new Error('Brevo 尚未完成設定。');

  const response = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': apiKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      sender: { name: fromName, email: fromEmail },
      to: [{ email }],
      subject: 'CatGPT 電子郵件驗證碼',
      htmlContent: verificationHtml(code),
    }),
  });
  if (!response.ok) throw new Error(`驗證信寄送失敗（Brevo ${response.status}）。`);
}

async function sendWithResend(email: string, code: string): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  if (!apiKey || !from) throw new Error('Resend 尚未完成設定。');

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
      html: verificationHtml(code),
    }),
  });
  if (!response.ok) throw new Error(`驗證信寄送失敗（Resend ${response.status}）。`);
}

async function sendWithGmail(email: string, code: string): Promise<void> {
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  const refreshToken = process.env.GMAIL_REFRESH_TOKEN;
  const fromEmail = process.env.GMAIL_FROM_EMAIL;
  if (!clientId || !clientSecret || !refreshToken || !fromEmail) {
    throw new Error('Gmail API 尚未完成設定。');
  }
  if (!/^[^\s\r\n@]+@[^\s\r\n@]+\.[^\s\r\n@]+$/.test(fromEmail)) {
    throw new Error('GMAIL_FROM_EMAIL 格式不正確。');
  }

  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const tokenResult = await tokenResponse.json() as { access_token?: string };
  if (!tokenResponse.ok || !tokenResult.access_token) {
    throw new Error(`Gmail 授權失敗（${tokenResponse.status}）。`);
  }

  const safeRecipient = email.replace(/[\r\n]/g, '');
  const subject = utf8Base64('CatGPT 電子郵件驗證碼');
  const html = utf8Base64(verificationHtml(code));
  const mimeMessage = [
    `From: CatGPT <${fromEmail}>`,
    `To: ${safeRecipient}`,
    `Subject: =?UTF-8?B?${subject}?=`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    html,
  ].join('\r\n');

  const sendResponse = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${tokenResult.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ raw: bytesToBase64Url(encoder.encode(mimeMessage)) }),
  });
  if (!sendResponse.ok) throw new Error(`驗證信寄送失敗（Gmail ${sendResponse.status}）。`);
}

function verificationHtml(code: string): string {
  return `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;padding:28px"><h2>驗證你的 CatGPT 帳號</h2><p>你的六位數驗證碼是：</p><p style="font-size:32px;font-weight:700;letter-spacing:8px">${code}</p><p>驗證碼將於 10 分鐘後失效。若你沒有註冊 CatGPT，請忽略這封信。</p></div>`;
}

function hasResendConfiguration(): boolean {
  return Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM);
}

function hasBrevoConfiguration(): boolean {
  return Boolean(process.env.BREVO_API_KEY && process.env.BREVO_FROM_EMAIL);
}

function hasGmailConfiguration(): boolean {
  return Boolean(
    process.env.GMAIL_CLIENT_ID
    && process.env.GMAIL_CLIENT_SECRET
    && process.env.GMAIL_REFRESH_TOKEN
    && process.env.GMAIL_FROM_EMAIL,
  );
}

function utf8Base64(value: string): string {
  return bytesToBase64(encoder.encode(value));
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}
