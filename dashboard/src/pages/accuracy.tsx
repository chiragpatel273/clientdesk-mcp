import { useQuery } from '@tanstack/react-query';
import { Cpu, Database, FlaskConical, Gauge, History, Wrench } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  LabelList,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { api, isApiError, type AccuracyByDocType, type AccuracyReport } from '../api';
import { MetricTile, MetricTileSkeleton } from '../components/metric-tile';
import { PassBadge } from '../components/outcome-badge';
import { PageHeader } from '../components/page-header';
import { EmptyState, ErrorState } from '../components/states';
import { Badge } from '../components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Select } from '../components/ui/select';
import { Skeleton } from '../components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { Tabs } from '../components/ui/tabs';
import { formatDateTime, formatInt, formatPercent, formatRelative, humanize } from '../lib/format';

export function AccuracyPage() {
  const report = useQuery({ queryKey: ['accuracy'], queryFn: api.accuracy, staleTime: 5 * 60_000 });

  return (
    <>
      <PageHeader
        title="Accuracy report"
        description="Measured on synthetic labelled documents and questions. Real numbers, published even when they miss a target."
      />
      {report.isPending ? (
        <AccuracySkeleton />
      ) : report.isError ? (
        <Card>
          {isApiError(report.error, 404) ? (
            <EmptyState icon={Gauge} title="No accuracy report yet">
              Run <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">npm run eval</code> to generate the
              first report.
            </EmptyState>
          ) : (
            <ErrorState error={report.error} onRetry={() => void report.refetch()} />
          )}
        </Card>
      ) : (
        <Report report={report.data} />
      )}
    </>
  );
}

function AccuracySkeleton() {
  return (
    <div className="grid gap-6" aria-busy="true" aria-label="Loading accuracy report">
      <Skeleton className="h-5 w-2/3" />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {Array.from({ length: 5 }, (_, i) => (
          <MetricTileSkeleton key={i} />
        ))}
      </div>
      <Skeleton className="h-72 rounded-xl" />
      <Skeleton className="h-96 rounded-xl" />
    </div>
  );
}

function Report({ report }: { report: AccuracyReport }) {
  const passed = report.metrics.filter((m) => m.pass).length;
  const fieldTarget = report.metrics.find((m) => m.unit === 'percent' && /field/i.test(`${m.key} ${m.label}`))?.target;

  return (
    <div className="grid grid-cols-1 gap-6">
      <dl className="flex min-w-0 flex-wrap gap-x-6 gap-y-2 text-sm">
        <Meta icon={History} label="Generated">
          <time dateTime={report.generatedAt} title={formatDateTime(report.generatedAt)}>
            {formatDateTime(report.generatedAt)} ({formatRelative(report.generatedAt)})
          </time>
        </Meta>
        <Meta icon={Cpu} label="Extractor">
          <code className="font-mono text-[13px]">{report.extractor}</code>
        </Meta>
        <Meta icon={Database} label="Embedder">
          <code className="font-mono text-[13px]">{report.embedder}</code>
        </Meta>
        <Meta icon={FlaskConical} label="Dataset">
          {formatInt(report.dataset.documents)} documents, {formatInt(report.dataset.questions)} questions
        </Meta>
      </dl>

      <section aria-labelledby="metrics-heading">
        <h2 id="metrics-heading" className="mb-3 text-sm font-medium text-muted-foreground">
          {passed} of {report.metrics.length} targets met
        </h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {report.metrics.map((m) => (
            <MetricTile key={m.key} metric={m} />
          ))}
        </div>
      </section>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <CardHeader>
            <CardTitle>Field accuracy by document type</CardTitle>
            <CardDescription>
              Share of extracted fields that match the label
              {fieldTarget !== undefined && <>; the dashed line is the {formatPercent(fieldTarget)} target</>}.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {report.byDocType.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">No per-type results in this report.</p>
            ) : (
              <FieldAccuracyChart data={report.byDocType} target={fieldTarget} />
            )}
          </CardContent>
        </Card>

        <Card className="overflow-hidden lg:col-span-2">
          <CardHeader>
            <CardTitle>By document type</CardTitle>
            <CardDescription>The chart's numbers, plus how often each type went to review.</CardDescription>
          </CardHeader>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Type</TableHead>
                <TableHead className="text-right">Docs</TableHead>
                <TableHead className="text-right">Fields</TableHead>
                <TableHead className="text-right">Review</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {report.byDocType.map((d) => (
                <TableRow key={d.docType}>
                  <TableCell className="font-medium">{humanize(d.docType)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatInt(d.documents)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatPercent(d.fieldAccuracy)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatPercent(d.reviewRate)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      </div>

      <CasesTable cases={report.cases} />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Wrench className="size-4 text-muted-foreground" /> Changes made to improve
          </CardTitle>
          <CardDescription>What was changed after earlier runs, and why the numbers moved.</CardDescription>
        </CardHeader>
        <CardContent>
          {report.changes.length === 0 ? (
            <p className="text-sm text-muted-foreground">No changes recorded yet.</p>
          ) : (
            <ol className="grid list-decimal gap-2 pl-5 text-sm marker:text-muted-foreground">
              {report.changes.map((c, i) => (
                <li key={i} className="pl-1">
                  {c}
                </li>
              ))}
            </ol>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Meta({ icon: Icon, label, children }: { icon: typeof Cpu; label: string; children: ReactNode }) {
  return (
    <div className="flex max-w-full min-w-0 items-center gap-2">
      <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate">{children}</dd>
    </div>
  );
}

interface ChartRow extends AccuracyByDocType {
  label: string;
}

function ChartTooltip({ active, payload }: { active?: boolean; payload?: readonly { payload?: ChartRow }[] }) {
  const row = payload?.[0]?.payload;
  if (!active || !row) return null;
  return (
    <div className="rounded-lg border bg-popover px-3 py-2 text-xs shadow-md">
      <p className="mb-1 font-medium">{row.label}</p>
      <p className="text-muted-foreground">
        Field accuracy{' '}
        <span className="font-medium text-foreground tabular-nums">{formatPercent(row.fieldAccuracy)}</span>
      </p>
      <p className="text-muted-foreground">
        Sent to review <span className="font-medium text-foreground tabular-nums">{formatPercent(row.reviewRate)}</span>
      </p>
      <p className="text-muted-foreground">
        Documents <span className="font-medium text-foreground tabular-nums">{formatInt(row.documents)}</span>
      </p>
    </div>
  );
}

/** One series, so one hue and no legend: the title names it. Bars are anchored at 0 with rounded data ends. */
function FieldAccuracyChart({ data, target }: { data: AccuracyByDocType[]; target: number | undefined }) {
  const rows: ChartRow[] = data.map((d) => ({ ...d, label: humanize(d.docType) }));
  const height = Math.max(160, rows.length * 48 + 40);

  return (
    <div style={{ height }} className="w-full text-xs">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 16, bottom: 4, left: 4 }} barCategoryGap={14}>
          <CartesianGrid horizontal={false} stroke="var(--chart-grid)" />
          <XAxis
            type="number"
            domain={[0, 1]}
            ticks={[0, 0.25, 0.5, 0.75, 1]}
            tickFormatter={(v: number) => formatPercent(v, 0)}
            tick={{ fill: 'var(--muted-foreground)' }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            type="category"
            dataKey="label"
            width={124}
            tick={{ fill: 'var(--foreground)' }}
            axisLine={false}
            tickLine={false}
          />
          <Tooltip content={ChartTooltip} cursor={{ fill: 'var(--muted)', opacity: 0.6 }} />
          {target !== undefined && (
            <ReferenceLine
              x={target}
              stroke="var(--muted-foreground)"
              strokeDasharray="4 4"
              ifOverflow="extendDomain"
            />
          )}
          <Bar
            dataKey="fieldAccuracy"
            name="Field accuracy"
            fill="var(--chart-1)"
            radius={[0, 4, 4, 0]}
            maxBarSize={22}
            isAnimationActive={false}
          >
            <LabelList
              dataKey="fieldAccuracy"
              position="insideRight"
              offset={8}
              formatter={(v: unknown) => (typeof v === 'number' ? formatPercent(v) : '')}
              style={{ fill: '#fff', fontWeight: 600 }}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function CasesTable({ cases }: { cases: AccuracyReport['cases'] }) {
  const [show, setShow] = useState<'all' | 'failures'>('all');
  const [docType, setDocType] = useState('');
  const docTypes = useMemo(() => [...new Set(cases.map((c) => c.docType))].sort(), [cases]);
  const failures = cases.filter((c) => !c.correct).length;

  const visible = cases.filter((c) => (show === 'all' || !c.correct) && (!docType || c.docType === docType));

  return (
    <Card className="overflow-hidden">
      <CardHeader className="gap-3">
        <div className="flex flex-col gap-1">
          <CardTitle>Test cases</CardTitle>
          <CardDescription>
            Every labelled case and what the system did with it. {formatInt(failures)} of {formatInt(cases.length)}{' '}
            {cases.length === 1 ? 'case was' : 'cases were'} wrong.
          </CardDescription>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Tabs
            label="Show cases"
            value={show}
            onChange={setShow}
            options={[
              { value: 'all', label: 'All', count: cases.length },
              { value: 'failures', label: 'Only failures', count: failures },
            ]}
          />
          <Select
            aria-label="Document type"
            className="w-48"
            value={docType}
            onChange={(e) => setDocType(e.target.value)}
          >
            <option value="">All document types</option>
            {docTypes.map((t) => (
              <option key={t} value={t}>
                {humanize(t)}
              </option>
            ))}
          </Select>
        </div>
      </CardHeader>
      {visible.length === 0 ? (
        <EmptyState icon={FlaskConical} title={show === 'failures' ? 'No failures' : 'No cases'} className="py-8">
          {show === 'failures' ? 'Every case in this selection was handled correctly.' : 'Nothing matches this filter.'}
        </EmptyState>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Case</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Hard case</TableHead>
              <TableHead>Expected</TableHead>
              <TableHead>Outcome</TableHead>
              <TableHead>Result</TableHead>
              <TableHead>Field errors</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((c) => (
              <TableRow key={c.id} className={c.correct ? undefined : 'bg-danger-soft/30'}>
                <TableCell className="font-mono text-xs whitespace-nowrap">{c.id}</TableCell>
                <TableCell className="whitespace-nowrap">{humanize(c.docType)}</TableCell>
                <TableCell>
                  {c.hardCase ? (
                    <Badge variant="outline">{humanize(c.hardCase)}</Badge>
                  ) : (
                    <span className="text-muted-foreground">–</span>
                  )}
                </TableCell>
                <TableCell className="min-w-40">{c.expected}</TableCell>
                <TableCell className="min-w-40">{c.outcome}</TableCell>
                <TableCell>
                  <PassBadge pass={c.correct} labels={['Correct', 'Wrong']} />
                </TableCell>
                <TableCell className="min-w-48 text-muted-foreground">
                  {c.fieldErrors.length === 0 ? (
                    '–'
                  ) : (
                    <ul className="grid gap-0.5">
                      {c.fieldErrors.map((e, i) => (
                        <li key={i}>{e}</li>
                      ))}
                    </ul>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Card>
  );
}
