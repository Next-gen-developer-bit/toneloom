import { Check, Crown, X, Loader2 } from 'lucide-react'

type PricingModalProps = {
  open: boolean
  onClose: () => void
  onUpgrade: () => Promise<void> | void
  upgrading?: boolean
  error?: string
  currentPlan?: string
}

const PRO_FEATURES = [
  'Unlimited rewrites, summaries & expands',
  'Unlimited memory storage',
  'Unlimited tone / style profiles',
  'Personal writing style learning (u → you habits)',
  'Cross-LLM chat handoff (ChatGPT, Claude, Gemini & more)',
  'All current EchoWrite features, no caps',
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

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="ew-pricing-title"
    >
      <div
        className="w-full max-w-[360px] rounded-2xl border border-zinc-700 bg-zinc-950 shadow-2xl shadow-black/50 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 pt-5 pb-3">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Pricing</p>
            <h2 id="ew-pricing-title" className="text-lg font-semibold text-zinc-100 mt-0.5">
              Simple plans
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
          {/* Free — quiet reference */}
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="text-sm font-medium text-zinc-300">Free</h3>
              <p className="text-sm text-zinc-500">$0</p>
            </div>
            <p className="text-xs text-zinc-500 mt-1">Try EchoWrite with daily limits.</p>
          </div>

          {/* Pro — primary offer */}
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
                <p className="text-xs text-zinc-400 mt-1">For writers who use EchoWrite every day.</p>
              </div>
              <div className="text-right shrink-0">
                <p className="text-2xl font-semibold text-zinc-50 tracking-tight">$9</p>
                <p className="text-[11px] text-zinc-500">/ month</p>
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

            {error && (
              <p className="mt-3 text-xs text-red-400">{error}</p>
            )}

            {isPro ? (
              <p className="mt-4 text-center text-xs text-emerald-400 font-medium">
                You’re on Pro — thank you.
              </p>
            ) : (
              <button
                type="button"
                onClick={() => onUpgrade()}
                disabled={upgrading}
                className="mt-4 w-full py-2.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-zinc-950 text-sm font-semibold transition-colors flex items-center justify-center gap-2"
              >
                {upgrading ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Opening checkout…
                  </>
                ) : (
                  <>
                    <Crown className="w-4 h-4" />
                    Upgrade to Pro — $9/mo
                  </>
                )}
              </button>
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
