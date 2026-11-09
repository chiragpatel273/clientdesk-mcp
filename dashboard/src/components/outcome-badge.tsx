import { CircleCheck, CircleX, ShieldAlert } from 'lucide-react';
import type { Outcome } from '../api';
import { Badge } from './ui/badge';

const config = {
  ok: { variant: 'ok', icon: CircleCheck, label: 'OK' },
  denied: { variant: 'warn', icon: ShieldAlert, label: 'Denied' },
  error: { variant: 'danger', icon: CircleX, label: 'Error' },
} as const;

export function OutcomeBadge({ outcome }: { outcome: Outcome }) {
  const c = config[outcome] ?? config.error;
  const Icon = c.icon;
  return (
    <Badge variant={c.variant}>
      <Icon aria-hidden />
      {c.label}
    </Badge>
  );
}

export function PassBadge({ pass, labels = ['Pass', 'Miss'] }: { pass: boolean; labels?: [string, string] }) {
  return pass ? (
    <Badge variant="ok">
      <CircleCheck aria-hidden /> {labels[0]}
    </Badge>
  ) : (
    <Badge variant="danger">
      <CircleX aria-hidden /> {labels[1]}
    </Badge>
  );
}
