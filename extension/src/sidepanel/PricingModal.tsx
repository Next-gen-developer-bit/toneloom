import { Check, Crown, KeyRound, X, Loader2 } from 'lucide-react'

type PricingModalProps = {
  open: boolean
  onClose: () => void
  onUpgrade: (plan?: string) => Promise<void> | void
  upgrading?: boolean
  error?: string
  currentPlan?: string
}

const PRO_FEATURES = [
  'Unlimited rewrites, summaries & expands',
  'Cross-LLM chat handoff (ChatGPT, Claude, Gemini & more)',
  'Up to 3 tone / style profiles',
  'Personal writing style learning (u → you habits)',
  'Expanded memory for context continuity',
]

const BYOK_FEATURES = [
  'Bring your own OpenAI / Anthropic / Gemini API key',
  'Rewrites run on your key — zero rewrite load on our servers',
  'Up to 3 tone profiles + cross-LLM handoff',
  'Keys stay in your browser (local storage)',
]

export default function PricingModal({
  open,
  onClose,
  onUpgrade,
  upgrading = false,
  error = '',
  currentPlan = 'free',
}: PricingModalProps) {
  if (!open) return null

  const isPro = currentPlan === 'pro' || currentPlan === 'team'
  const isByok = currentPlan === 'byok'

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="tl-pricing-title"
    >
      <div
        className="w-full max-w-[380px] max-h-[90vh] overflow-y-auto rounded-2xl border border-zinc-700 bg-zinc-950 shadow-2xl shadow-black/50"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 pt-5 pb-3 sticky top-0 bg-zinc-950 z-10">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Pricing</p>
            <h2 id="tl-pricing-title" className="text-lg font-semibold text-zinc-100 mt-0.5">
              ToneLoom plans
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 pb-5 space-y-3">
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="text-sm font-medium text-zinc-300">Free</h3>
              <p className="text-sm text-zinc-500">$0</p>
            </div>
            <p className="text-xs text-zinc-500 mt-1">
              Core rewrites, 1 tone profile, and a basic memory starter.
            </p>
          </div>

          <div className="rounded-xl border border-emerald-500/40 bg-gradient-to-b from-emerald-500/10 to-zinc-900 p-4 relative">
            <div className="absolute -top-2.5 right-4 px-2 py-0.5 rounded-full bg-emerald-500 text-[10px] font-semibold text-zinc-950 uppercase tracking-wide">
              Recommended
            </div>
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-1.5">
                  <Crown className="w-4 h-4 text-emerald-400" />
                  <h3 className="text-base font-semibold text-zinc-50">Pro</h3>
                </div>
                <p className="text-xs text-zinc-400 mt-1">Unlimited rewrites + cross-LLM handoff.</p>
              </div>
              <div className="text-right shrink-0">
                <p className="text-2xl font-semibold text-zinc-50 tracking-tight">$12</p>
                <p className="text-[11px] text-zinc-500">/ mo · or $79/yr</p>
              </div>
            </div>

            <ul className="mt-4 space-y-2">
              {PRO_FEATURES.map((feature) => (
                <li key={feature} className="flex items-start gap-2 text-xs text-zinc-300">
                  <Check className="w-3.5 h-3.5 text-emerald-400 mt-0.5 shrink-0" />
                  <span>{feature}</span>
                </li>
              ))}
            </ul>

            {error && <p className="mt-3 text-xs text-red-400">{error}</p>}

            {isPro ? (
              <p className="mt-4 text-center text-xs text-emerald-400 font-medium">You’re on Pro — thank you.</p>
            ) : (
              <div className="mt-4 grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => onUpgrade('pro')}
                  disabled={upgrading}
                  className="py-2.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-zinc-950 text-xs font-semibold transition-colors"
                >
                  {upgrading ? '…' : '$12 / mo'}
                </button>
                <button
                  type="button"
                  onClick={() => onUpgrade('pro_yearly')}
                  disabled={upgrading}
                  className="py-2.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-emerald-500/30 disabled:opacity-50 text-zinc-100 text-xs font-semibold transition-colors"
                >
                  {upgrading ? '…' : '$79 / yr'}
                </button>
              </div>
            )}
          </div>

          <div className="rounded-xl border border-amber-500/35 bg-gradient-to-b from-amber-500/10 to-zinc-900 p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-1.5">
                  <KeyRound className="w-4 h-4 text-amber-400" />
                  <h3 className="text-base font-semibold text-zinc-50">BYOK</h3>
                </div>
                <p className="text-xs text-zinc-400 mt-1">Bring your own API key.</p>
              </div>
              <div className="text-right shrink-0">
                <p className="text-2xl font-semibold text-zinc-50 tracking-tight">$4</p>
                <p className="text-[11px] text-zinc-500">/ mo · or $29/yr</p>
              </div>
            </div>

            <ul className="mt-4 space-y-2">
              {BYOK_FEATURES.map((feature) => (
                <li key={feature} className="flex items-start gap-2 text-xs text-zinc-300">
                  <Check className="w-3.5 h-3.5 text-amber-400 mt-0.5 shrink-0" />
                  <span>{feature}</span>
                </li>
              ))}
            </ul>

            {isByok ? (
              <p className="mt-4 text-center text-xs text-amber-300 font-medium">You’re on BYOK.</p>
            ) : (
              <div className="mt-4 grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => onUpgrade('byok')}
                  disabled={upgrading}
                  className="py-2.5 rounded-lg bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-zinc-950 text-xs font-semibold transition-colors flex items-center justify-center gap-1"
                >
                  {upgrading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : '$4 / mo'}
                </button>
                <button
                  type="button"
                  onClick={() => onUpgrade('byok_yearly')}
                  disabled={upgrading}
                  className="py-2.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-amber-500/30 disabled:opacity-50 text-zinc-100 text-xs font-semibold transition-colors"
                >
                  {upgrading ? '…' : '$29 / yr'}
                </button>
              </div>
            )}
          </div>

          <p className="text-[11px] text-center text-zinc-600">
            Cancel anytime from Settings → Manage Subscription.
          </p>
        </div>
      </div>
    </div>
  )
}
