import { useState } from 'react'
import { AlertCircle, ArrowRight, Check, Eye, EyeOff, Lock, Mail, User } from 'lucide-react'
import { supabase, SUPABASE_URL } from '../utils'
import { syncAuthToken } from '../utils/api'

type AuthMode = 'signin' | 'signup'

type AuthFormProps = {
  compact?: boolean
  onAuthenticated?: () => void | Promise<void>
}

export default function AuthForm({ compact = false, onAuthenticated }: AuthFormProps) {
  const [authMode, setAuthMode] = useState<AuthMode>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [fullName, setFullName] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [authLoading, setAuthLoading] = useState(false)
  const [authError, setAuthError] = useState('')
  const [authSuccess, setAuthSuccess] = useState('')

  const inputClass = compact
    ? 'w-full pl-9 pr-3 py-2.5 bg-zinc-900 border border-zinc-800 rounded-lg text-sm text-zinc-100 placeholder-zinc-500 outline-none focus:border-violet-500/50 focus:ring-1 focus:ring-violet-500/25 transition-all'
    : 'w-full pl-10 pr-4 py-3 bg-zinc-900 border border-zinc-800 rounded-xl text-sm text-zinc-100 placeholder-zinc-500 outline-none focus:border-violet-500/50 focus:ring-1 focus:ring-violet-500/25 transition-all'

  const handleEmailAuth = async (e: React.FormEvent) => {
    e.preventDefault()
    setAuthError('')
    setAuthSuccess('')
    setAuthLoading(true)

    try {
      if (authMode === 'signup') {
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            data: { full_name: fullName },
          },
        })
        if (error) throw error

        if (data.session?.access_token) {
          await syncAuthToken(data.session.access_token)
          await onAuthenticated?.()
          setAuthSuccess('')
        } else {
          setAuthSuccess('Account created! Check your email to verify, then sign in.')
          setAuthMode('signin')
        }
      } else {
        await syncAuthToken(null)
        const { data, error } = await supabase.auth.signInWithPassword({ email, password })
        if (error) throw error
        if (data.session?.access_token) {
          await syncAuthToken(data.session.access_token)
          await onAuthenticated?.()
        } else {
          throw new Error('No session returned. Confirm your email first, then try again.')
        }
      }
    } catch (err: any) {
      setAuthError(err.message || 'Authentication failed')
    } finally {
      setAuthLoading(false)
    }
  }

  const handleGoogleSignIn = async () => {
    setAuthError('')
    setAuthLoading(true)

    try {
      const redirectUrl = chrome.identity.getRedirectURL()
      const authUrl = `${SUPABASE_URL}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(redirectUrl)}`

      const responseUrl = await new Promise<string>((resolve, reject) => {
        chrome.identity.launchWebAuthFlow(
          { url: authUrl, interactive: true },
          (url) => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message))
            } else if (url) {
              resolve(url)
            } else {
              reject(new Error('No response URL'))
            }
          }
        )
      })

      const hashParams = new URLSearchParams(
        responseUrl.includes('#') ? responseUrl.split('#')[1] : responseUrl.split('?')[1]
      )
      const accessToken = hashParams.get('access_token')
      const refreshToken = hashParams.get('refresh_token')

      if (!accessToken) {
        throw new Error('No access token received from Google')
      }

      const { error } = await supabase.auth.setSession({
        access_token: accessToken,
        refresh_token: refreshToken || '',
      })
      if (error) throw error
      await syncAuthToken(accessToken)
      await onAuthenticated?.()
    } catch (err: any) {
      if (err.message?.includes('canceled') || err.message?.includes('closed')) {
        // User closed the auth window — not an error
      } else if (err.message?.includes('Authorization page could not be loaded')) {
        const redirectUrl = chrome.identity.getRedirectURL()
        setAuthError(`Google sign-in needs this Redirect URL in Supabase: ${redirectUrl}`)
      } else {
        setAuthError(err.message || 'Google sign-in failed')
      }
    } finally {
      setAuthLoading(false)
    }
  }

  return (
    <div className={compact ? 'w-full' : 'w-full'}>
      <div className={`flex bg-zinc-900 rounded-xl p-1 mb-4 border border-zinc-800 ${compact ? 'mb-3' : 'mb-5'}`}>
        <button
          type="button"
          onClick={() => { setAuthMode('signin'); setAuthError(''); setAuthSuccess('') }}
          className={`flex-1 py-2 text-sm font-medium rounded-lg transition-all duration-200 ${
            authMode === 'signin'
              ? 'bg-violet-500 text-white shadow-lg shadow-violet-500/25'
              : 'text-zinc-400 hover:text-zinc-200'
          }`}
        >
          Sign In
        </button>
        <button
          type="button"
          onClick={() => { setAuthMode('signup'); setAuthError(''); setAuthSuccess('') }}
          className={`flex-1 py-2 text-sm font-medium rounded-lg transition-all duration-200 ${
            authMode === 'signup'
              ? 'bg-violet-500 text-white shadow-lg shadow-violet-500/25'
              : 'text-zinc-400 hover:text-zinc-200'
          }`}
        >
          Sign Up
        </button>
      </div>

      {authError && (
        <div className="flex items-start gap-2 p-3 mb-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>{authError}</span>
        </div>
      )}
      {authSuccess && (
        <div className="flex items-start gap-2 p-3 mb-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-sm">
          <Check className="w-4 h-4 mt-0.5 shrink-0" />
          <span>{authSuccess}</span>
        </div>
      )}

      <form onSubmit={handleEmailAuth} className="space-y-3">
        {authMode === 'signup' && (
          <div className="relative">
            <User className={`absolute left-3 top-1/2 -translate-y-1/2 ${compact ? 'w-3.5 h-3.5' : 'w-4 h-4'} text-zinc-500`} />
            <input
              type="text"
              placeholder="Full name"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              className={inputClass}
            />
          </div>
        )}

        <div className="relative">
          <Mail className={`absolute left-3 top-1/2 -translate-y-1/2 ${compact ? 'w-3.5 h-3.5' : 'w-4 h-4'} text-zinc-500`} />
          <input
            type="email"
            placeholder="Email address"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            className={inputClass}
          />
        </div>

        <div className="relative">
          <Lock className={`absolute left-3 top-1/2 -translate-y-1/2 ${compact ? 'w-3.5 h-3.5' : 'w-4 h-4'} text-zinc-500`} />
          <input
            type={showPassword ? 'text' : 'password'}
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={6}
            className={`${inputClass} pr-10`}
          />
          <button
            type="button"
            onClick={() => setShowPassword(!showPassword)}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
          </button>
        </div>

        <button
          type="submit"
          disabled={authLoading}
          className="w-full py-2.5 bg-gradient-to-r from-violet-500 to-violet-600 hover:from-violet-600 hover:to-violet-700 text-white font-semibold rounded-xl transition-all duration-200 shadow-lg shadow-violet-500/25 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
        >
          {authLoading ? (
            <div className="animate-spin rounded-full h-4 w-4 border-t-2 border-b-2 border-white" />
          ) : (
            <>
              {authMode === 'signin' ? 'Sign In' : 'Create Account'}
              <ArrowRight className="w-4 h-4" />
            </>
          )}
        </button>
      </form>

      <div className="flex items-center gap-3 my-4">
        <div className="flex-1 h-px bg-zinc-800" />
        <span className="text-xs text-zinc-500 uppercase tracking-wider">or</span>
        <div className="flex-1 h-px bg-zinc-800" />
      </div>

      <button
        type="button"
        onClick={handleGoogleSignIn}
        disabled={authLoading}
        className="w-full py-2.5 bg-zinc-900 border border-zinc-800 text-zinc-200 font-medium rounded-xl hover:bg-zinc-800 hover:border-zinc-700 transition-all duration-200 flex items-center justify-center gap-3 disabled:opacity-50"
      >
        <svg className="w-4 h-4" viewBox="0 0 24 24">
          <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/>
          <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
          <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
          <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
        </svg>
        Continue with Google
      </button>
    </div>
  )
}
