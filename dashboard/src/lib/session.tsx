import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react';
import { api, isApiError, resetDevUser, setDevUser, setKnownAuthMode, type Me } from '../api';

interface Session {
  me: Me;
  isPartner: boolean;
  /** Dev auth mode only: act as another staff member. Drops every cached response so nothing leaks across users. */
  switchUser: (email: string) => void;
}

const SessionContext = createContext<Session | null>(null);

export function useMeQuery() {
  return useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      let me: Me;
      try {
        me = await api.me();
      } catch (error) {
        // In dev mode a stored email the server doesn't know gives a 401: fall back to the default user once.
        if (!isApiError(error, 401) || !resetDevUser()) throw error;
        me = await api.me();
      }
      setKnownAuthMode(me.authMode);
      return me;
    },
    retry: false,
    staleTime: 5 * 60_000,
  });
}

export function useSwitchUser() {
  const queryClient = useQueryClient();
  return useCallback(
    (email: string) => {
      setDevUser(email);
      setKnownAuthMode(null);
      // Reset (not just invalidate): every cached response belonged to the previous user.
      void queryClient.resetQueries();
    },
    [queryClient],
  );
}

export function SessionProvider({ me, children }: { me: Me; children: ReactNode }) {
  const switchUser = useSwitchUser();
  const value = useMemo(() => ({ me, isPartner: me.role === 'partner', switchUser }), [me, switchUser]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): Session {
  const s = useContext(SessionContext);
  if (!s) throw new Error('useSession must be used inside <SessionProvider>');
  return s;
}
