import { useState } from 'react';
import { Lock, UserPlus, X } from 'lucide-react';
import type { AuthUser, CityName } from '../types/storestream';

interface AuthModalProps {
  isOpen: boolean;
  cities: CityName[];
  defaultCity: CityName;
  onClose: () => void;
  onAuthenticated: (user: AuthUser, token: string) => void;
}

export function AuthModal({
  isOpen,
  cities,
  defaultCity,
  onClose,
  onAuthenticated,
}: AuthModalProps) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [city, setCity] = useState<CityName>(defaultCity);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (!isOpen) return null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const endpoint = mode === 'login' ? '/api/auth/login' : '/api/auth/register';
      const body =
        mode === 'login'
          ? { email, password }
          : { name, email, password, defaultCity: city };

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as {
        user?: AuthUser;
        token?: string;
        error?: string;
      };
      if (!res.ok || !data.user || !data.token) {
        throw new Error(data.error || 'Authentication failed.');
      }
      onAuthenticated(data.user, data.token);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to authenticate.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-950/50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Account Sign In"
    >
      <div className="bg-white border border-slate-200 rounded-2xl w-full max-w-md overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
          <h2 className="text-base font-display font-semibold text-slate-900">
            {mode === 'login' ? 'Sign In to StoreStream' : 'Create Customer Account'}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="p-2 text-slate-500 hover:text-slate-900 rounded-lg"
            aria-label="Close sign in"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <div className="flex gap-1 p-1 bg-slate-100 rounded-lg text-xs">
            <button
              type="button"
              onClick={() => {
                setMode('login');
                setError(null);
              }}
              className={`flex-1 py-1.5 font-medium rounded-md transition-colors ${
                mode === 'login' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
              }`}
            >
              Sign In
            </button>
            <button
              type="button"
              onClick={() => {
                setMode('register');
                setError(null);
              }}
              className={`flex-1 py-1.5 font-medium rounded-md transition-colors ${
                mode === 'register' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
              }`}
            >
              Register Customer
            </button>
          </div>

          {mode === 'register' && (
            <label className="block space-y-1">
              <span className="text-xs text-slate-600">Full Name</span>
              <input
                type="text"
                required
                minLength={2}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Priya Nair"
                className="w-full px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-lg"
              />
            </label>
          )}

          <label className="block space-y-1">
            <span className="text-xs text-slate-600">Email Address</span>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="priya@example.in"
              className="w-full px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-lg"
            />
          </label>

          <label className="block space-y-1">
            <span className="text-xs text-slate-600">Password</span>
            <input
              type="password"
              required
              minLength={6}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Minimum 6 characters"
              className="w-full px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-lg"
            />
          </label>

          {mode === 'register' && (
            <label className="block space-y-1">
              <span className="text-xs text-slate-600">Default Delivery City</span>
              <select
                value={city}
                onChange={(e) => setCity(e.target.value as CityName)}
                className="w-full px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-lg"
              >
                {cities.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
          )}

          {error && (
            <div className="p-3 rounded-lg border border-red-200 bg-red-50 text-xs text-red-700">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="w-full py-2.5 px-4 text-xs font-medium text-white bg-slate-900 hover:bg-blue-700 disabled:opacity-60 rounded-lg inline-flex items-center justify-center gap-2 min-h-[42px]"
          >
            {mode === 'login' ? <Lock className="w-3.5 h-3.5" /> : <UserPlus className="w-3.5 h-3.5" />}
            {submitting
              ? 'Verifying...'
              : mode === 'login'
              ? 'Sign In'
              : 'Create Customer Account'}
          </button>
        </form>
      </div>
    </div>
  );
}
