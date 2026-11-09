import { useQuery } from '@tanstack/react-query';
import { LogIn, ShieldCheck } from 'lucide-react';
import { api } from '../api';
import { Logo, RoleBadge } from '../components/layout';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Skeleton } from '../components/ui/skeleton';
import { useSwitchUser } from '../lib/session';

const LOGIN_URL = '/auth/login?returnTo=/dashboard/';

/**
 * Shown when `/api/me` answers 401. If `/api/staff` answers, the server is in dev auth mode (and the stored dev user
 * is not a staff member), so offer the dev picker; otherwise offer the OAuth sign-in.
 */
export function SignInPage() {
  const staff = useQuery({ queryKey: ['staff'], queryFn: api.staff, retry: false });
  const switchUser = useSwitchUser();

  return (
    <div className="flex min-h-dvh items-center justify-center bg-background px-4 py-12">
      <Card className="w-full max-w-sm">
        <CardHeader className="items-center pt-8 text-center">
          <Logo />
          <CardTitle className="mt-3 text-lg">Sign in to ClientDesk</CardTitle>
          <CardDescription>Northbridge Advisory staff dashboard</CardDescription>
        </CardHeader>
        <CardContent className="pb-8">
          {staff.isPending ? (
            <Skeleton className="h-10 w-full" />
          ) : staff.data ? (
            <div className="flex flex-col gap-2">
              <p className="mb-1 text-center text-xs text-muted-foreground">
                Development sign-in: choose a staff member.
              </p>
              {staff.data.staff.map((s) => (
                <Button
                  key={s.email}
                  variant="outline"
                  className="h-auto justify-between py-2.5"
                  onClick={() => switchUser(s.email)}
                >
                  <span className="text-left">
                    <span className="block font-medium">{s.name}</span>
                    <span className="block text-xs font-normal text-muted-foreground">{s.email}</span>
                  </span>
                  <RoleBadge role={s.role} />
                </Button>
              ))}
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              <Button size="lg" className="w-full" onClick={() => window.location.assign(LOGIN_URL)}>
                <LogIn /> Sign in with your firm account
              </Button>
              <p className="flex items-start gap-2 text-xs text-muted-foreground">
                <ShieldCheck className="mt-px size-3.5 shrink-0" />
                What you can see is decided by your role and client assignments, and every action is logged.
              </p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
