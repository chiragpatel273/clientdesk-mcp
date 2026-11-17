import '@fontsource-variable/inter';
import './index.css';
import { QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { isApiError } from './api';
import { App } from './App';

const queryClient: QueryClient = new QueryClient({
  queryCache: new QueryCache({
    // A 401 while signed in means the session ended: re-check /api/me, which swaps in the sign-in screen.
    // Only while signed in: on the sign-in screen 401s are expected (its dev-mode probe of /api/staff gets one in
    // oauth mode), and re-checking there remounts the screen, which probes again: an endless request loop.
    onError: (error, query) => {
      const signedIn = queryClient.getQueryState(['me'])?.status === 'success';
      if (isApiError(error, 401) && query.queryKey[0] !== 'me' && signedIn)
        void queryClient.invalidateQueries({ queryKey: ['me'] });
    },
  }),
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchOnWindowFocus: true,
      // Retry network blips and 5xx, never 4xx: a 401/403/404 will not fix itself.
      retry: (failureCount, error) =>
        failureCount < 2 && !(isApiError(error) && error.status >= 400 && error.status < 500),
    },
  },
});

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
