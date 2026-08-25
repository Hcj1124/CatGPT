'use client';

import { Camera, Check, KeyRound, LoaderCircle, Pencil, ShieldCheck, Trash2, X } from 'lucide-react';
import { FormEvent, useEffect, useMemo, useState } from 'react';
import type { SessionUser } from '@/lib/auth';

type Provider = 'openai' | 'anthropic' | 'google' | 'cloudflare' | 'huggingface' | 'compatible';
type Credential = { provider: Provider; last4: string; verifiedAt: string; status: string };
type Usage = {
  requests: number;
  tokens: number;
  platformCostMicros: number;
  limits: {
    requests_per_minute: number;
    requests_per_day: number;
    tokens_per_month: number;
    platform_cost_limit_micros: number;
  };
};

const providerNames: Record<Provider, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google Gemini',
  cloudflare: 'Cloudflare Workers AI',
  huggingface: 'Hugging Face',
  compatible: '自訂 OpenAI-compatible',
};

export function AuthModal({ onClose, onAuthenticated }: { onClose: () => void; onAuthenticated: () => Promise<void> }) {
  const [step, setStep] = useState<'email' | 'password' | 'register' | 'verify'>('email');
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [code, setCode] = useState('');
  const [devCode, setDevCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      if (step === 'email') {
        const result = await api<{ exists: boolean }>('/api/auth/identify', { email });
        setStep(result.exists ? 'password' : 'register');
      } else if (step === 'password') {
        await api('/api/auth/login', { email, password });
        await onAuthenticated();
        onClose();
      } else if (step === 'register') {
        const result = await api<{ devCode?: string }>('/api/auth/register/start', {
          email, username, password, confirmPassword,
        });
        setDevCode(result.devCode ?? '');
        setStep('verify');
      } else {
        await api('/api/auth/register/verify', { email, code });
        await onAuthenticated();
        onClose();
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '操作失敗，請稍後再試。');
    } finally {
      setBusy(false);
    }
  }

  const title = step === 'email' ? '登入或建立帳號'
    : step === 'password' ? '輸入密碼'
      : step === 'register' ? '建立 CatGPT 帳號' : '驗證電子郵件';

  return (
    <Modal title={title} onClose={onClose} width="small">
      <form className="modal-form" onSubmit={submit}>
        {step === 'email' && (
          <>
            <p className="modal-lead">輸入電子郵件，我們會自動帶你前往登入或註冊。</p>
            <Field label="電子郵件"><input autoFocus type="email" value={email} onChange={(event) => setEmail(event.target.value)} required /></Field>
          </>
        )}
        {step === 'password' && (
          <>
            <AccountPill email={email} onBack={() => { setStep('email'); setPassword(''); }} />
            <Field label="密碼"><input autoFocus type="password" value={password} onChange={(event) => setPassword(event.target.value)} required /></Field>
          </>
        )}
        {step === 'register' && (
          <>
            <AccountPill email={email} onBack={() => setStep('email')} />
            <Field label="使用者名稱"><input autoFocus value={username} onChange={(event) => setUsername(event.target.value)} minLength={2} maxLength={40} required /></Field>
            <Field label="密碼" hint="至少 8 個字元，包含英文字母與數字"><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} minLength={8} required /></Field>
            <Field label="確認密碼"><input type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} minLength={8} required /></Field>
          </>
        )}
        {step === 'verify' && (
          <>
            <p className="modal-lead">驗證碼已寄至 <strong>{email}</strong>，請在 10 分鐘內完成驗證。</p>
            {devCode && <div className="dev-code">本機測試驗證碼：<strong>{devCode}</strong></div>}
            <Field label="六位數驗證碼"><input autoFocus className="verification-input" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))} required /></Field>
            <button className="text-button" type="button" onClick={() => setStep('register')}>重新填寫或寄送</button>
          </>
        )}
        {error && <p className="form-error">{error}</p>}
        <button className="primary-button" type="submit" disabled={busy}>
          {busy && <LoaderCircle className="spin" size={17} />}
          {step === 'email' ? '繼續' : step === 'password' ? '登入' : step === 'register' ? '寄送驗證碼' : '完成註冊'}
        </button>
      </form>
    </Modal>
  );
}

export function ProfileModal({
  user,
  onClose,
  onProfileChanged,
}: {
  user: SessionUser;
  onClose: () => void;
  onProfileChanged: () => Promise<void>;
}) {
  const [username, setUsername] = useState(user.username);
  const [avatar, setAvatar] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const preview = useMemo(() => avatar ? URL.createObjectURL(avatar) : null, [avatar]);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  async function saveProfile(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setMessage('');
    try {
      await api('/api/account/profile', { username }, 'PATCH');
      if (avatar) {
        const form = new FormData();
        form.append('avatar', avatar);
        const response = await fetch('/api/account/profile', { method: 'POST', body: form });
        const result = await response.json() as { error?: string };
        if (!response.ok) throw new Error(result.error || '頭像上傳失敗。');
      }
      await onProfileChanged();
      setAvatar(null);
      setMessage('個人資料已更新。');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '個人資料更新失敗。');
    } finally { setBusy(false); }
  }

  async function removeAvatar() {
    setBusy(true); setMessage('');
    try {
      await api('/api/account/profile', {}, 'DELETE');
      setAvatar(null);
      await onProfileChanged();
      setMessage('頭像已移除。');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '無法移除頭像。');
    } finally { setBusy(false); }
  }

  const shownAvatar = preview ?? user.avatarUrl;
  return (
    <Modal title="個人中心" onClose={onClose} width="small">
      <form className="profile-form" onSubmit={saveProfile}>
        <div className="profile-avatar-editor">
          <div
            className="profile-avatar"
            style={shownAvatar ? { backgroundImage: `url(${shownAvatar})` } : undefined}
            aria-label="目前頭像"
          >
            {shownAvatar ? '' : username.slice(0, 1).toUpperCase()}
          </div>
          <div className="profile-avatar-actions">
            <label className="secondary-button avatar-upload"><Camera size={16} />選擇新頭像<input type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => setAvatar(event.target.files?.[0] ?? null)} /></label>
            {(user.avatarUrl || avatar) && <button type="button" className="text-button profile-remove-avatar" disabled={busy} onClick={removeAvatar}>移除頭像</button>}
            <small>支援 JPG、PNG、WebP，檔案上限 2 MB。</small>
          </div>
        </div>
        <Field label="帳號名稱"><input value={username} minLength={2} maxLength={40} onChange={(event) => setUsername(event.target.value)} required /></Field>
        <Field label="電子郵件"><input value={user.email} readOnly aria-readonly="true" /></Field>
        <div className="profile-account-meta"><span>帳號類型</span><strong>{user.role === 'admin' ? '管理員' : '一般使用者'}</strong></div>
        {message && <p className={message.includes('已') ? 'form-success' : 'form-error'}>{message}</p>}
        <button className="primary-button" disabled={busy || username.trim().length < 2}>{busy ? '儲存中…' : '儲存個人資料'}</button>
      </form>
    </Modal>
  );
}

export function SettingsModal({ user, onClose, onKeysChanged }: { user: SessionUser; onClose: () => void; onKeysChanged: () => Promise<void> }) {
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [provider, setProvider] = useState<Provider>('openai');
  const [apiKey, setApiKey] = useState('');
  const [endpointUrl, setEndpointUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  async function load() {
    const result = await apiGet<{ credentials: Credential[]; usage: Usage }>('/api/account/keys');
    setCredentials(result.credentials);
    setUsage(result.usage);
  }

  useEffect(() => {
    let active = true;
    apiGet<{ credentials: Credential[]; usage: Usage }>('/api/account/keys')
      .then((result) => { if (active) { setCredentials(result.credentials); setUsage(result.usage); } })
      .catch((error: Error) => { if (active) setMessage(error.message); });
    return () => { active = false; };
  }, []);

  async function saveKey(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setMessage('');
    try {
      await api('/api/account/keys', { provider, apiKey, endpointUrl });
      setApiKey('');
      setEndpointUrl('');
      setMessage(`${providerNames[provider]} 金鑰已驗證並加密儲存。`);
      await load();
      await onKeysChanged();
    } catch (error) { setMessage(error instanceof Error ? error.message : '儲存失敗。'); }
    finally { setBusy(false); }
  }

  async function removeKey(target: Provider) {
    setBusy(true); setMessage('');
    try {
      await api('/api/account/keys', { provider: target }, 'DELETE');
      await load();
      await onKeysChanged();
    } catch (error) { setMessage(error instanceof Error ? error.message : '刪除失敗。'); }
    finally { setBusy(false); }
  }

  return (
    <Modal title="帳號與 API Key" onClose={onClose} width="medium">
      <div className="settings-profile"><AccountAvatar user={user} /><div><strong>{user.username}</strong><span>{user.email}</span></div></div>
      {usage && (
        <div className="usage-grid">
          <Metric label="本月請求" value={usage.requests.toLocaleString()} />
          <Metric label="本月 Token" value={usage.tokens.toLocaleString()} />
          <Metric label="平台額度" value={`$${(usage.platformCostMicros / 1_000_000).toFixed(2)} / $${(usage.limits.platform_cost_limit_micros / 1_000_000).toFixed(2)}`} />
        </div>
      )}
      <section className="modal-section">
        <div className="section-heading"><div><h3>自備 API Key</h3><p>新增有效金鑰後，才會顯示管理員開放的 BYOK 模型。</p></div><KeyRound size={20} /></div>
        <div className="credential-list">
          {credentials.length === 0 && <p className="empty-note">尚未加入自備金鑰。</p>}
          {credentials.map((credential) => (
            <div className="credential-row" key={credential.provider}>
              <div><strong>{providerNames[credential.provider]}</strong><span>•••• {credential.last4}</span></div>
              <span className="status-ok"><Check size={14} />已驗證</span>
              <button onClick={() => removeKey(credential.provider)} aria-label={`移除 ${providerNames[credential.provider]} 金鑰`}><Trash2 size={16} /></button>
            </div>
          ))}
        </div>
        <form className="key-form" onSubmit={saveKey}>
          <select value={provider} onChange={(event) => setProvider(event.target.value as Provider)}>
            {Object.entries(providerNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <input type="password" autoComplete="off" placeholder="貼上 API Key" value={apiKey} onChange={(event) => setApiKey(event.target.value)} required />
          {(provider === 'cloudflare' || provider === 'compatible') && <input className="endpoint-input" placeholder={provider === 'cloudflare' ? 'Cloudflare Account ID' : 'https://your-endpoint.example/v1'} value={endpointUrl} onChange={(event) => setEndpointUrl(event.target.value)} required />}
          <button className="primary-button" disabled={busy}>{busy ? '驗證中…' : '驗證並儲存'}</button>
        </form>
        {message && <p className={message.includes('已驗證') ? 'form-success' : 'form-error'}>{message}</p>}
        <p className="security-note"><ShieldCheck size={15} />完整金鑰只會送往伺服器驗證，並以加密形式保存。</p>
      </section>
    </Modal>
  );
}

type AdminModel = {
  id: string; provider: Provider; providerModelId: string; displayName: string; accessMode: 'platform' | 'byok';
  enabled: number; inputPriceMicros: number; outputPriceMicros: number; maxOutputTokens: number;
};
type AdminUser = {
  id: string; username: string; email: string; role: 'user' | 'admin'; status: 'active' | 'suspended';
  requestsPerMinute: number; requestsPerDay: number; tokensPerMonth: number; platformCostLimitMicros: number; maxOutputTokens: number;
};

export function AdminModal({ onClose, onConfigChanged }: { onClose: () => void; onConfigChanged: () => Promise<void> }) {
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [models, setModels] = useState<AdminModel[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [provider, setProvider] = useState<Provider>('openai');
  const [apiKey, setApiKey] = useState('');
  const [endpointUrl, setEndpointUrl] = useState('');
  const [modelDraft, setModelDraft] = useState({ id: '', provider: 'openai' as Provider, providerModelId: '', displayName: '', accessMode: 'byok' as 'platform' | 'byok', inputPriceMicros: 0, outputPriceMicros: 0, maxOutputTokens: 4096 });
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  async function load() {
    const result = await apiGet<{ credentials: Credential[]; models: AdminModel[]; users: AdminUser[] }>('/api/admin/config');
    setCredentials(result.credentials); setModels(result.models); setUsers(result.users);
  }
  useEffect(() => {
    let active = true;
    apiGet<{ credentials: Credential[]; models: AdminModel[]; users: AdminUser[] }>('/api/admin/config')
      .then((result) => {
        if (active) { setCredentials(result.credentials); setModels(result.models); setUsers(result.users); }
      })
      .catch((error: Error) => { if (active) setMessage(error.message); });
    return () => { active = false; };
  }, []);

  async function run(body: Record<string, unknown>, method: 'POST' | 'DELETE' = 'POST'): Promise<boolean> {
    setBusy(true); setMessage('');
    try {
      await api('/api/admin/config', body, method);
      setMessage('設定已儲存。');
      try {
        await Promise.all([load(), onConfigChanged()]);
      } catch (refreshError) {
        console.error('Admin view refresh failed:', refreshError);
        setMessage('設定已儲存；畫面更新失敗，重新開啟管理中心即可。');
      }
      return true;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '儲存失敗。');
      return false;
    } finally { setBusy(false); }
  }

  async function savePlatformKey(event: FormEvent) {
    event.preventDefault();
    if (await run({ action: 'save-platform-key', provider, apiKey, endpointUrl })) {
      setApiKey('');
      setEndpointUrl('');
    }
  }

  async function saveModel(event: FormEvent) {
    event.preventDefault();
    if (await run({ action: 'save-model', ...modelDraft, enabled: true })) {
      setModelDraft({ id: '', provider: 'openai', providerModelId: '', displayName: '', accessMode: 'byok', inputPriceMicros: 0, outputPriceMicros: 0, maxOutputTokens: 4096 });
    }
  }

  function editModel(model: AdminModel) {
    setMessage('');
    setModelDraft({
      id: model.id,
      provider: model.provider,
      providerModelId: model.providerModelId,
      displayName: model.displayName,
      accessMode: model.accessMode,
      inputPriceMicros: model.inputPriceMicros,
      outputPriceMicros: model.outputPriceMicros,
      maxOutputTokens: model.maxOutputTokens,
    });
  }

  async function deleteModel(model: AdminModel) {
    if (!window.confirm(`確定要刪除「${model.displayName}」嗎？`)) return;
    if (await run({ action: 'delete-model', id: model.id }, 'DELETE') && modelDraft.id === model.id) {
      setModelDraft({ id: '', provider: 'openai', providerModelId: '', displayName: '', accessMode: 'byok', inputPriceMicros: 0, outputPriceMicros: 0, maxOutputTokens: 4096 });
    }
  }

  return (
    <Modal title="CatGPT 管理中心" onClose={onClose} width="large">
      <section className="modal-section">
        <div className="section-heading"><div><h3>平台出資金鑰</h3><p>管理員提供的共用金鑰；使用者不需自備金鑰也能使用對應的「平台」模型。</p></div><ShieldCheck size={20} /></div>
        <div className="credential-list compact">
          {credentials.map((item) => <div className="credential-row" key={item.provider}><div><strong>{providerNames[item.provider]}</strong><span>•••• {item.last4}</span></div><span className="status-ok"><Check size={14} />有效</span></div>)}
          {credentials.length === 0 && <p className="empty-note">尚未設定平台 API Key。</p>}
        </div>
        <form className="key-form" onSubmit={savePlatformKey}>
          <select value={provider} onChange={(event) => setProvider(event.target.value as Provider)}>{Object.entries(providerNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
          <input type="password" placeholder="平台 API Key" value={apiKey} onChange={(event) => setApiKey(event.target.value)} required />
          {(provider === 'cloudflare' || provider === 'compatible') && <input className="endpoint-input" placeholder={provider === 'cloudflare' ? 'Cloudflare Account ID' : 'https://your-endpoint.example/v1'} value={endpointUrl} onChange={(event) => setEndpointUrl(event.target.value)} required />}
          <button className="primary-button" disabled={busy}>驗證並儲存</button>
        </form>
      </section>

      <section className="modal-section">
        <div className="section-heading"><div><h3>模型目錄</h3><p>「平台」使用管理員金鑰；「自備金鑰」只會對已加入該供應商 API Key 的使用者顯示。</p></div></div>
        <div className="admin-model-list">
          {models.map((model) => (
            <div className="admin-model-row" key={model.id}>
              <div className="admin-model-info"><strong>{model.displayName}</strong><span>{providerNames[model.provider]} · {model.providerModelId}</span></div>
              <span className={`access-badge ${model.accessMode}`}>{model.accessMode === 'platform' ? '平台' : '自備金鑰'}</span>
              <label className="switch-label"><input type="checkbox" checked={Boolean(model.enabled)} disabled={busy} onChange={(event) => run({ action: 'set-model-enabled', id: model.id, enabled: event.target.checked })} /><span>啟用</span></label>
              <div className="model-row-actions">
                <button type="button" disabled={busy} onClick={() => editModel(model)} aria-label={`編輯 ${model.displayName}`} title="編輯模型"><Pencil size={15} /></button>
                <button type="button" disabled={busy} onClick={() => deleteModel(model)} aria-label={`刪除 ${model.displayName}`} title="刪除模型"><Trash2 size={15} /></button>
              </div>
            </div>
          ))}
        </div>
        <form className="model-form" onSubmit={saveModel}>
          <select value={modelDraft.provider} onChange={(event) => setModelDraft({ ...modelDraft, provider: event.target.value as Provider })}>{Object.entries(providerNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
          <input placeholder="供應商模型 ID" value={modelDraft.providerModelId} onChange={(event) => setModelDraft({ ...modelDraft, providerModelId: event.target.value })} required />
          <input placeholder="顯示名稱" value={modelDraft.displayName} onChange={(event) => setModelDraft({ ...modelDraft, displayName: event.target.value })} required />
          <select value={modelDraft.accessMode} onChange={(event) => setModelDraft({ ...modelDraft, accessMode: event.target.value as 'platform' | 'byok' })}><option value="platform">平台提供</option><option value="byok">使用者自備金鑰</option></select>
          <button className="primary-button" disabled={busy}>{busy ? '驗證中…' : modelDraft.id ? '儲存變更' : '驗證並新增'}</button>
          {modelDraft.id && <button type="button" className="secondary-button" disabled={busy} onClick={() => setModelDraft({ id: '', provider: 'openai', providerModelId: '', displayName: '', accessMode: 'byok', inputPriceMicros: 0, outputPriceMicros: 0, maxOutputTokens: 4096 })}>取消編輯</button>}
        </form>
      </section>

      <section className="modal-section">
        <div className="section-heading"><div><h3>使用者額度</h3><p>限制每位使用者每天可傳送的訊息次數，以及每月可使用的平台 API 成本。</p></div></div>
        <div className="admin-user-list">
          {users.map((item, index) => (
            <div className="admin-user-row" key={item.id}>
              <div className="admin-user-identity"><strong>{item.username}</strong><span>{item.email}</span></div>
              <label>每日訊息（次）<input type="number" min={1} value={item.requestsPerDay} onChange={(event) => setUsers((current) => current.map((user, userIndex) => userIndex === index ? { ...user, requestsPerDay: Number(event.target.value) } : user))} /></label>
              <label>每月額度（USD）<input type="number" min={0} step="0.5" value={item.platformCostLimitMicros / 1_000_000} onChange={(event) => setUsers((current) => current.map((user, userIndex) => userIndex === index ? { ...user, platformCostLimitMicros: Number(event.target.value) * 1_000_000 } : user))} /></label>
              <select value={item.status} onChange={(event) => setUsers((current) => current.map((user, userIndex) => userIndex === index ? { ...user, status: event.target.value as 'active' | 'suspended' } : user))}><option value="active">啟用</option><option value="suspended">停權</option></select>
              <button className="secondary-button" disabled={busy} onClick={() => run({ action: 'update-user', ...item, userId: item.id })}>儲存</button>
            </div>
          ))}
        </div>
      </section>
      {message && <p className={message.includes('已儲存') ? 'form-success' : 'form-error'}>{message}</p>}
    </Modal>
  );
}

export function LogoutModal({ user, busy, onCancel, onConfirm }: { user: SessionUser; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  return (
    <Modal title="你是否確定要登出？" onClose={onCancel} width="small">
      <div className="logout-account"><AccountAvatar user={user} /><div><strong>{user.username}</strong><span>{user.email}</span></div></div>
      <div className="dialog-actions"><button className="secondary-button" onClick={onCancel}>取消</button><button className="danger-button" disabled={busy} onClick={onConfirm}>{busy ? '登出中…' : '登出'}</button></div>
    </Modal>
  );
}

function AccountAvatar({ user }: { user: SessionUser }) {
  return <div className="settings-avatar" style={user.avatarUrl ? { backgroundImage: `url(${user.avatarUrl})` } : undefined}>{user.avatarUrl ? '' : user.username.slice(0, 1).toUpperCase()}</div>;
}

function Modal({ title, onClose, width, children }: { title: string; onClose: () => void; width: 'small' | 'medium' | 'large'; children: React.ReactNode }) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className={`modal-card modal-${width}`} role="dialog" aria-modal="true" aria-label={title}>
        <header><h2>{title}</h2><button onClick={onClose} aria-label="關閉"><X size={19} /></button></header>
        <div className="modal-body">{children}</div>
      </section>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return <label className="field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}

function AccountPill({ email, onBack }: { email: string; onBack: () => void }) {
  return <button className="account-pill" type="button" onClick={onBack}>{email}<span>變更</span></button>;
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="metric"><span>{label}</span><strong>{value}</strong></div>;
}

async function api<T = { ok: boolean }>(url: string, body: unknown, method = 'POST'): Promise<T> {
  const response = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(data.error || '操作失敗。');
  return data;
}

async function apiGet<T>(url: string): Promise<T> {
  const response = await fetch(url);
  const data = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(data.error || '讀取失敗。');
  return data;
}
