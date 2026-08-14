// Sign in with Google, without an auth vendor in between.
//
// Google Identity Services hands us an ID token — a JWT signed by Google —
// and Convex verifies it against Google's public keys using the provider
// declared in convex/auth.config.js. Nothing else sits in the path, and no
// third party learns who our users are.
//
// The whole thing is OPTIONAL. If VITE_GOOGLE_CLIENT_ID is unset the button
// does not render and the app behaves exactly as it did before, because a
// missing client ID is a configuration state, not an error, and a city that
// refuses to load because nobody set up OAuth would be a bad trade.
//
// KNOWN LIMIT: a Google ID token lasts one hour and Identity Services will not
// silently mint a new one. When it expires the session drops back to signed
// out and the button reappears. Staying signed in indefinitely needs a real
// session — a refresh token held server-side, or an auth service — and that is
// a bigger change than "log in with Google".

import { ReactNode, createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { convex } from '../components/ConvexClientProvider.tsx';

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined;

type GoogleUser = { sub: string; name?: string; email?: string; picture?: string };
type AuthState = {
  user: GoogleUser | null;
  configured: boolean;
  signOut: () => void;
  /** Renders the Google button into a container. */
  mount: (el: HTMLElement | null) => void;
};

const Ctx = createContext<AuthState>({
  user: null,
  configured: false,
  signOut: () => {},
  mount: () => {},
});

export const useGoogleAuth = () => useContext(Ctx);

/** Decode a JWT payload. Display only — the SERVER verifies the signature. */
function readClaims(token: string): GoogleUser | null {
  try {
    const [, payload] = token.split('.');
    const json = JSON.parse(
      decodeURIComponent(
        atob(payload.replace(/-/g, '+').replace(/_/g, '/'))
          .split('')
          .map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
          .join(''),
      ),
    );
    return { sub: json.sub, name: json.name, email: json.email, picture: json.picture };
  } catch {
    return null;
  }
}

declare global {
  interface Window {
    google?: any;
  }
}

export function GoogleAuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<GoogleUser | null>(null);
  const tokenRef = useRef<string | null>(null);
  const containerRef = useRef<HTMLElement | null>(null);
  const [ready, setReady] = useState(false);

  const applyToken = useCallback((token: string | null) => {
    tokenRef.current = token;
    if (token) {
      // Convex asks for the token on every reconnect, so hand it a function
      // rather than a value — a stale closure here is a session that silently
      // stops authenticating after the first reconnect.
      convex.setAuth(async () => tokenRef.current ?? undefined);
      setUser(readClaims(token));
    } else {
      convex.clearAuth();
      setUser(null);
    }
  }, []);

  useEffect(() => {
    if (!CLIENT_ID) return;
    const existing = sessionStorage.getItem('gv.googleToken');
    if (existing) applyToken(existing);

    if (window.google?.accounts?.id) {
      setReady(true);
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.defer = true;
    script.onload = () => setReady(true);
    document.head.appendChild(script);
  }, [applyToken]);

  useEffect(() => {
    if (!CLIENT_ID || !ready || !window.google?.accounts?.id) return;
    window.google.accounts.id.initialize({
      client_id: CLIENT_ID,
      callback: (res: { credential?: string }) => {
        if (!res.credential) return;
        // sessionStorage, not localStorage: the token is a bearer credential
        // and it expires in an hour anyway, so it has no business outliving
        // the tab.
        sessionStorage.setItem('gv.googleToken', res.credential);
        applyToken(res.credential);
      },
    });
    if (containerRef.current && !user) {
      window.google.accounts.id.renderButton(containerRef.current, {
        theme: 'filled_black',
        size: 'medium',
        text: 'signin_with',
        shape: 'rectangular',
      });
    }
  }, [ready, user, applyToken]);

  const signOut = useCallback(() => {
    sessionStorage.removeItem('gv.googleToken');
    window.google?.accounts?.id?.disableAutoSelect?.();
    applyToken(null);
  }, [applyToken]);

  const mount = useCallback((el: HTMLElement | null) => {
    containerRef.current = el;
  }, []);

  return (
    <Ctx.Provider value={{ user, configured: !!CLIENT_ID, signOut, mount }}>
      {children}
    </Ctx.Provider>
  );
}

/** The button itself, plus who is signed in. */
export function GoogleSignIn() {
  const { user, configured, signOut, mount } = useGoogleAuth();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    mount(ref.current);
  }, [mount]);

  if (!configured) return null;
  if (user) {
    return (
      <div className="flex items-center gap-2 text-sm text-white/80 pointer-events-auto">
        {user.picture ? (
          <img src={user.picture} alt="" className="w-6 h-6 rounded-full" />
        ) : null}
        <span className="hidden sm:inline">{user.name ?? user.email}</span>
        <button onClick={signOut} className="underline opacity-70 hover:opacity-100">
          sign out
        </button>
      </div>
    );
  }
  return <div ref={ref} className="pointer-events-auto" />;
}
