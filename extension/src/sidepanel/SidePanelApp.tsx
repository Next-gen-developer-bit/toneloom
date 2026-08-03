import { useState, useEffect } from 'react';
import { supabase, storage, STORAGE_KEYS } from '../utils';
import { memoryAPI, toneAPI, billingAPI, profileAPI, writeAPI, migrationAPI, syncAuthToken, type MemoryEntry, type ToneProfile, type UserPreferences } from '../utils/api';
import { BrainCircuit, Settings, Layers, Zap, LogOut, Trash2, Plus, Crown, Check, RefreshCw, AlertCircle, Copy, ChevronDown, ChevronUp, FileText, Expand, Pencil, ArrowLeftRight } from 'lucide-react';
import { AI_HANDOFF_TARGETS, ACTIONS, TONES } from '../utils/constants';
import PricingModal from './PricingModal';
import AuthForm from '../components/AuthForm';

type MemoryAction = 'summarize' | 'rewrite' | 'expand';
type HandoffTarget = { id: string; label: string; url: string; builtin?: boolean };

export default function SidePanelApp() {
  const [activeTab, setActiveTab] = useState<'memories' | 'tone' | 'switch' | 'settings'>('memories');
  const [session, setSession] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  // Memories state
  const [memories, setMemories] = useState<MemoryEntry[]>([]);
  const [memoriesTotal, setMemoriesTotal] = useState(0);
  const [memoriesPage, setMemoriesPage] = useState(0);
  const [memoriesLoading, setMemoriesLoading] = useState(false);
  const [expandedMemoryIds, setExpandedMemoryIds] = useState<Record<string, boolean>>({});
  const [memoryActionLoading, setMemoryActionLoading] = useState<string | null>(null);
  const [memoryActionError, setMemoryActionError] = useState('');
  const [memoryActionResult, setMemoryActionResult] = useState<{
    memoryId: string;
    action: MemoryAction;
    label: string;
    text: string;
  } | null>(null);

  // Tone state
  const [toneProfiles, setToneProfiles] = useState<ToneProfile[]>([]);
  const [toneLoading, setToneLoading] = useState(false);
  const [newProfileName, setNewProfileName] = useState('');
  const [showCreateProfile, setShowCreateProfile] = useState(false);
  const [toneTrainText, setToneTrainText] = useState('');
  const [toneTrainLoading, setToneTrainLoading] = useState(false);
  const [toneTrainMessage, setToneTrainMessage] = useState('');
  const [toneTrainError, setToneTrainError] = useState('');

  // Settings state
  const [settings_state, setSettingsState] = useState({
    autoInjectContext: true,
    showFloatingToolbar: true,
    defaultLLM: 'gpt-4o-mini',
    defaultTone: 'my_style',
  });

  // Cross-LLM switch state
  const [activeThread, setActiveThread] = useState<{
    platform?: string
    title?: string
    transcript?: string
    updatedAt?: number
  } | null>(null);
  const [remoteSession, setRemoteSession] = useState<MemoryEntry | null>(null);
  const [migrationHistory, setMigrationHistory] = useState<Array<{
    id: string
    source_platform: string
    target_platform: string
    original_text?: string
    processed_summary?: string
    context_prompt?: string
    created_at: string
  }>>([]);
  const [switchLoading, setSwitchLoading] = useState(false);
  const [switchError, setSwitchError] = useState('');
  const [switchMessage, setSwitchMessage] = useState('');
  const [handoffBusy, setHandoffBusy] = useState<string | null>(null);
  const [chatMenuOpen, setChatMenuOpen] = useState(false);
  const [savingChat, setSavingChat] = useState(false);
  const [threadExpanded, setThreadExpanded] = useState(true);
  const [expandedHandoffIds, setExpandedHandoffIds] = useState<Record<string, boolean>>({});
  const [openMenuForHandoff, setOpenMenuForHandoff] = useState<string | null>(null);
  const [customLlms, setCustomLlms] = useState<Array<{ id: string; label: string; url: string }>>([]);
  const [showAddLlm, setShowAddLlm] = useState(false);
  const [newLlmName, setNewLlmName] = useState('');
  const [newLlmUrl, setNewLlmUrl] = useState('');



  // Profile
  const [profile, setProfile] = useState<any>(null);
  const [showPricing, setShowPricing] = useState(false);
  const [upgradeLoading, setUpgradeLoading] = useState(false);
  const [upgradeError, setUpgradeError] = useState('');
  const [portalLoading, setPortalLoading] = useState(false);
  const [portalError, setPortalError] = useState('');

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data: { session: s } }) => {
      setSession(s);
      if (s) {
        await syncAuthToken(s.access_token);
        loadAllData(s);
      }
      setLoading(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, s) => {
      setSession(s);

      if (!s) {
        await storage.remove(STORAGE_KEYS.AUTH_TOKEN);
        return;
      }

      // Keep backend auth token synchronized for all auth events.
      await syncAuthToken(s.access_token);

      // Avoid infinite request loops on TOKEN_REFRESHED events.
      if (event === 'SIGNED_IN' || event === 'USER_UPDATED') {
        await loadAllData(s);
      }
    });
    return () => subscription.unsubscribe();
  }, []);

  const loadAllData = async (_s: any) => {
    await Promise.all([fetchMemories(0), fetchToneProfiles(), fetchProfile()]);
  };

  const fetchSwitchData = async () => {
    setSwitchLoading(true);
    setSwitchError('');
    try {
      const local = await storage.get<{
        platform?: string
        title?: string
        transcript?: string
        updatedAt?: number
      }>(STORAGE_KEYS.ACTIVE_THREAD);
      setActiveThread(local);

      const savedCustom = await storage.get<Array<{ id: string; label: string; url: string }>>(STORAGE_KEYS.CUSTOM_LLMS);
      setCustomLlms(Array.isArray(savedCustom) ? savedCustom : []);

      const [sessionRes, historyRes] = await Promise.all([
        migrationAPI.getSession().catch(() => ({ session: null })),
        migrationAPI.history().catch(() => ({ migrations: [] })),
      ]);
      setRemoteSession(sessionRes.session || null);
      setMigrationHistory(historyRes.migrations || []);
    } catch (e: any) {
      setSwitchError(e?.message || 'Could not load handoff data');
    }
    setSwitchLoading(false);
  };

  const allHandoffTargets = (): HandoffTarget[] => [
    ...AI_HANDOFF_TARGETS.map((t) => ({ id: t.id, label: t.label, url: t.url, builtin: true })),
    ...customLlms.map((t) => ({ id: t.id, label: t.label, url: t.url, builtin: false })),
  ];

  const sendContinue = (payload: Record<string, unknown>) =>
    new Promise<any>((resolve, reject) => {
      chrome.runtime.sendMessage(
        { action: ACTIONS.CONTINUE_ON_PLATFORM, ...payload },
        (res) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          if (res?.error) {
            reject(new Error(res.error));
            return;
          }
          resolve(res);
        }
      );
    });

  const continueOnTarget = async (
    targetId: string,
    opts?: {
      transcript?: string
      prompt?: string
      source?: string
      title?: string
      url?: string
      label?: string
      skipSync?: boolean
    }
  ) => {
    setHandoffBusy(targetId);
    setSwitchError('');
    setSwitchMessage('');
    setOpenMenuForHandoff(null);
    try {
      const transcript =
        opts?.transcript ||
        activeThread?.transcript ||
        remoteSession?.content ||
        '';
      const prompt = (opts?.prompt || '').trim();
      // Background resolves LAST_GOOD_THREAD / history if transcript is empty or junk.
      const source =
        opts?.source ||
        activeThread?.platform ||
        remoteSession?.source_platform ||
        'imported';

      const res = await sendContinue({
        platform: targetId,
        conversation_text: transcript,
        prompt: prompt || undefined,
        source_platform: source,
        title: opts?.title || activeThread?.title || 'Continue conversation',
        url: opts?.url,
        label: opts?.label,
        skipSync: opts?.skipSync,
      });

      if (res?.autofilled || !res?.needsPaste) {
        setSwitchMessage(`Opening ${res?.label || targetId} — last saved context will auto-fill in the chat box.`);
      } else if (res?.needsPaste && res?.prompt) {
        try {
          await navigator.clipboard.writeText(res.prompt);
          setSwitchMessage(`Opened ${res.label || targetId}. Context copied — paste it into the chat.`);
        } catch {
          setSwitchMessage(`Opened ${res.label || targetId}. Copy the expanded handoff text and paste it.`);
        }
      } else {
        setSwitchMessage(`Opening ${res?.label || targetId} with your saved context…`);
      }
    } catch (e: any) {
      setSwitchError(e?.message || 'Handoff failed');
    }
    setHandoffBusy(null);
  };

  const openHandoffOn = async (handoff: {
    id: string
    source_platform: string
    original_text?: string
    context_prompt?: string
    processed_summary?: string
  }, target: HandoffTarget) => {
    // Prefer real User+Assistant dialogue. Skip Key Facts stubs and Edit chrome.
    const candidates = [
      handoff.original_text,
      handoff.processed_summary,
      handoff.context_prompt,
    ]
      .map((t) => String(t || '').trim())
      .filter(Boolean)
      .map((t) =>
        t
          .replace(/\bEdit(?=\s*(?:Assistant|User)\s*:)/gi, '')
          .replace(/(^|\n)\s*Assistant:\s*Edit(?:\s*Assistant:\s*Edit)*\s*/gi, '$1Assistant: ')
          .trim()
      )
      .filter((t) => {
        if (/Key Facts\s*&\s*Decisions/i.test(t) && /User Preferences/i.test(t)) return false
        if (/\[EchoWrite Context Migration\]/i.test(t) && !/User:[\s\S]{20,}Assistant:/i.test(t)) return false
        return t.length > 40
      })

    // Prefer transcripts that include a User turn (full chat), not assistant-only.
    const withUser = candidates.find((t) => /(?:^|\n)User:\s+/i.test(t) && !/User:\s*\[EchoWrite/i.test(t))
    const transcript = withUser || candidates[0] || ''

    await continueOnTarget(target.id, {
      transcript,
      prompt: undefined,
      source: handoff.source_platform || 'imported',
      title: `Continue chat (${handoff.source_platform} → ${target.label})`,
      url: target.url,
      label: target.label,
      skipSync: false,
    })
  }

  const addCustomLlm = async () => {
    const label = newLlmName.trim();
    let url = newLlmUrl.trim();
    if (!label || !url) {
      setSwitchError('Enter both a name and a chat URL.');
      return;
    }
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
    try {
      // Validate URL
      // eslint-disable-next-line no-new
      new URL(url);
    } catch {
      setSwitchError('Enter a valid URL (e.g. https://chat.example.com).');
      return;
    }
    const id = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `llm-${Date.now()}`;
    if (allHandoffTargets().some((t) => t.id === id)) {
      setSwitchError('That LLM already exists.');
      return;
    }
    const next = [...customLlms, { id, label, url }];
    setCustomLlms(next);
    await storage.set(STORAGE_KEYS.CUSTOM_LLMS, next);
    setNewLlmName('');
    setNewLlmUrl('');
    setShowAddLlm(false);
    setSwitchMessage(`Added ${label}. You can open any saved chat there.`);
    setSwitchError('');
  };

  const removeCustomLlm = async (id: string) => {
    const next = customLlms.filter((t) => t.id !== id);
    setCustomLlms(next);
    await storage.set(STORAGE_KEYS.CUSTOM_LLMS, next);
  };

  const saveActiveChat = async () => {
    setSavingChat(true);
    setSwitchError('');
    setSwitchMessage('');
    setChatMenuOpen(false);
    try {
      const res = await new Promise<any>((resolve, reject) => {
        chrome.runtime.sendMessage({ action: ACTIONS.SAVE_ACTIVE_CHAT }, (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          if (response?.error) {
            reject(new Error(response.error));
            return;
          }
          resolve(response);
        });
      });
      setSwitchMessage(res?.message || 'Chat saved for handoff');
      if (res?.hasAssistant && !res?.hasUser) {
        setSwitchMessage(
          (res?.message || 'Chat saved') +
            ' — tip: scroll to the top of the Claude chat so your messages are visible, then save again for a fuller handoff.'
        );
      }
      setThreadExpanded(true);
      await fetchSwitchData();
    } catch (e: any) {
      setSwitchError(e?.message || 'Could not save chat');
    }
    setSavingChat(false);
  };



  const fetchProfile = async () => {
    try {
      const data = await profileAPI.me();
      setProfile(data);
      const nextSettings = {
        autoInjectContext: data.preferences.auto_inject_context ?? true,
        showFloatingToolbar: data.preferences.show_floating_toolbar ?? true,
        defaultLLM: data.preferences.default_llm || 'gpt-4o-mini',
        defaultTone: data.preferences.default_tone || 'my_style',
      };
      setSettingsState(nextSettings);
      await storage.set(STORAGE_KEYS.SETTINGS, nextSettings);
      await storage.set(STORAGE_KEYS.USER, data);
    } catch (e) {
      console.error(e);
    }
  };

  const fetchMemories = async (page: number) => {
    setMemoriesLoading(true);
    try {
      const res = await memoryAPI.list(page, 20);
      setMemories(res.memories);
      setMemoriesTotal(res.total);
      setMemoriesPage(page);
    } catch (e) { console.error(e); }
    setMemoriesLoading(false);
  };

  const deleteMemory = async (id: string) => {
    await memoryAPI.delete(id);
    setMemories(prev => prev.filter(m => m.id !== id));
    setMemoriesTotal(prev => prev - 1);
    setExpandedMemoryIds(prev => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    if (memoryActionResult?.memoryId === id) setMemoryActionResult(null);
  };

  const toggleMemoryExpanded = (id: string) => {
    setExpandedMemoryIds(prev => ({ ...prev, [id]: !prev[id] }));
  };

  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      setMemoryActionError('Could not copy to clipboard.');
    }
  };

  const runMemoryAction = async (memory: MemoryEntry, action: MemoryAction) => {
    const loadingKey = `${memory.id}:${action}`;
    setMemoryActionLoading(loadingKey);
    setMemoryActionError('');
    try {
      let result: { result: string };
      if (action === 'summarize') {
        result = await writeAPI.summarize(memory.content);
      } else if (action === 'rewrite') {
        const activeTone = toneProfiles.find(p => p.is_active);
        result = await writeAPI.rewrite(
          memory.content,
          activeTone ? 'my_style' : 'professional',
          activeTone?.id,
        );
      } else {
        result = await writeAPI.expand(memory.content);
      }
      const labels: Record<MemoryAction, string> = {
        summarize: 'Summary',
        rewrite: 'Rewrite',
        expand: 'Expanded',
      };
      setMemoryActionResult({
        memoryId: memory.id,
        action,
        label: labels[action],
        text: result.result,
      });
      setExpandedMemoryIds(prev => ({ ...prev, [memory.id]: true }));
    } catch (e: any) {
      setMemoryActionError(e?.message || `Failed to ${action}`);
    } finally {
      setMemoryActionLoading(null);
    }
  };

  const fetchToneProfiles = async () => {
    setToneLoading(true);
    try {
      const res = await toneAPI.getProfiles();
      setToneProfiles(res.profiles);
      const active = res.profiles.find(p => p.is_active);
      if (active) {
        await storage.set(STORAGE_KEYS.TONE_PROFILE, active);
      } else {
        await storage.remove(STORAGE_KEYS.TONE_PROFILE);
      }
    } catch (e) { console.error(e); }
    setToneLoading(false);
  };

  const createToneProfile = async () => {
    if (!newProfileName.trim()) return;
    try {
      const created = await toneAPI.createProfile(newProfileName.trim());
      setNewProfileName('');
      setShowCreateProfile(false);
      // Auto-activate newly created profiles so training targets them immediately.
      if (created?.profile?.id) {
        await toneAPI.activateProfile(created.profile.id);
      }
      await fetchToneProfiles();
    } catch (e: any) {
      alert(e.message || 'Failed to create profile');
    }
  };

  const activateProfile = async (id: string) => {
    await toneAPI.activateProfile(id);
    await fetchToneProfiles();
  };

  const deleteProfile = async (id: string) => {
    await toneAPI.deleteProfile(id);
    await fetchToneProfiles();
  };

  const trainActiveTone = async () => {
    const text = toneTrainText.trim();
    if (text.length < 20) {
      setToneTrainError('Paste at least ~20 characters of your writing to train tone.');
      return;
    }
    const active = toneProfiles.find(p => p.is_active);
    setToneTrainLoading(true);
    setToneTrainError('');
    setToneTrainMessage('');
    try {
      const res = await toneAPI.train(text, active?.id || null, 'sidepanel');
      setToneTrainText('');
      setToneTrainMessage(
        `Trained “${res.profile_name || active?.name || 'profile'}” — ${res.samples_count} sample${res.samples_count === 1 ? '' : 's'} analyzed.`
      );
      await fetchToneProfiles();
    } catch (e: any) {
      setToneTrainError(e?.message || 'Tone training failed');
    } finally {
      setToneTrainLoading(false);
    }
  };

  const updateSetting = async (key: string, value: any) => {
    const camelMap: Record<string, string> = {
      auto_inject_context: 'autoInjectContext',
      show_floating_toolbar: 'showFloatingToolbar',
      default_llm: 'defaultLLM',
      default_tone: 'defaultTone',
    };
    const camelKey = camelMap[key] || key;
    const optimisticSettings = { ...settings_state, [camelKey]: value };
    setSettingsState(optimisticSettings);
    // Always write local settings first so content scripts see the change immediately.
    await storage.set(STORAGE_KEYS.SETTINGS, {
      ...(await storage.get<Record<string, unknown>>(STORAGE_KEYS.SETTINGS) || {}),
      ...optimisticSettings,
    });

    try {
      const updated = await profileAPI.updatePreferences({ [key]: value } as Partial<UserPreferences>);
      setProfile(updated);
      const syncedSettings = {
        autoInjectContext: updated.preferences.auto_inject_context ?? true,
        showFloatingToolbar: updated.preferences.show_floating_toolbar ?? true,
        defaultLLM: updated.preferences.default_llm || 'gpt-4o-mini',
        defaultTone: updated.preferences.default_tone || 'my_style',
      };
      setSettingsState(syncedSettings);
      await storage.set(STORAGE_KEYS.SETTINGS, {
        ...(await storage.get<Record<string, unknown>>(STORAGE_KEYS.SETTINGS) || {}),
        ...syncedSettings,
      });
      await storage.set(STORAGE_KEYS.USER, updated);
    } catch (e) {
      console.error(e);
      // Keep optimistic local toggle even if the server sync fails.
    }
  };

  const handleAuthenticated = async () => {
    const { data } = await supabase.auth.getSession();
    if (data.session) {
      setSession(data.session);
      await loadAllData(data.session);
    }
  };

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    await storage.clear();
    setSession(null);
    setProfile(null);
  };

  const handleUpgrade = async () => {
    setUpgradeLoading(true);
    setUpgradeError('');
    try {
      // Opens Stripe Checkout (payment gateway). Wire STRIPE_PRICE_PRO when ready.
      const res = await billingAPI.createCheckout('pro');
      if (res.checkout_url) {
        chrome.tabs.create({ url: res.checkout_url });
        setShowPricing(false);
      } else {
        setUpgradeError('Could not start checkout. Try again.');
      }
    } catch (e: any) {
      setUpgradeError(e?.message || 'Checkout failed. Payment gateway will be connected soon — try again after setup.');
    } finally {
      setUpgradeLoading(false);
    }
  };

  const handleManageSubscription = async () => {
    setPortalLoading(true);
    setPortalError('');
    try {
      const res = await billingAPI.createPortal();
      if (res.portal_url) {
        chrome.tabs.create({ url: res.portal_url });
      } else {
        setPortalError('Could not open subscription portal.');
      }
    } catch (e: any) {
      setPortalError(e?.message || 'No active subscription to manage yet. Upgrade to Pro first.');
    } finally {
      setPortalLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-zinc-950 text-zinc-100">
        <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-teal-500" />
      </div>
    );
  }

  if (!session) {
    return (
      <div className="flex flex-col h-screen bg-zinc-950 text-zinc-100 font-sans">
        {/* Hero Section */}
        <div className="flex flex-col items-center pt-10 pb-6 px-6">
          <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-teal-500 to-cyan-400 flex items-center justify-center shadow-xl shadow-teal-500/25 mb-5">
            <Zap className="w-8 h-8 text-white" />
          </div>
          <h1 className="text-2xl font-bold text-zinc-100 tracking-tight">Welcome to EchoWrite</h1>
          <p className="text-zinc-400 text-sm mt-1.5 text-center">Your context-aware AI writing assistant</p>
        </div>

        {/* Auth Form */}
        <div className="flex-1 px-6 pb-6">
          <AuthForm onAuthenticated={handleAuthenticated} />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen bg-zinc-950 text-zinc-100 font-sans">
      {/* Header */}
      <header className="p-4 border-b border-zinc-800 flex justify-between items-center bg-zinc-900/80 backdrop-blur-md sticky top-0 z-10">
        <div className="flex items-center gap-2">
          <Zap className="w-5 h-5 text-teal-400" />
          <h1 className="font-bold text-lg bg-clip-text text-transparent bg-gradient-to-r from-teal-400 to-cyan-400">ContextOS</h1>
        </div>
        <button onClick={handleSignOut} className="p-2 text-zinc-400 hover:text-red-400 transition-colors" title="Sign out">
          <LogOut className="w-4 h-4" />
        </button>
      </header>

      {/* Tabs */}
      <div className="flex border-b border-zinc-800 bg-zinc-900/50">
        {[
          { id: 'memories' as const, label: 'Memories', icon: BrainCircuit, color: 'violet' },
          { id: 'tone' as const, label: 'Tone', icon: Layers, color: 'cyan' },
          { id: 'switch' as const, label: 'Switch', icon: ArrowLeftRight, color: 'emerald' },
          { id: 'settings' as const, label: 'Settings', icon: Settings, color: 'zinc' },
        ].map(tab => (
          <button
            key={tab.id}
            className={`flex-1 py-3 text-sm font-medium flex items-center justify-center gap-2 transition-colors ${
              activeTab === tab.id
                ? `text-${tab.color}-400 border-b-2 border-${tab.color}-400`
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
            onClick={() => {
              setActiveTab(tab.id);
              if (tab.id === 'tone') fetchToneProfiles();
              if (tab.id === 'switch') fetchSwitchData();
            }}
          >
            <tab.icon className="w-4 h-4" /> {tab.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <main className="flex-1 overflow-y-auto p-4">
        {/* ── Memories Tab ── */}
        {activeTab === 'memories' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-zinc-500 uppercase tracking-wider">
                Saved Context ({memoriesTotal})
              </h2>
              <button onClick={() => fetchMemories(memoriesPage)} className="p-1 text-zinc-500 hover:text-zinc-300 transition-colors">
                <RefreshCw className={`w-4 h-4 ${memoriesLoading ? 'animate-spin' : ''}`} />
              </button>
            </div>

            {memories.length === 0 ? (
              <p className="text-sm text-zinc-500 text-center py-8">No memories saved yet. Select text on any webpage and right-click → EchoWrite: Save to Memory.</p>
            ) : (
              memories.map(m => {
                const isExpanded = !!expandedMemoryIds[m.id];
                const isLong = (m.content || '').length > 180 || (m.content || '').split('\n').length > 3;
                const actionBusy = memoryActionLoading?.startsWith(`${m.id}:`);
                const resultForMemory = memoryActionResult?.memoryId === m.id ? memoryActionResult : null;

                return (
                  <div key={m.id} className="p-3 rounded-lg bg-zinc-900 border border-zinc-800 hover:border-teal-500/30 transition-colors group">
                    <p className={`text-sm text-zinc-300 leading-relaxed whitespace-pre-wrap ${isExpanded ? '' : 'line-clamp-3'}`}>
                      {m.content}
                    </p>

                    {isLong && (
                      <button
                        onClick={() => toggleMemoryExpanded(m.id)}
                        className="mt-1.5 inline-flex items-center gap-1 text-xs text-teal-400 hover:text-teal-300 transition-colors"
                      >
                        {isExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                        {isExpanded ? 'Show less' : 'Read full text'}
                      </button>
                    )}

                    <div className="flex flex-wrap gap-1.5 mt-3">
                      <button
                        disabled={!!actionBusy}
                        onClick={() => runMemoryAction(m, 'summarize')}
                        className="inline-flex items-center gap-1 px-2 py-1 rounded bg-zinc-800 text-[11px] text-zinc-300 hover:bg-teal-500/20 hover:text-teal-300 disabled:opacity-40 transition-colors"
                        title="Summarize this memory"
                      >
                        <FileText className="w-3 h-3" />
                        {memoryActionLoading === `${m.id}:summarize` ? 'Working…' : 'Summarize'}
                      </button>
                      <button
                        disabled={!!actionBusy}
                        onClick={() => runMemoryAction(m, 'rewrite')}
                        className="inline-flex items-center gap-1 px-2 py-1 rounded bg-zinc-800 text-[11px] text-zinc-300 hover:bg-teal-500/20 hover:text-teal-300 disabled:opacity-40 transition-colors"
                        title="Rewrite this memory"
                      >
                        <Pencil className="w-3 h-3" />
                        {memoryActionLoading === `${m.id}:rewrite` ? 'Working…' : 'Rewrite'}
                      </button>
                      <button
                        disabled={!!actionBusy}
                        onClick={() => runMemoryAction(m, 'expand')}
                        className="inline-flex items-center gap-1 px-2 py-1 rounded bg-zinc-800 text-[11px] text-zinc-300 hover:bg-teal-500/20 hover:text-teal-300 disabled:opacity-40 transition-colors"
                        title="Expand this memory"
                      >
                        <Expand className="w-3 h-3" />
                        {memoryActionLoading === `${m.id}:expand` ? 'Working…' : 'Expand'}
                      </button>
                      <button
                        onClick={() => copyText(m.content)}
                        className="inline-flex items-center gap-1 px-2 py-1 rounded bg-zinc-800 text-[11px] text-zinc-300 hover:bg-zinc-700 transition-colors"
                        title="Copy full text"
                      >
                        <Copy className="w-3 h-3" /> Copy
                      </button>
                    </div>

                    {resultForMemory && (
                      <div className="mt-3 p-2.5 rounded-md bg-zinc-950 border border-teal-500/25">
                        <div className="flex items-center justify-between mb-1.5">
                          <span className="text-[11px] font-semibold uppercase tracking-wide text-teal-300">
                            {resultForMemory.label}
                          </span>
                          <div className="flex items-center gap-1">
                            <button
                              onClick={() => copyText(resultForMemory.text)}
                              className="p-1 text-zinc-500 hover:text-zinc-200 transition-colors"
                              title="Copy result"
                            >
                              <Copy className="w-3 h-3" />
                            </button>
                            <button
                              onClick={() => setMemoryActionResult(null)}
                              className="px-1.5 text-[11px] text-zinc-500 hover:text-zinc-300"
                            >
                              Dismiss
                            </button>
                          </div>
                        </div>
                        <p className="text-sm text-zinc-200 leading-relaxed whitespace-pre-wrap max-h-56 overflow-y-auto">
                          {resultForMemory.text}
                        </p>
                      </div>
                    )}

                    <div className="flex items-center justify-between mt-2 pt-2 border-t border-zinc-800/50">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-xs text-zinc-500 bg-zinc-800 px-2 py-0.5 rounded truncate max-w-[140px]">{m.source_platform}</span>
                        {m.tags?.map((t: string) => (
                          <span key={t} className="text-[10px] text-teal-400/70 bg-teal-500/10 px-1.5 py-0.5 rounded">{t}</span>
                        ))}
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className="text-[10px] text-zinc-600">{new Date(m.created_at).toLocaleDateString()}</span>
                        <button
                          onClick={() => deleteMemory(m.id)}
                          className="opacity-0 group-hover:opacity-100 p-1 text-zinc-600 hover:text-red-400 transition-all"
                          title="Delete memory"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })
            )}

            {memoryActionError && (
              <div className="flex items-start gap-2 p-2.5 rounded-lg bg-red-500/10 border border-red-500/20 text-xs text-red-300">
                <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                <span>{memoryActionError}</span>
              </div>
            )}

            {memoriesTotal > 20 && (
              <div className="flex items-center justify-center gap-3 pt-2">
                <button
                  disabled={memoriesPage === 0}
                  onClick={() => fetchMemories(memoriesPage - 1)}
                  className="text-xs text-zinc-400 hover:text-zinc-200 disabled:opacity-30 disabled:cursor-not-allowed"
                >← Prev</button>
                <span className="text-xs text-zinc-500">Page {memoriesPage + 1}</span>
                <button
                  disabled={(memoriesPage + 1) * 20 >= memoriesTotal}
                  onClick={() => fetchMemories(memoriesPage + 1)}
                  className="text-xs text-zinc-400 hover:text-zinc-200 disabled:opacity-30 disabled:cursor-not-allowed"
                >Next →</button>
              </div>
            )}
          </div>
        )}

        {/* ── Tone Tab ── */}
        {activeTab === 'tone' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-zinc-500 uppercase tracking-wider">Style Blueprints</h2>
              <button onClick={() => fetchToneProfiles()} className="p-1 text-zinc-500 hover:text-zinc-300 transition-colors" title="Refresh">
                <RefreshCw className={`w-4 h-4 ${toneLoading ? 'animate-spin' : ''}`} />
              </button>
            </div>

            <div className="p-3 rounded-lg bg-zinc-900 border border-zinc-800 space-y-2">
              <div className="text-sm font-medium text-zinc-200">Train active profile</div>
              <p className="text-xs text-zinc-500">
                Paste your writing below, or select text on a page and use the toolbar 🎨 / right-click → Train My Tone.
                EchoWrite learns habits like writing <span className="text-zinc-300">u</span> instead of <span className="text-zinc-300">you</span>, then applies them when you rewrite with <span className="text-zinc-300">My style</span>.
              </p>
              <textarea
                value={toneTrainText}
                onChange={(e) => setToneTrainText(e.target.value)}
                placeholder="Paste a sample of your writing (email, note, post)…"
                rows={4}
                className="w-full px-3 py-2 bg-zinc-950 border border-zinc-700 rounded-lg text-sm text-zinc-200 outline-none focus:border-teal-500 resize-y"
              />
              <button
                onClick={trainActiveTone}
                disabled={toneTrainLoading || toneTrainText.trim().length < 20}
                className="w-full py-2 bg-teal-500 text-white rounded-lg text-sm font-medium hover:bg-teal-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {toneTrainLoading
                  ? 'Training…'
                  : `Train “${toneProfiles.find(p => p.is_active)?.name || 'active profile'}”`}
              </button>
              {toneTrainMessage && (
                <p className="text-xs text-emerald-400">{toneTrainMessage}</p>
              )}
              {toneTrainError && (
                <div className="flex items-start gap-2 text-xs text-red-300">
                  <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                  <span>{toneTrainError}</span>
                </div>
              )}
            </div>

            {toneLoading ? (
              <div className="flex justify-center py-8">
                <div className="animate-spin rounded-full h-6 w-6 border-t-2 border-b-2 border-cyan-500" />
              </div>
            ) : toneProfiles.length === 0 ? (
              <div className="text-center py-8">
                <p className="text-sm text-zinc-500 mb-3">No tone profiles yet. Create one below, then train it with your writing.</p>
              </div>
            ) : (
              toneProfiles.map(tp => (
                <div key={tp.id} className={`p-4 rounded-xl bg-gradient-to-br from-zinc-900 to-zinc-900/50 border transition-colors ${tp.is_active ? 'border-teal-500/40' : 'border-zinc-800 hover:border-cyan-500/30'}`}>
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="font-medium text-zinc-200">{tp.name}</h3>
                    <div className="flex items-center gap-2">
                      {tp.is_active ? (
                        <span className="px-2 py-1 bg-teal-500/10 text-teal-400 text-xs font-semibold rounded flex items-center gap-1">
                          <Check className="w-3 h-3" /> Active
                        </span>
                      ) : (
                        <button
                          onClick={() => activateProfile(tp.id)}
                          className="text-xs text-zinc-500 hover:text-teal-400 transition-colors"
                        >Activate</button>
                      )}
                      <button onClick={() => deleteProfile(tp.id)} className="p-1 text-zinc-600 hover:text-red-400 transition-colors">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                  <p className="text-xs text-zinc-500 mb-3">{tp.samples_count || 0} sample{(tp.samples_count || 0) !== 1 ? 's' : ''} analyzed</p>
                  {tp.blueprint && Object.keys(tp.blueprint).length > 0 ? (
                    <>
                      <div className="flex flex-wrap gap-2 mb-2">
                        {tp.blueprint.tone && <span className="px-2.5 py-1 bg-zinc-800 text-zinc-300 text-xs rounded-full border border-zinc-700">{tp.blueprint.tone}</span>}
                        {tp.blueprint.formality && <span className="px-2.5 py-1 bg-zinc-800 text-zinc-300 text-xs rounded-full border border-zinc-700">{tp.blueprint.formality} formality</span>}
                        {tp.blueprint.voice && <span className="px-2.5 py-1 bg-zinc-800 text-zinc-300 text-xs rounded-full border border-zinc-700">{tp.blueprint.voice} voice</span>}
                        {tp.blueprint.vocabulary_level && <span className="px-2.5 py-1 bg-zinc-800 text-zinc-300 text-xs rounded-full border border-zinc-700">{tp.blueprint.vocabulary_level} vocab</span>}
                      </div>
                      {(tp.blueprint.writing_rules?.length || tp.blueprint.lexical_habits?.length) ? (
                        <div className="mt-2 p-2 rounded-lg bg-zinc-950/80 border border-zinc-800">
                          <p className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1.5">Learned writing habits</p>
                          <div className="flex flex-wrap gap-1.5">
                            {(tp.blueprint.writing_rules?.length
                              ? tp.blueprint.writing_rules
                              : (tp.blueprint.lexical_habits || []).map(
                                  (h) => `Prefer "${h.prefer}" over "${h.instead_of}"`
                                )
                            ).slice(0, 8).map((rule) => (
                              <span
                                key={rule}
                                className="px-2 py-0.5 rounded-md bg-teal-500/10 border border-teal-500/20 text-[11px] text-teal-200"
                              >
                                {rule}
                              </span>
                            ))}
                          </div>
                        </div>
                      ) : null}
                      {tp.blueprint.confidence_score != null && (
                        <div className="mt-2">
                          <div className="flex justify-between text-[10px] text-zinc-500 mb-1">
                            <span>Confidence</span>
                            <span>{Math.round(tp.blueprint.confidence_score * 100)}%</span>
                          </div>
                          <div className="w-full bg-zinc-800 rounded-full h-1">
                            <div className="bg-gradient-to-r from-cyan-500 to-teal-500 h-1 rounded-full transition-all" style={{ width: `${tp.blueprint.confidence_score * 100}%` }} />
                          </div>
                        </div>
                      )}
                    </>
                  ) : (
                    <p className="text-xs text-zinc-600">No style blueprint yet — train with a writing sample.</p>
                  )}
                </div>
              ))
            )}

            {showCreateProfile ? (
              <div className="flex gap-2">
                <input
                  value={newProfileName}
                  onChange={e => setNewProfileName(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && createToneProfile()}
                  placeholder="Profile name..."
                  className="flex-1 px-3 py-2 bg-zinc-900 border border-zinc-700 rounded-lg text-sm text-zinc-200 outline-none focus:border-teal-500"
                  autoFocus
                />
                <button onClick={createToneProfile} className="px-3 py-2 bg-teal-500 text-white rounded-lg text-sm font-medium hover:bg-teal-600 transition-colors">Create</button>
                <button onClick={() => setShowCreateProfile(false)} className="px-3 py-2 bg-zinc-800 text-zinc-400 rounded-lg text-sm hover:bg-zinc-700 transition-colors">✕</button>
              </div>
            ) : (
              <button onClick={() => setShowCreateProfile(true)} className="w-full py-2.5 bg-zinc-900 border border-zinc-800 text-zinc-300 rounded-lg text-sm font-medium hover:bg-zinc-800 transition-colors flex items-center justify-center gap-2">
                <Plus className="w-4 h-4" /> Create New Profile
              </button>
            )}
          </div>
        )}

        {/* ── Switch Tab (cross-LLM handoff) ── */}
        {activeTab === 'switch' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-sm font-semibold text-zinc-500 uppercase tracking-wider">Cross-LLM Continuity</h2>
                <p className="text-xs text-zinc-500 mt-1">Hit a free limit? Continue the same chat on another AI.</p>
              </div>
              <button onClick={fetchSwitchData} className="p-1 text-zinc-500 hover:text-zinc-300 transition-colors" title="Refresh">
                <RefreshCw className={`w-4 h-4 ${switchLoading ? 'animate-spin' : ''}`} />
              </button>
            </div>

            <div className="relative">
              <button
                type="button"
                onClick={() => setChatMenuOpen((o) => !o)}
                className="w-full flex items-center justify-between gap-2 px-3 py-2.5 rounded-lg bg-teal-500/15 border border-teal-500/40 text-sm font-medium text-teal-200 hover:bg-teal-500/25 transition-colors"
              >
                <span className="inline-flex items-center gap-2">
                  <Zap className="w-4 h-4" />
                  Chat actions
                </span>
                <ChevronDown className={`w-4 h-4 transition-transform ${chatMenuOpen ? 'rotate-180' : ''}`} />
              </button>
              {chatMenuOpen && (
                <div className="absolute z-20 mt-1.5 w-full rounded-lg border border-zinc-700 bg-zinc-900 shadow-xl overflow-hidden">
                  <button
                    type="button"
                    disabled={savingChat}
                    onClick={saveActiveChat}
                    className="w-full text-left px-3 py-2.5 text-sm text-zinc-100 hover:bg-teal-500/20 disabled:opacity-50 transition-colors"
                  >
                    {savingChat ? 'Saving…' : '💾 Save this chat'}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setChatMenuOpen(false);
                      fetchSwitchData();
                    }}
                    className="w-full text-left px-3 py-2.5 text-sm text-zinc-300 hover:bg-zinc-800 transition-colors border-t border-zinc-800"
                  >
                    ↻ Refresh saved thread
                  </button>
                </div>
              )}
              <p className="text-[11px] text-zinc-500 mt-1.5">
                Keep Claude/ChatGPT open in a tab, then choose <span className="text-zinc-300">Save this chat</span>.
              </p>
            </div>

            {(activeThread?.transcript || remoteSession?.content) ? (
              <div className="p-3 rounded-lg bg-zinc-900 border border-emerald-500/20 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-emerald-400 uppercase tracking-wide">Saved thread</span>
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-zinc-500">
                      {activeThread?.platform || remoteSession?.source_platform || 'unknown'}
                      {activeThread?.updatedAt ? ` · ${new Date(activeThread.updatedAt).toLocaleString()}` : ''}
                    </span>
                    <button
                      type="button"
                      onClick={() => setThreadExpanded((v) => !v)}
                      className="text-[11px] text-teal-300 hover:text-teal-200 inline-flex items-center gap-1"
                    >
                      {threadExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                      {threadExpanded ? 'Collapse' : 'Expand'}
                    </button>
                  </div>
                </div>
                <div
                  className={`text-xs text-zinc-300 whitespace-pre-wrap break-words ${
                    threadExpanded ? 'max-h-[50vh] overflow-y-auto pr-1' : 'line-clamp-4'
                  }`}
                >
                  {activeThread?.transcript || remoteSession?.content}
                </div>
                {(() => {
                  const t = activeThread?.transcript || remoteSession?.content || ''
                  const hasUser = /(?:^|\n)User:\s+/i.test(t)
                  const hasAsst = /(?:^|\n)Assistant:\s+/i.test(t)
                  if (hasUser && hasAsst) {
                    return (
                      <p className="text-[11px] text-emerald-500/80">
                        Ready to hand off — Continue on… sends only the last User + Assistant turn (keeps under LLM input limits).
                      </p>
                    )
                  }
                  if (hasAsst && !hasUser) {
                    return (
                      <p className="text-[11px] text-amber-400/90">
                        Assistant reply saved, but your messages weren’t detected. Scroll to the top of the Claude chat, then Save again.
                      </p>
                    )
                  }
                  return null
                })()}
              </div>
            ) : (
              <div className="p-4 rounded-lg bg-zinc-900 border border-zinc-800 text-sm text-zinc-400">
                No active conversation yet. Open an AI chat, then use <span className="text-zinc-200">Chat actions → Save this chat</span>.
              </div>
            )}

            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">Continue on</h3>
                <button
                  type="button"
                  onClick={() => setShowAddLlm((v) => !v)}
                  className="text-[11px] text-teal-300 hover:text-teal-200"
                >
                  {showAddLlm ? 'Cancel' : '+ Add LLM'}
                </button>
              </div>
              {showAddLlm && (
                <div className="p-3 rounded-lg bg-zinc-900 border border-zinc-700 space-y-2">
                  <p className="text-[11px] text-zinc-400">Add any chat URL (Perplexity, Grok, Poe, etc.).</p>
                  <div className="flex flex-wrap gap-1.5">
                    {[
                      { label: 'Perplexity', url: 'https://www.perplexity.ai/' },
                      { label: 'Grok', url: 'https://grok.com/' },
                      { label: 'Poe', url: 'https://poe.com/' },
                      { label: 'Mistral', url: 'https://chat.mistral.ai/' },
                    ].map((preset) => (
                      <button
                        key={preset.label}
                        type="button"
                        onClick={() => {
                          setNewLlmName(preset.label)
                          setNewLlmUrl(preset.url)
                        }}
                        className="px-2 py-1 rounded-md bg-zinc-800 text-[11px] text-zinc-300 hover:bg-zinc-700"
                      >
                        {preset.label}
                      </button>
                    ))}
                  </div>
                  <input
                    value={newLlmName}
                    onChange={(e) => setNewLlmName(e.target.value)}
                    placeholder="Name (e.g. Perplexity, Grok)"
                    className="w-full px-3 py-2 bg-zinc-950 border border-zinc-700 rounded-lg text-sm text-zinc-200 outline-none focus:border-teal-500"
                  />
                  <input
                    value={newLlmUrl}
                    onChange={(e) => setNewLlmUrl(e.target.value)}
                    placeholder="Chat URL (https://…)"
                    className="w-full px-3 py-2 bg-zinc-950 border border-zinc-700 rounded-lg text-sm text-zinc-200 outline-none focus:border-teal-500"
                  />
                  <button
                    type="button"
                    onClick={addCustomLlm}
                    className="w-full py-2 rounded-lg bg-teal-500/20 border border-teal-500/40 text-sm text-teal-200 hover:bg-teal-500/30"
                  >
                    Save LLM
                  </button>
                </div>
              )}
              <div className="grid grid-cols-2 gap-2">
                {allHandoffTargets().map((t) => (
                  <div key={t.id} className="relative group">
                    <button
                      disabled={!!handoffBusy}
                      onClick={() => continueOnTarget(t.id, { url: t.url, label: t.label })}
                      className="w-full px-3 py-2.5 rounded-lg bg-zinc-900 border border-zinc-800 text-sm text-zinc-200 hover:border-emerald-500/40 hover:bg-emerald-500/10 disabled:opacity-40 transition-colors"
                    >
                      {handoffBusy === t.id ? 'Opening…' : t.label}
                    </button>
                    {!t.builtin && (
                      <button
                        type="button"
                        title="Remove custom LLM"
                        onClick={() => removeCustomLlm(t.id)}
                        className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-zinc-800 border border-zinc-600 text-[10px] text-zinc-400 opacity-0 group-hover:opacity-100 hover:text-red-300"
                      >
                        ×
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {switchMessage && (
              <p className="text-xs text-emerald-400">{switchMessage}</p>
            )}
            {switchError && (
              <div className="flex items-start gap-2 text-xs text-red-400">
                <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                <span>{switchError}</span>
              </div>
            )}

            {migrationHistory.length > 0 && (
              <div className="space-y-2 pt-2">
                <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">Saved chats / handoffs</h3>
                {migrationHistory.map((m) => {
                  const expanded = !!expandedHandoffIds[m.id];
                  const body =
                    m.original_text ||
                    m.context_prompt ||
                    m.processed_summary ||
                    '';
                  return (
                    <div key={m.id} className="p-2.5 rounded-lg bg-zinc-900 border border-zinc-800 space-y-2">
                      <div className="flex items-start justify-between gap-2">
                        <div className="text-xs text-zinc-300 min-w-0">
                          <span className="text-zinc-100 capitalize">{m.source_platform}</span>
                          {' → '}
                          <span className="text-zinc-100 capitalize">{m.target_platform}</span>
                          <div className="text-[11px] text-zinc-500 mt-0.5">
                            {new Date(m.created_at).toLocaleString()}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() =>
                            setExpandedHandoffIds((prev) => ({ ...prev, [m.id]: !prev[m.id] }))
                          }
                          className="shrink-0 text-[11px] text-teal-300 hover:text-teal-200 inline-flex items-center gap-1"
                        >
                          {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                          {expanded ? 'Collapse' : 'Expand'}
                        </button>
                      </div>

                      {body && (
                        <div
                          className={`text-xs text-zinc-200 whitespace-pre-wrap break-words ${
                            expanded ? 'max-h-[40vh] overflow-y-auto pr-1' : 'line-clamp-3 text-zinc-400'
                          }`}
                        >
                          {body}
                        </div>
                      )}

                      <div className="relative">
                        <button
                          type="button"
                          disabled={!!handoffBusy}
                          onClick={() =>
                            setOpenMenuForHandoff((id) => (id === m.id ? null : m.id))
                          }
                          className="w-full flex items-center justify-between px-2.5 py-2 rounded-md bg-zinc-950 border border-zinc-700 text-xs text-zinc-200 hover:border-emerald-500/40"
                        >
                          <span>Open this chat on…</span>
                          <ChevronDown className={`w-3.5 h-3.5 transition-transform ${openMenuForHandoff === m.id ? 'rotate-180' : ''}`} />
                        </button>
                        {openMenuForHandoff === m.id && (
                          <div className="absolute z-30 mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 shadow-xl overflow-hidden max-h-48 overflow-y-auto">
                            {allHandoffTargets().map((t) => (
                              <button
                                key={`${m.id}-${t.id}`}
                                type="button"
                                disabled={!!handoffBusy}
                                onClick={() => openHandoffOn(m, t)}
                                className="w-full text-left px-3 py-2 text-xs text-zinc-200 hover:bg-emerald-500/15 disabled:opacity-40"
                              >
                                {handoffBusy === t.id ? `Opening ${t.label}…` : t.label}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* ── Settings Tab ── */}
        {activeTab === 'settings' && (
          <div className="space-y-6">



            <div className="space-y-3">
              <h3 className="text-sm font-semibold text-teal-300/80 uppercase tracking-wider">Preferences</h3>

              {/* Auto-inject toggle */}
              <div className="flex items-center justify-between p-3 bg-zinc-900 rounded-lg border border-zinc-800">
                <div>
                  <div className="text-sm font-medium text-zinc-100">Auto-inject Context</div>
                  <div className="text-xs text-zinc-400">Inject memories on ChatGPT / Claude / Gemini / DeepSeek</div>
                </div>
                <button
                  onClick={() => updateSetting('auto_inject_context', !settings_state.autoInjectContext)}
                  className={`w-10 h-6 rounded-full relative cursor-pointer transition-colors ${settings_state.autoInjectContext ? 'bg-teal-500' : 'bg-zinc-700'}`}
                >
                  <div className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-all ${settings_state.autoInjectContext ? 'right-1' : 'left-1'}`} />
                </button>
              </div>

              {/* Floating toolbar toggle */}
              <div className="flex items-center justify-between p-3 bg-zinc-900 rounded-lg border border-zinc-800">
                <div>
                  <div className="text-sm font-medium text-zinc-100">Floating Toolbar</div>
                  <div className="text-xs text-zinc-400">Show toolbar when you select text on any page</div>
                </div>
                <button
                  type="button"
                  onClick={() => updateSetting('show_floating_toolbar', !settings_state.showFloatingToolbar)}
                  className={`w-10 h-6 rounded-full relative cursor-pointer transition-colors ${settings_state.showFloatingToolbar ? 'bg-teal-500' : 'bg-zinc-700'}`}
                  aria-pressed={settings_state.showFloatingToolbar}
                  title={settings_state.showFloatingToolbar ? 'Floating toolbar on' : 'Floating toolbar off'}
                >
                  <div className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-all ${settings_state.showFloatingToolbar ? 'right-1' : 'left-1'}`} />
                </button>
              </div>

              {/* Default rewrite tone */}
              <div className="flex items-center justify-between gap-3 p-3 bg-zinc-900 rounded-lg border border-zinc-800">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-zinc-100">Default Tone</div>
                  <div className="text-xs text-zinc-400">Used by the floating toolbar for rewrites</div>
                </div>
                <select
                  value={settings_state.defaultTone}
                  onChange={e => updateSetting('default_tone', e.target.value)}
                  className="shrink-0 max-w-[160px] bg-zinc-950 border border-zinc-700 text-sm text-zinc-100 rounded-lg px-2 py-1.5 outline-none focus:border-teal-500/60"
                >
                  {TONES.map((tone) => (
                    <option key={tone.id} value={tone.id}>
                      {tone.emoji} {tone.label}
                    </option>
                  ))}
                </select>
              </div>

              {/* Default LLM */}
              <div className="flex items-center justify-between p-3 bg-zinc-900 rounded-lg border border-zinc-800">
                <div>
                  <div className="text-sm font-medium text-zinc-100">Default AI Model</div>
                  <div className="text-xs text-zinc-400">Used for writing operations</div>
                </div>
                <select
                  value={settings_state.defaultLLM}
                  onChange={e => updateSetting('default_llm', e.target.value)}
                  className="bg-zinc-950 border border-zinc-700 text-sm text-zinc-100 rounded-lg px-2 py-1.5 outline-none focus:border-teal-500/60"
                >
                  <option value="gpt-4o-mini">GPT-4o mini</option>
                  <option value="gpt-4o">GPT-4o</option>
                  <option value="claude-sonnet-4">Claude Sonnet 4</option>
                  <option value="gemini-2.5-flash-lite">Gemini 2.5 Flash Lite</option>
                  <option value="gemini-2.5-flash">Gemini 2.5 Flash</option>
                </select>
              </div>
            </div>

            {/* Account Section */}
            <div className="space-y-3">
              <h3 className="text-sm font-semibold text-zinc-500 uppercase tracking-wider">Account</h3>
              <div className="p-4 bg-zinc-900 rounded-lg border border-zinc-800 space-y-3">
                <div>
                  <div className="text-sm font-medium text-zinc-200">{session?.user?.email}</div>
                  <div className={`text-xs font-medium mt-1 uppercase ${
                    profile?.plan === 'pro' ? 'text-emerald-400' : profile?.plan === 'team' ? 'text-cyan-400' : 'text-zinc-500'
                  }`}>
                    {profile?.plan || 'Free'} Plan
                    {profile?.plan === 'pro' ? ' · $9/mo' : ''}
                  </div>
                </div>

                {(profile?.plan === 'free' || !profile?.plan) && (
                  <button
                    type="button"
                    onClick={handleUpgrade}
                    disabled={upgradeLoading}
                    className="w-full text-sm bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-zinc-950 px-3 py-2.5 rounded-lg transition-colors font-semibold flex items-center justify-center gap-2"
                  >
                    <Crown className="w-4 h-4" />
                    {upgradeLoading ? 'Opening checkout…' : 'Upgrade to Pro'}
                  </button>
                )}

                <button
                  type="button"
                  onClick={handleManageSubscription}
                  disabled={portalLoading}
                  className="w-full text-sm bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 text-zinc-200 px-3 py-2 rounded-lg transition-colors font-medium"
                >
                  {portalLoading ? 'Opening…' : 'Manage Subscription'}
                </button>

                {(profile?.plan === 'free' || !profile?.plan) && (
                  <button
                    type="button"
                    onClick={() => { setUpgradeError(''); setShowPricing(true); }}
                    className="w-full text-[11px] text-zinc-500 hover:text-zinc-300"
                  >
                    See Pro plan details ($9/mo)
                  </button>
                )}

                {upgradeError && (
                  <p className="text-xs text-red-400">{upgradeError}</p>
                )}
                {portalError && (
                  <p className="text-xs text-amber-400/90">{portalError}</p>
                )}
              </div>
            </div>
          </div>
        )}
      </main>

      <PricingModal
        open={showPricing}
        onClose={() => setShowPricing(false)}
        onUpgrade={handleUpgrade}
        upgrading={upgradeLoading}
        error={upgradeError}
        currentPlan={profile?.plan || 'free'}
      />
    </div>
  );
}
