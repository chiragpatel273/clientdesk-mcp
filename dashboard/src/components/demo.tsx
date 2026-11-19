import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Eye, LogOut, PlayCircle } from 'lucide-react';
import { api } from '../api';
import { Badge } from './ui/badge';
import { Button } from './ui/button';

/** Whether the server offers "Try the demo" (DEMO_LOGIN). Cached for the page's lifetime. */
export function useAuthOptions() {
  return useQuery({ queryKey: ['auth-options'], queryFn: api.authOptions, staleTime: Infinity, retry: false });
}

/** Starts a read-only demo session (a cookie), then reloads every query as the demo visitor. */
export function useStartDemo() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: api.startDemo,
    onSuccess: () => void queryClient.resetQueries(),
  });
}

export function TryDemoButton({ className }: { className?: string }) {
  const start = useStartDemo();
  return (
    <div className={className}>
      <Button variant="outline" size="lg" className="w-full" onClick={() => start.mutate()} disabled={start.isPending}>
        <PlayCircle /> Try the demo
      </Button>
      <p className="mt-2 text-center text-xs text-muted-foreground">
        {start.isError
          ? start.error.message
          : 'No account needed: a read-only, partner-level view of a fictional firm.'}
      </p>
    </div>
  );
}

export function DemoBanner() {
  return (
    <div role="status" className="border-b border-warn/30 bg-warn-soft px-4 py-2 text-center text-sm text-foreground">
      <Eye className="mr-1.5 inline size-4 align-[-3px]" aria-hidden />
      <strong className="font-semibold">Demo mode: read-only, fictional data.</strong>{' '}
      <span className="text-muted-foreground">
        Try anything: the server refuses every change and logs the attempt in the audit log.
      </span>
    </div>
  );
}

export function DemoVisitor() {
  const exit = useMutation({ mutationFn: api.logout, onSuccess: () => window.location.reload() });
  return (
    <div className="flex items-center gap-2">
      <Badge variant="outline">Demo visitor</Badge>
      <Button variant="ghost" size="sm" onClick={() => exit.mutate()} disabled={exit.isPending}>
        <LogOut />
        <span className="hidden sm:inline">Exit demo</span>
      </Button>
    </div>
  );
}
