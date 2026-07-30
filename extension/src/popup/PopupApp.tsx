import { useEffect, useState } from 'react';
import { supabase, storage, STORAGE_KEYS, ACTIONS } from '../utils';
import { billingAPI, profileAPI, syncAuthToken, type UserProfile } from '../utils/api';
import { Settings, ExternalLink, Zap, BrainCircuit, Activity, Crown } from 'lucide-react';
import AuthForm from '../components/AuthForm';

export default function PopupApp() {
  const [session, setSession] = useState<any>(null);
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      if (session?.user) {
        fetchUserProfile(session);
      } else {
        setLoading(false);
      }
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      setSession(session);
      if (session?.user) {
        // Avoid repeated backend fetches for every token refresh event.
        if (event === 'SIGNED_IN' || event === 'USER_UPDATED') {
          fetchUserProfile(session);
        }
      } else {
        setUserProfile(null);
        setLoading(false);
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  const fetchUserProfile = async (sess: any) => {
    try {
      // Load cached profile for instant display
      const cached = await storage.get<UserProfile>(STORAGE_KEYS.USER);
      if (cached) setUserProfile(cached);

      // Fetch fresh from backend
      const token = sess?.access_token;
      if (!token) { setLoading(false); return; }
      await syncAuthToken(token);

      const profile = await profileAPI.me();
      setUserProfile(profile);
      await storage.set(STORAGE_KEYS.USER, profile);
    } catch (err) {
      console.error('Failed to fetch profile:', err);
    } finally {
      setLoading(false);
    }
  };

  const openSidePanel = () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs.length > 0 && tabs[0].windowId) {
        try {
          chrome.sidePanel.open({ windowId: tabs[0].windowId });
        } catch (e) {
          chrome.runtime.sendMessage({ action: ACTIONS.OPEN_SIDEPANEL });
        }
      } else {
        chrome.runtime.sendMessage({ action: ACTIONS.OPEN_SIDEPANEL });
      }
      window.close();
    });
  };

  const handleAuthenticated = async () => {
    const { data } = await supabase.auth.getSession();
    setSession(data.session);
    if (data.session) {
      await fetchUserProfile(data.session);
    }
  };

  const handleUpgrade = async () => {
    try {
      const result = await billingAPI.createCheckout('pro');
      if (result.checkout_url) {
        chrome.tabs.create({ url: result.checkout_url });
        window.close();
      }
    } catch {
      openSidePanel();
    }
  };

  const totalWrites = (userProfile?.rewrites_used || 0) +
    (userProfile?.summarizes_used || 0) +
    (userProfile?.expands_used || 0);

  const writeLimit = userProfile?.limits?.rewrites || 30;
  const usagePercent = writeLimit > 0 ? Math.min(100, (totalWrites / writeLimit) * 100) : 0;

  if (loading) {
    return (
      <div className="w-[320px] h-[400px] flex items-center justify-center bg-zinc-950 text-zinc-100">
        <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-violet-500"></div>
      </div>
    );
  }

  return (
    <div className="w-[320px] min-h-[400px] bg-zinc-950 text-zinc-100 font-sans flex flex-col">
      <header className="p-4 border-b border-zinc-800 flex items-center justify-between bg-zinc-900/50">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-violet-500 to-cyan-400 flex items-center justify-center shadow-lg shadow-violet-500/20">
            <Zap className="w-4 h-4 text-white" />
          </div>
          <h1 className="font-bold text-lg tracking-tight bg-clip-text text-transparent bg-gradient-to-r from-zinc-100 to-zinc-400">EchoWrite</h1>
        </div>
        <button onClick={openSidePanel} className="p-1.5 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 rounded-md transition-colors">
          <Settings className="w-5 h-5" />
        </button>
      </header>

      <main className="flex-1 flex flex-col p-4">
        {!session ? (
          <div className="flex-1 flex flex-col">
            <div className="text-center mb-3">
              <h2 className="text-base font-semibold text-zinc-200">Sign in to EchoWrite</h2>
              <p className="text-xs text-zinc-400 mt-1">Create an account or sign in to use rewrite, memory, and tone tools.</p>
            </div>
            <AuthForm compact onAuthenticated={handleAuthenticated} />
          </div>
        ) : (
          <div className="flex flex-col gap-6">
            {/* Quick Stats */}
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-3 flex flex-col items-center justify-center gap-1 hover:border-violet-500/30 transition-colors cursor-pointer" onClick={openSidePanel}>
                <span className="text-2xl font-bold text-violet-400">{totalWrites}</span>
                <span className="text-xs text-zinc-400 uppercase tracking-wider font-medium">Writes Used</span>
              </div>
              <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-3 flex flex-col items-center justify-center gap-1 hover:border-cyan-500/30 transition-colors cursor-pointer" onClick={openSidePanel}>
                <span className="text-2xl font-bold text-cyan-400">{userProfile?.memories_count || 0}</span>
                <span className="text-xs text-zinc-400 uppercase tracking-wider font-medium">Memories</span>
              </div>
            </div>

            {/* Quick Actions */}
            <div>
              <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-3 px-1">Quick Actions</h3>
              <div className="space-y-2">
                <button onClick={openSidePanel} className="w-full flex items-center justify-between p-3 rounded-lg bg-zinc-900 border border-zinc-800 hover:bg-zinc-800 transition-colors group">
                  <div className="flex items-center gap-3">
                    <BrainCircuit className="w-5 h-5 text-zinc-400 group-hover:text-violet-400 transition-colors" />
                    <span className="text-sm font-medium text-zinc-200">Open Dashboard</span>
                  </div>
                  <ExternalLink className="w-4 h-4 text-zinc-600 group-hover:text-zinc-400" />
                </button>
                <button onClick={openSidePanel} className="w-full flex items-center justify-between p-3 rounded-lg bg-zinc-900 border border-zinc-800 hover:bg-zinc-800 transition-colors group">
                  <div className="flex items-center gap-3">
                    <Activity className="w-5 h-5 text-zinc-400 group-hover:text-cyan-400 transition-colors" />
                    <span className="text-sm font-medium text-zinc-200">Tone Profiles</span>
                  </div>
                  <ExternalLink className="w-4 h-4 text-zinc-600 group-hover:text-zinc-400" />
                </button>
              </div>
            </div>

            {/* Plan Status */}
            <div className="mt-auto pt-4 border-t border-zinc-800/50">
              <div className="flex items-center justify-between text-sm">
                <span className="text-zinc-400">Current Plan</span>
                <span className={`px-2 py-0.5 rounded font-medium uppercase text-xs ${
                  userProfile?.plan === 'pro' ? 'bg-violet-500/20 text-violet-300' :
                  userProfile?.plan === 'team' ? 'bg-cyan-500/20 text-cyan-300' :
                  'bg-zinc-800 text-zinc-300'
                }`}>
                  {userProfile?.plan || 'Free'}
                </span>
              </div>
              {userProfile?.plan === 'free' && (
                <>
                  <div className="mt-3 w-full bg-zinc-900 rounded-full h-1.5 overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all duration-500 ${
                        usagePercent > 80 ? 'bg-gradient-to-r from-orange-500 to-red-500' :
                        'bg-gradient-to-r from-violet-500 to-cyan-400'
                      }`}
                      style={{ width: `${usagePercent}%` }}
                    ></div>
                  </div>
                  <div className="flex items-center justify-between mt-2">
                    <span className="text-[10px] text-zinc-500">{totalWrites}/{writeLimit} writes</span>
                    <button
                      onClick={handleUpgrade}
                      className="text-[10px] text-emerald-400 hover:text-emerald-300 font-medium flex items-center gap-1 transition-colors"
                      title="Upgrade to Pro — $9/mo"
                    >
                      <Crown className="w-3 h-3" /> Upgrade to Pro
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
