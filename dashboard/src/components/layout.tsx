import { useMutation, useQuery } from '@tanstack/react-query';
import {
  FileCheck2,
  Gauge,
  Inbox,
  LayoutDashboard,
  LogOut,
  Monitor,
  Moon,
  ScrollText,
  Sun,
  type LucideIcon,
} from 'lucide-react';
import { NavLink, Outlet } from 'react-router';
import { api, type Role } from '../api';
import { useSession } from '../lib/session';
import { useTheme, type ThemeChoice } from '../lib/theme';
import { cn } from '../lib/utils';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Select } from './ui/select';
import { Tooltip } from './ui/tooltip';

export function RoleBadge({ role }: { role: Role }) {
  return (
    <Badge variant={role === 'partner' ? 'accent' : 'default'}>{role === 'partner' ? 'Partner' : 'Assistant'}</Badge>
  );
}

export function Logo() {
  return (
    <span className="flex size-7 items-center justify-center rounded-lg bg-primary text-[13px] font-bold text-primary-foreground">
      C
    </span>
  );
}

const themeOrder: ThemeChoice[] = ['system', 'light', 'dark'];
const themeIcon: Record<ThemeChoice, LucideIcon> = { system: Monitor, light: Sun, dark: Moon };

export function ThemeToggle() {
  const { choice, set } = useTheme();
  const next = themeOrder[(themeOrder.indexOf(choice) + 1) % themeOrder.length] ?? 'system';
  const Icon = themeIcon[choice];
  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={() => set(next)}
      aria-label={`Theme: ${choice}. Switch to ${next}.`}
      title={`Theme: ${choice}`}
    >
      <Icon />
    </Button>
  );
}

function DevUserSwitcher() {
  const { me, switchUser } = useSession();
  const staff = useQuery({ queryKey: ['staff'], queryFn: api.staff, staleTime: Infinity, retry: false });
  const list = staff.data?.staff ?? [{ email: me.email, name: me.name, role: me.role }];

  return (
    <div className="flex items-center gap-2">
      <Tooltip content="Development sign-in: choose who you are. In production staff sign in with OAuth.">
        <Badge variant="outline" className="hidden sm:inline-flex">
          Dev auth
        </Badge>
      </Tooltip>
      <label className="sr-only" htmlFor="dev-user">
        Signed in as
      </label>
      <Select
        id="dev-user"
        className="w-40 sm:w-56"
        value={me.email}
        onChange={(e) => switchUser(e.target.value)}
        disabled={staff.isPending}
      >
        {list.map((s) => (
          <option key={s.email} value={s.email}>
            {s.name} · {s.role === 'partner' ? 'Partner' : 'Assistant'}
          </option>
        ))}
      </Select>
    </div>
  );
}

function SignedInUser() {
  const { me } = useSession();
  const signOut = useMutation({
    mutationFn: api.logout,
    onSuccess: () => window.location.reload(),
  });
  return (
    <div className="flex items-center gap-2">
      <div className="hidden min-w-0 text-right sm:block">
        <p className="truncate text-sm leading-tight font-medium">{me.name}</p>
        <p className="truncate text-xs text-muted-foreground">{me.email}</p>
      </div>
      <RoleBadge role={me.role} />
      <Button
        variant="ghost"
        size="sm"
        onClick={() => signOut.mutate()}
        disabled={signOut.isPending}
        title={signOut.isError ? `Sign out failed: ${signOut.error.message}` : undefined}
      >
        <LogOut />
        <span className="hidden sm:inline">{signOut.isError ? 'Retry sign out' : 'Sign out'}</span>
      </Button>
    </div>
  );
}

const nav: { to: string; label: string; icon: LucideIcon; end?: boolean; count?: 'review' | 'inbox' }[] = [
  { to: '/', label: 'Overview', icon: LayoutDashboard, end: true },
  { to: '/audit', label: 'Audit log', icon: ScrollText },
  { to: '/review', label: 'Review queue', icon: FileCheck2, count: 'review' },
  { to: '/inbox', label: 'Inbox', icon: Inbox, count: 'inbox' },
  { to: '/accuracy', label: 'Accuracy', icon: Gauge },
];

export function Layout() {
  const { me } = useSession();
  const stats = useQuery({ queryKey: ['stats'], queryFn: api.stats, refetchInterval: 30_000 });

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-40 border-b bg-background/85 backdrop-blur supports-[backdrop-filter]:bg-background/70">
        <div className="mx-auto flex h-14 max-w-7xl items-center justify-between gap-3 px-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-2">
            <Logo />
            <span className="font-semibold tracking-tight">ClientDesk</span>
            <span className="hidden text-muted-foreground/60 sm:inline" aria-hidden>
              /
            </span>
            <span className="hidden truncate text-sm text-muted-foreground sm:inline">Northbridge Advisory</span>
          </div>
          <div className="flex items-center gap-1 sm:gap-2">
            {me.authMode === 'dev' ? <DevUserSwitcher /> : <SignedInUser />}
            <ThemeToggle />
          </div>
        </div>
        <nav aria-label="Main" className="mx-auto max-w-7xl overflow-x-auto px-2 sm:px-4">
          <ul className="flex gap-1">
            {nav.map((item) => {
              const count = item.count ? stats.data?.documents[item.count] : undefined;
              return (
                <li key={item.to}>
                  <NavLink
                    to={item.to}
                    end={item.end}
                    className={({ isActive }) =>
                      cn(
                        'relative flex h-10 items-center gap-2 px-3 text-sm whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground',
                        'after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:rounded-full',
                        isActive && 'font-medium text-foreground after:bg-primary',
                      )
                    }
                  >
                    <item.icon className="size-4" />
                    {item.label}
                    {count !== undefined && count > 0 && (
                      <span className="rounded-full bg-muted px-1.5 text-xs font-medium text-muted-foreground tabular-nums">
                        {count}
                      </span>
                    )}
                  </NavLink>
                </li>
              );
            })}
          </ul>
        </nav>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 sm:py-8">
        <Outlet />
      </main>
      <footer className="mx-auto max-w-7xl px-4 pb-8 text-xs text-muted-foreground sm:px-6">
        Demo data: Northbridge Advisory and everyone in it are fictional.
      </footer>
    </div>
  );
}
