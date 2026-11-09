import { lazy, Suspense } from 'react';
import { createBrowserRouter, Link, RouterProvider } from 'react-router';
import { isApiError } from './api';
import { Layout, Logo } from './components/layout';
import { ErrorState } from './components/states';
import { Skeleton } from './components/ui/skeleton';
import { buttonVariants } from './components/ui/button';
import { SessionProvider, useMeQuery } from './lib/session';
import { AuditPage } from './pages/audit';
import { InboxPage } from './pages/inbox';
import { OverviewPage } from './pages/overview';
import { ReviewPage } from './pages/review';
import { SignInPage } from './pages/sign-in';

// Recharts is the largest dependency and only this page uses it, so it loads on demand.
const AccuracyPage = lazy(() => import('./pages/accuracy').then((m) => ({ default: m.AccuracyPage })));

function PageFallback() {
  return (
    <div className="grid gap-4" aria-busy="true" aria-label="Loading">
      <Skeleton className="h-7 w-48" />
      <Skeleton className="h-64 rounded-xl" />
    </div>
  );
}

function NotFound() {
  return (
    <div className="py-16 text-center">
      <p className="text-sm font-medium">Page not found</p>
      <Link to="/" className={buttonVariants({ variant: 'link' })}>
        Back to the overview
      </Link>
    </div>
  );
}

const router = createBrowserRouter(
  [
    {
      element: <Layout />,
      children: [
        { index: true, element: <OverviewPage /> },
        { path: 'audit', element: <AuditPage /> },
        { path: 'review', element: <ReviewPage /> },
        { path: 'inbox', element: <InboxPage /> },
        {
          path: 'accuracy',
          element: (
            <Suspense fallback={<PageFallback />}>
              <AccuracyPage />
            </Suspense>
          ),
        },
        { path: '*', element: <NotFound /> },
      ],
    },
  ],
  { basename: '/dashboard' },
);

function BootSkeleton() {
  return (
    <div className="min-h-dvh" aria-busy="true" aria-label="Loading">
      <div className="flex h-14 items-center gap-3 border-b px-4 sm:px-6">
        <Logo />
        <Skeleton className="h-4 w-24" />
        <Skeleton className="ml-auto h-8 w-40" />
      </div>
      <div className="mx-auto grid max-w-7xl gap-4 px-4 py-8 sm:grid-cols-2 sm:px-6 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-28 rounded-xl" />
        ))}
      </div>
    </div>
  );
}

export function App() {
  const me = useMeQuery();

  // A 401 always means "signed out", even if an earlier response is still cached.
  if (me.isError && isApiError(me.error, 401)) return <SignInPage />;
  if (!me.data) {
    if (me.isPending) return <BootSkeleton />;
    const forbidden = isApiError(me.error, 403);
    return (
      <div className="flex min-h-dvh items-center justify-center px-4">
        <ErrorState
          title={forbidden ? 'Your account is not linked to a staff member' : 'Could not load the dashboard'}
          error={me.error}
          onRetry={() => void me.refetch()}
        />
      </div>
    );
  }

  return (
    <SessionProvider me={me.data}>
      <RouterProvider router={router} />
    </SessionProvider>
  );
}
