'use client';

import {
  Archive,
  ArrowUp,
  Cat,
  Check,
  ChevronDown,
  CircleHelp,
  Copy,
  FilePlus2,
  History,
  LogOut,
  KeyRound,
  Mic,
  MoreHorizontal,
  PanelLeft,
  Pencil,
  Pin,
  Plus,
  Search,
  ShieldCheck,
  SquarePen,
  Trash2,
  UserRound,
  X,
} from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { SessionUser } from '@/lib/auth';
import type { ConversationSummary, StoredMessage } from '@/lib/conversations';
import type { AvailableModel } from '@/lib/models';
import { AdminModal, AuthModal, LogoutModal, ProfileModal, SettingsModal } from './AccountModals';

type Mode = 'chat' | 'work';
type Exchange = { user: string; assistant: string; pending?: boolean; error?: boolean };
type SpeechResultEvent = { results: ArrayLike<{ 0: { transcript: string }; isFinal: boolean }> };
type SpeechRecognitionLike = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start: () => void;
  stop: () => void;
  onresult: ((event: SpeechResultEvent) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
};
type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

type AssistantContentPart =
  | { type: 'text'; content: string }
  | { type: 'code'; content: string; language: string };

function parseAssistantContent(content: string): AssistantContentPart[] {
  const parts: AssistantContentPart[] = [];
  const fencePattern = /```([^\n`]*)\n?([\s\S]*?)```/g;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = fencePattern.exec(content)) !== null) {
    const textBefore = content.slice(cursor, match.index);
    if (textBefore) parts.push({ type: 'text', content: textBefore });
    parts.push({
      type: 'code',
      language: match[1].trim(),
      content: match[2].replace(/^\n/, '').replace(/\n$/, ''),
    });
    cursor = match.index + match[0].length;
  }

  const textAfter = content.slice(cursor);
  if (textAfter) parts.push({ type: 'text', content: textAfter });
  return parts.length > 0 ? parts : [{ type: 'text', content }];
}

function AssistantContent({ content }: { content: string }) {
  return (
    <div className="assistant-content">
      {parseAssistantContent(content).map((part, index) => part.type === 'code' ? (
        <section className="code-block" key={`code-${index}`}>
          <header className="code-block-header">
            <span>{part.language || '程式碼'}</span>
            <button
              type="button"
              onClick={() => navigator.clipboard.writeText(part.content)}
              aria-label="複製程式碼"
            >
              <Copy size={14} /> 複製
            </button>
          </header>
          <pre><code>{part.content}</code></pre>
        </section>
      ) : (
        <p key={`text-${index}`}>{part.content}</p>
      ))}
    </div>
  );
}

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  }
}

export default function ChatPrototype() {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [models, setModels] = useState<AvailableModel[]>([]);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [mode, setMode] = useState<Mode>('chat');
  const [temporaryMode, setTemporaryMode] = useState(false);
  const [history, setHistory] = useState<ConversationSummary[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [recentOpen, setRecentOpen] = useState(true);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<ConversationSummary[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [conversationMenuId, setConversationMenuId] = useState<string | null>(null);
  const [renamingConversationId, setRenamingConversationId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renameBusy, setRenameBusy] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const [conversationLoading, setConversationLoading] = useState(false);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [selectedModel, setSelectedModel] = useState<AvailableModel | null>(null);
  const [text, setText] = useState('');
  const [attachment, setAttachment] = useState<string | null>(null);
  const [listening, setListening] = useState(false);
  const [sent, setSent] = useState<Exchange[]>([]);
  const [sending, setSending] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const [logoutOpen, setLogoutOpen] = useState(false);
  const [logoutBusy, setLogoutBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const accountAreaRef = useRef<HTMLDivElement>(null);
  const modelPickerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    fetch('/api/auth/session')
      .then((response) => response.json() as Promise<{ user: SessionUser | null }>)
      .then(async (data) => {
        if (!active) return;
        setUser(data.user);
        if (data.user) {
          const [modelResponse, historyResponse] = await Promise.all([
            fetch('/api/models'),
            fetch('/api/conversations'),
          ]);
          const modelData = await modelResponse.json() as { models: AvailableModel[] };
          const historyData = await historyResponse.json() as { conversations?: ConversationSummary[] };
          if (active) {
            setModels(modelData.models);
            setSelectedModel(modelData.models[0] ?? null);
            setHistory(historyData.conversations ?? []);
          }
        }
      })
      .finally(() => { if (active) setSessionLoading(false); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!searchOpen) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setSearching(true);
      setSearchError('');
      try {
        const response = await fetch(`/api/conversations?search=${encodeURIComponent(searchQuery.trim())}`, { signal: controller.signal });
        const data = await response.json() as { conversations?: ConversationSummary[]; error?: string };
        if (!response.ok) throw new Error(data.error || '搜尋失敗。');
        setSearchResults(data.conversations ?? []);
      } catch (error) {
        if (controller.signal.aborted) return;
        setSearchError(error instanceof Error ? error.message : '搜尋失敗。');
      } finally {
        if (!controller.signal.aborted) setSearching(false);
      }
    }, 220);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [searchOpen, searchQuery]);

  useEffect(() => {
    if (!searchOpen) return;
    const timer = window.setTimeout(() => searchInputRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [searchOpen]);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = '0px';
    const nextHeight = Math.min(Math.max(textarea.scrollHeight, 38), 120);
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > 120 ? 'auto' : 'hidden';
  }, [text]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const saved = window.localStorage.getItem('catgpt_recent_open');
      if (saved !== null) setRecentOpen(saved === 'true');
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!accountMenuOpen && !modelOpen && !conversationMenuId) return;

    function closeFloatingMenus(event: PointerEvent) {
      const target = event.target as Node;
      if (accountMenuOpen && !accountAreaRef.current?.contains(target)) setAccountMenuOpen(false);
      if (modelOpen && !modelPickerRef.current?.contains(target)) setModelOpen(false);
      if (conversationMenuId && !(event.target as Element).closest('[data-conversation-menu]')) setConversationMenuId(null);
    }

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      setAccountMenuOpen(false);
      setModelOpen(false);
      setConversationMenuId(null);
    }

    document.addEventListener('pointerdown', closeFloatingMenus);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeFloatingMenus);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [accountMenuOpen, modelOpen, conversationMenuId]);

  async function refreshSession() {
    const response = await fetch('/api/auth/session');
    const data = await response.json() as { user: SessionUser | null };
    setUser(data.user);
    if (data.user) await Promise.all([refreshModels(), refreshConversations()]);
    else { setModels([]); setSelectedModel(null); setHistory([]); setActiveConversationId(null); }
  }

  async function refreshModels() {
    const response = await fetch('/api/models');
    const data = await response.json() as { models: AvailableModel[] };
    setModels(data.models);
    setSelectedModel((current) => data.models.find((model) => model.id === current?.id) ?? data.models[0] ?? null);
  }

  async function refreshConversations() {
    const response = await fetch('/api/conversations');
    const data = await response.json() as { conversations?: ConversationSummary[]; error?: string };
    if (!response.ok) throw new Error(data.error || '無法讀取聊天紀錄。');
    setHistory(data.conversations ?? []);
    setHistoryError('');
  }

  async function logout() {
    setLogoutBusy(true);
    try {
      await fetch('/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      setUser(null); setModels([]); setSelectedModel(null); setSent([]); setHistory([]); setActiveConversationId(null); setLogoutOpen(false); setAccountMenuOpen(false);
    } finally { setLogoutBusy(false); }
  }

  function startNewConversation() {
    setSent([]);
    setActiveConversationId(null);
    setConversationMenuId(null);
    setText('');
    setAttachment(null);
  }

  function openSearch() {
    setSidebarOpen(true);
    setSearchOpen(true);
    setConversationMenuId(null);
  }

  function closeSearch() {
    setSearchOpen(false);
    setSearchQuery('');
    setSearchResults([]);
    setSearchError('');
  }

  function collapseSidebar() {
    closeSearch();
    setAccountMenuOpen(false);
    setConversationMenuId(null);
    setSidebarOpen(false);
  }

  function openRecentConversations() {
    setRecentOpen(true);
    window.localStorage.setItem('catgpt_recent_open', 'true');
    setSidebarOpen(true);
  }

  function toggleTemporaryMode() {
    startNewConversation();
    setTemporaryMode((active) => !active);
  }

  function toggleRecent() {
    setRecentOpen((open) => {
      const next = !open;
      window.localStorage.setItem('catgpt_recent_open', String(next));
      return next;
    });
  }

  async function loadConversation(conversationId: string) {
    if (conversationLoading || conversationId === activeConversationId) return;
    setConversationLoading(true);
    setConversationMenuId(null);
    setHistoryError('');
    try {
      const response = await fetch(`/api/conversations?id=${encodeURIComponent(conversationId)}`);
      const data = await response.json() as {
        conversation?: ConversationSummary;
        messages?: StoredMessage[];
        error?: string;
      };
      if (!response.ok || !data.conversation) throw new Error(data.error || '無法讀取對話。');
      setSent(toExchanges(data.messages ?? []));
      setActiveConversationId(data.conversation.id);
      setMode(data.conversation.mode);
      setTemporaryMode(false);
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : '無法讀取對話。');
    } finally {
      setConversationLoading(false);
    }
  }

  async function updateHistoryItem(id: string, changes: { title?: string; isPinned?: boolean }) {
    const response = await fetch('/api/conversations', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, ...changes }),
    });
    const data = await response.json() as { error?: string };
    if (!response.ok) throw new Error(data.error || '無法更新對話。');
    await refreshConversations();
  }

  function beginRename(item: ConversationSummary) {
    setRenamingConversationId(item.id);
    setRenameValue(item.title);
    setConversationMenuId(null);
  }

  async function saveRename(event: React.FormEvent, item: ConversationSummary) {
    event.preventDefault();
    const title = renameValue.trim();
    if (!title) return;
    if (title === item.title) { setRenamingConversationId(null); return; }
    setRenameBusy(true);
    try {
      await updateHistoryItem(item.id, { title });
      setSearchResults((current) => current.map((conversation) => conversation.id === item.id ? { ...conversation, title } : conversation));
      setRenamingConversationId(null);
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : '無法重新命名。');
    } finally { setRenameBusy(false); }
  }

  async function togglePinned(item: ConversationSummary) {
    try {
      await updateHistoryItem(item.id, { isPinned: !item.isPinned });
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : '無法釘選對話。');
    }
  }

  async function removeConversation(item: ConversationSummary) {
    if (!window.confirm(`確定要刪除「${item.title}」嗎？這個動作無法復原。`)) return;
    try {
      const response = await fetch('/api/conversations', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: item.id }),
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || '無法刪除對話。');
      if (activeConversationId === item.id) startNewConversation();
      setConversationMenuId(null);
      await refreshConversations();
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : '無法刪除對話。');
    }
  }

  function toggleListening() {
    if (listening) {
      recognitionRef.current?.stop();
      return;
    }
    const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!Recognition) {
      setText((current) => current || '此瀏覽器不支援語音輸入，請改用文字輸入。');
      return;
    }
    const recognition = new Recognition();
    recognitionRef.current = recognition;
    recognition.lang = 'zh-TW';
    recognition.interimResults = true;
    recognition.continuous = false;
    recognition.onresult = (event) => {
      const transcript = Array.from(event.results).map((result) => result[0].transcript).join('');
      setText(transcript);
    };
    recognition.onerror = () => setListening(false);
    recognition.onend = () => setListening(false);
    setListening(true);
    recognition.start();
  }

  async function submit() {
    const value = text.trim();
    if ((!value && !attachment) || sending) return;
    if (!user) {
      setAuthOpen(true);
      return;
    }
    if (!selectedModel) {
      setSent((current) => [...current, { user: value || '請分析附件', assistant: '目前沒有可用模型。請由管理員設定平台金鑰，或在帳號設定中加入自己的 API Key。', error: true }]);
      return;
    }
    const prompt = attachment ? `${value || '請分析附件'}\n\n[附件：${attachment}]` : value;
    const exchangeIndex = sent.length;
    setSent((current) => [...current, { user: prompt, assistant: '', pending: true }]);
    setText('');
    setAttachment(null);
    setSending(true);
    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: prompt,
          model: selectedModel.id,
          mode,
          conversationId: temporaryMode ? null : activeConversationId,
          temporary: temporaryMode,
        }),
      });
      const data = await response.json() as { reply?: string; error?: string; conversation?: ConversationSummary | null };
      if (!response.ok) throw new Error(data.error || '無法取得回覆');
      setSent((current) => current.map((item, index) => index === exchangeIndex
        ? { ...item, assistant: data.reply || '模型未傳回文字。', pending: false }
        : item));
      if (data.conversation) {
        setActiveConversationId(data.conversation.id);
        await refreshConversations();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '連線失敗，請稍後再試。';
      setSent((current) => current.map((item, index) => index === exchangeIndex
        ? { ...item, assistant: message, pending: false, error: true }
        : item));
    } finally {
      setSending(false);
    }
  }

  return (
    <main className="app-shell">
      {sent.length === 0 && (
        <button
          className={`temporary-toggle ${temporaryMode ? 'active' : ''}`}
          onClick={toggleTemporaryMode}
          aria-label={temporaryMode ? '退出暫存對話' : '開啟暫存對話'}
          data-tooltip={temporaryMode ? '退出暫存對話' : '開啟暫存對話'}
          title={temporaryMode ? '退出暫存對話' : '開啟暫存對話'}
          aria-pressed={temporaryMode}
        >
          <Archive size={19} />
        </button>
      )}

      <section className="workspace">
        <aside className={`sidebar ${sidebarOpen ? 'is-open' : 'is-collapsed'}`}>
          <div className="sidebar-header">
            <strong className="app-name">CatGPT</strong>
            <div className="expanded-header-actions">
              <button onClick={openSearch} aria-label="搜尋對話" aria-pressed={searchOpen}><Search size={19} /></button>
              <button onClick={collapseSidebar} aria-label="收合側邊欄"><PanelLeft size={19} /></button>
            </div>
            <button className="collapsed-toggle" onClick={() => setSidebarOpen(true)} aria-label="展開側邊欄"><Cat size={21} /></button>
          </div>

          {searchOpen && (
            <div className="conversation-search">
              <Search size={17} />
              <input ref={searchInputRef} value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="搜尋聊天室內容" aria-label="搜尋聊天室內容" />
              <button onClick={closeSearch} aria-label="關閉搜尋"><X size={16} /></button>
            </div>
          )}

          <div className="primary-actions">
            <button className="new-chat" onClick={startNewConversation} data-tooltip="新對話" title={!sidebarOpen ? '新對話' : undefined}><SquarePen size={18} /><span>新對話</span></button>
            <button className="collapsed-only" onClick={openSearch} aria-label="搜尋對話" data-tooltip="搜尋對話" title="搜尋對話"><Search size={18} /><span>搜尋對話</span></button>
            <button className="collapsed-only" onClick={openRecentConversations} aria-label="最近的對話" data-tooltip="最近的對話" title="最近的對話"><History size={18} /><span>最近的對話</span></button>
          </div>

          <div className="conversation-list">
            {searchOpen
              ? <p className="search-results-heading">搜尋結果</p>
              : <button className="recent-heading" onClick={toggleRecent} aria-expanded={recentOpen}><span>最近</span><ChevronDown className={recentOpen ? '' : 'is-collapsed'} size={14} /></button>}
            {historyError && <p className="history-error">{historyError}</p>}
            {searchOpen && searchError && <p className="history-error">{searchError}</p>}
            {searchOpen && searching && <p className="history-empty">搜尋中…</p>}
            {searchOpen && !searching && searchQuery.trim() && searchResults.length === 0 && <p className="history-empty">找不到包含此關鍵字的聊天室</p>}
            {!searchOpen && recentOpen && history.length === 0 && <p className="history-empty">尚無聊天紀錄</p>}
            {(searchOpen ? searchResults : recentOpen ? history : []).map((item) => (
              <div
                className={`conversation-item ${activeConversationId === item.id ? 'active' : ''} ${renamingConversationId === item.id ? 'is-renaming' : ''}`}
                key={item.id}
                data-conversation-menu
              >
                {renamingConversationId === item.id ? (
                  <form className="conversation-rename-form" onSubmit={(event) => saveRename(event, item)}>
                    <input autoFocus value={renameValue} maxLength={80} onChange={(event) => setRenameValue(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') setRenamingConversationId(null); }} aria-label="新的對話名稱" />
                    <button disabled={renameBusy || !renameValue.trim()} aria-label="儲存名稱"><Check size={15} /></button>
                    <button type="button" disabled={renameBusy} onClick={() => setRenamingConversationId(null)} aria-label="取消重新命名"><X size={15} /></button>
                  </form>
                ) : <button className="conversation-open" onClick={() => loadConversation(item.id)} disabled={conversationLoading}><span>{item.title}</span></button>}
                {renamingConversationId !== item.id && <div className="conversation-actions">
                  <button
                    className={`pin-action ${item.isPinned ? 'is-pinned' : ''}`}
                    onClick={() => togglePinned(item)}
                    aria-label={item.isPinned ? `取消釘選 ${item.title}` : `釘選 ${item.title}`}
                    title={item.isPinned ? '取消釘選' : '釘選'}
                  >
                    <Pin size={14} fill={item.isPinned ? 'currentColor' : 'none'} />
                  </button>
                  <button
                    className="conversation-more"
                    onClick={() => setConversationMenuId((current) => current === item.id ? null : item.id)}
                    aria-label={`管理 ${item.title}`}
                    aria-expanded={conversationMenuId === item.id}
                  >
                    <MoreHorizontal size={16} />
                  </button>
                </div>}
                {conversationMenuId === item.id && (
                  <div className="conversation-menu">
                    <button onClick={() => beginRename(item)}><Pencil size={15} />重新命名</button>
                    <button className="danger" onClick={() => removeConversation(item)}><Trash2 size={15} />刪除</button>
                  </div>
                )}
              </div>
            ))}
          </div>

          <div className="account-area" ref={accountAreaRef}>
            <button className="account-trigger" onClick={() => setAccountMenuOpen((open) => !open)} aria-label="開啟帳號選單" aria-expanded={accountMenuOpen} data-tooltip={user ? '帳號選單' : '登入或註冊'} title={!sidebarOpen ? (user ? '帳號選單' : '登入或註冊') : undefined}>
              {user
                ? <UserAvatar user={user} />
                : <span className="sign-in-avatar"><UserRound size={18} /></span>}
              <span className="account-copy"><strong>{user?.username ?? (sessionLoading ? '讀取帳號中…' : '登入 CatGPT')}</strong><span>{user ? (user.role === 'admin' ? '管理員' : '已登入') : '登入或註冊'}</span></span>
            </button>
            {accountMenuOpen && (
              <div className="account-popover">
                {user ? (
                  <>
                    <button className="account-popover-profile" onClick={() => { setProfileOpen(true); setAccountMenuOpen(false); }}>
                      <UserAvatar user={user} className="popover-avatar" />
                      <strong>{user.username}</strong>
                      <ChevronDown size={15} />
                    </button>
                    <button onClick={() => { setSettingsOpen(true); setAccountMenuOpen(false); }}><KeyRound size={17} />帳號與 API Key</button>
                    {user.role === 'admin' && <button onClick={() => { setAdminOpen(true); setAccountMenuOpen(false); }}><ShieldCheck size={17} />管理中心</button>}
                    <button onClick={() => { setLogoutOpen(true); setAccountMenuOpen(false); }}><LogOut size={17} />登出</button>
                  </>
                ) : (
                  <button className="login-action" onClick={() => { setAuthOpen(true); setAccountMenuOpen(false); }}><UserRound size={17} />登入或註冊</button>
                )}
              </div>
            )}
          </div>
        </aside>

        <section className="chat-panel">
          {!temporaryMode && sent.length === 0 && (
            <div className={`mode-switch mode-${mode}`} role="group" aria-label="使用模式">
              <button className={mode === 'chat' ? 'active' : ''} onClick={() => setMode('chat')}>對話</button>
              <button className={mode === 'work' ? 'active' : ''} onClick={() => setMode('work')}>工作</button>
            </div>
          )}
          <div className="conversation">
            {sent.length > 0 && (
              <div className="messages">
                {sent.map((exchange, index) => (
                  <div className="message-pair" key={`${exchange.user}-${index}`}>
                    {exchange.user && <div className="user-message">{exchange.user}</div>}
                    {(exchange.pending || exchange.assistant) && (
                      <div className={`assistant-message ${exchange.error ? 'error' : ''}`}>
                        {exchange.pending
                          ? <div className="thinking"><span /><span /><span /></div>
                          : <AssistantContent content={exchange.assistant} />}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          <footer className={`composer-wrap ${sent.length === 0 ? 'is-initial' : 'has-messages'} ${temporaryMode ? 'is-temporary' : ''}`}>
            {sent.length === 0 && (
              <section className="composer-welcome">
                <h1>{temporaryMode ? '暫存對話' : mode === 'chat' ? '今天想聊些什麼？' : '今天想完成什麼工作？'}</h1>
                {temporaryMode && <p>這段對話不會出現在歷史記錄中，也不會用於訓練我們的模型。</p>}
              </section>
            )}
            {sent.length > 0 && <p className="disclaimer"><CircleHelp size={12} /> AI 可能會出錯，重要資訊請再次確認。</p>}
            <div className={`composer ${listening ? 'is-listening' : ''} ${temporaryMode ? 'temporary-composer' : ''}`}>
              {attachment && (
                <div className="attachment-pill">
                  <FilePlus2 size={16} /><span>{attachment}</span>
                  <button onClick={() => setAttachment(null)} aria-label="移除附件"><X size={15} /></button>
                </div>
              )}

              <div className="composer-row">
                <input
                  ref={fileRef}
                  className="visually-hidden"
                  type="file"
                  onChange={(event) => setAttachment(event.target.files?.[0]?.name || null)}
                />
                <button className="add-file" onClick={() => fileRef.current?.click()} aria-label="加入附件" data-tooltip="加入附件" title="加入附件"><Plus size={21} /></button>

                <textarea
                  ref={textareaRef}
                  aria-label="訊息內容"
                  placeholder={listening ? '正在聆聽…' : mode === 'chat' ? '詢問任何問題' : '描述你想完成的工作'}
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault();
                      submit();
                    }
                  }}
                  rows={1}
                />

                <div className="right-tools">
                  <div className="model-picker" ref={modelPickerRef}>
                    <button className="model-button" onClick={() => setModelOpen(!modelOpen)}>
                      {selectedModel?.name ?? (user ? '尚無模型' : '登入後選擇')}<ChevronDown size={14} />
                    </button>
                    {modelOpen && (
                      <div className="model-menu">
                        {models.length === 0 && <p className="model-empty">尚無可用模型</p>}
                        {models.map((model) => (
                          <button key={model.id} onClick={() => { setSelectedModel(model); setModelOpen(false); }}>
                            <strong>{model.name}</strong>
                            {selectedModel?.id === model.id && <Check size={17} />}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <button className={listening ? 'mic active' : 'mic'} onClick={toggleListening} aria-label="語音輸入"><Mic size={19} /></button>
                  <button className="send" onClick={submit} disabled={sending || (!text.trim() && !attachment)} aria-label="傳送訊息"><ArrowUp size={19} /></button>
                </div>
              </div>
            </div>
            {sent.length === 0 && <p className="disclaimer"><CircleHelp size={12} /> AI 可能會出錯，重要資訊請再次確認。</p>}
          </footer>
        </section>
      </section>
      {authOpen && <AuthModal onClose={() => setAuthOpen(false)} onAuthenticated={refreshSession} />}
      {user && profileOpen && <ProfileModal user={user} onClose={() => setProfileOpen(false)} onProfileChanged={refreshSession} />}
      {user && settingsOpen && <SettingsModal user={user} onClose={() => setSettingsOpen(false)} onKeysChanged={refreshModels} />}
      {user?.role === 'admin' && adminOpen && <AdminModal onClose={() => setAdminOpen(false)} onConfigChanged={refreshModels} />}
      {user && logoutOpen && <LogoutModal user={user} busy={logoutBusy} onCancel={() => setLogoutOpen(false)} onConfirm={logout} />}
    </main>
  );
}

function UserAvatar({ user, className = 'avatar' }: { user: SessionUser; className?: string }) {
  return (
    <span
      className={className}
      style={user.avatarUrl ? { backgroundImage: `url(${user.avatarUrl})` } : undefined}
      aria-hidden="true"
    >
      {user.avatarUrl ? '' : user.username.slice(0, 1).toUpperCase()}
    </span>
  );
}

function toExchanges(messages: StoredMessage[]): Exchange[] {
  const exchanges: Exchange[] = [];
  for (const message of messages) {
    if (message.role === 'user') {
      exchanges.push({ user: message.content, assistant: '' });
      continue;
    }
    if (message.role !== 'assistant') continue;
    const pendingExchange = [...exchanges].reverse().find((exchange) => !exchange.assistant);
    if (pendingExchange) {
      pendingExchange.assistant = message.content;
      pendingExchange.error = message.status === 'failed';
    } else {
      exchanges.push({ user: '', assistant: message.content, error: message.status === 'failed' });
    }
  }
  return exchanges;
}
