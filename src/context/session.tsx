"use client";

import * as React from "react";
import {
  login as apiLogin,
  logout as apiLogout,
  register as apiRegister,
  heartbeat as apiHeartbeat,
  type User,
} from "@/lib/api";

const STORAGE_KEY = "talk2.token";

interface Session {
  token: string | null;
  user: User | null;
  ready: boolean;
  login: (username: string, password: string) => Promise<void>;
  register: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const SessionContext = React.createContext<Session | null>(null);

function decodeUser(token: string): User | null {
  try {
    const [, payload] = token.split(".");
    const claims = JSON.parse(atob(payload));
    if (typeof claims.uid === "number" && typeof claims.un === "string") {
      return { id: claims.uid, username: claims.un, created_at: "" };
    }
  } catch {
    // fall through
  }
  return null;
}

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [token, setToken] = React.useState<string | null>(null);
  const [user, setUser] = React.useState<User | null>(null);
  const [ready, setReady] = React.useState(false);

  React.useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      setToken(saved);
      setUser(decodeUser(saved));
    }
    setReady(true);
  }, []);

  // Presence belongs to the logged-in app session, not an individual view.
  // Talk and Rooms mount/unmount their own sockets while navigating, so keep
  // the same heartbeat that the stream relies on independently of those views.
  React.useEffect(() => {
    if (!token) return;
    const sendHeartbeat = () => {
      apiHeartbeat(token).catch(() => {});
    };
    sendHeartbeat();
    const timer = setInterval(sendHeartbeat, 20_000);
    return () => clearInterval(timer);
  }, [token]);

  const login = React.useCallback(async (username: string, password: string) => {
    const res = await apiLogin(username.trim(), password);
    localStorage.setItem(STORAGE_KEY, res.token);
    setToken(res.token);
    setUser(res.user);
  }, []);

  const register = React.useCallback(
    async (username: string, password: string) => {
      const res = await apiRegister(username.trim(), password);
      localStorage.setItem(STORAGE_KEY, res.token);
      setToken(res.token);
      setUser(res.user);
    },
    [],
  );

  const logout = React.useCallback(async () => {
    if (token) {
      try {
        await apiLogout(token);
      } catch {
        // Token already dead or server away: local state still clears.
      }
    }
    localStorage.removeItem(STORAGE_KEY);
    setToken(null);
    setUser(null);
  }, [token]);

  const value = React.useMemo(
    () => ({ token, user, ready, login, register, logout }),
    [token, user, ready, login, register, logout],
  );
  return (
    <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
  );
}

export function useSession(): Session {
  const ctx = React.useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used inside SessionProvider");
  return ctx;
}
