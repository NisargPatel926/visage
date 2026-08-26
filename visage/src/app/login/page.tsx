'use client';

import { useActionState } from 'react';
import { login, type LoginState } from '../../server/auth/actions';

export default function LoginPage() {
  const [state, action, pending] = useActionState<LoginState, FormData>(login, {});

  return (
    <div className="wrap" style={{ maxWidth: 420, paddingTop: 80 }}>
      <h1>Sign in</h1>
      <p className="lede">Use the firm code your attorney gave you.</p>

      <form action={action} className="card">
        {state.error ? <div className="err">{state.error}</div> : null}

        <div className="field">
          <label htmlFor="firm">Firm code</label>
          <input id="firm" name="firm" type="text" autoComplete="organization" required />
        </div>
        <div className="field">
          <label htmlFor="email">Email</label>
          <input id="email" name="email" type="email" autoComplete="username" required />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input id="password" name="password" type="password" autoComplete="current-password" required />
        </div>

        <button type="submit" disabled={pending}>{pending ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </div>
  );
}
