'use client';

/**
 * Docs view (v1.0.1) — in-console documentation reader backed by /api/docs.
 * Renders the markdown documentation system from <project>/docs with the
 * NexTool design system. Two-pane on ≥lg, index → content flow on mobile.
 * Long-form text stays on solid readable surfaces (no heavy glass over text).
 */

import { useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { ApiClientError, getDocPage, getDocsIndex, type DocMetaDTO, type DocPage } from '@/lib/nexool/client';
import { APP_VERSION } from '@/lib/nexool/version';
import { EmptyState, ErrorCard, SectionTitle, TechLabel } from '../ui-bits';
import { ArrowLeft, BookOpen, FileText, Search } from 'lucide-react';

function groupByCategory(docs: DocMetaDTO[]): [string, DocMetaDTO[]][] {
  const map = new Map<string, DocMetaDTO[]>();
  for (const d of docs) {
    const arr = map.get(d.category) ?? [];
    arr.push(d);
    map.set(d.category, arr);
  }
  return Array.from(map.entries());
}

function MarkdownProse({ content }: { content: string }) {
  return (
    <div className="nextool-docs">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: (p) => <h1 className="mb-4 mt-8 border-b border-white/[0.08] pb-2 text-2xl font-semibold text-foreground first:mt-0" {...p} />,
          h2: (p) => <h2 className="mb-3 mt-8 text-lg font-semibold text-sky-200" {...p} />,
          h3: (p) => <h3 className="mb-2 mt-6 text-sm font-semibold uppercase tracking-wide text-sky-300/90" {...p} />,
          p: (p) => <p className="my-3 text-sm leading-relaxed text-foreground/85" {...p} />,
          a: (p) => <a className="text-sky-300 underline decoration-sky-400/40 underline-offset-2 hover:text-sky-200" target="_blank" rel="noreferrer" {...p} />,
          ul: (p) => <ul className="my-3 list-disc space-y-1.5 pl-5 text-sm text-foreground/85" {...p} />,
          ol: (p) => <ol className="my-3 list-decimal space-y-1.5 pl-5 text-sm text-foreground/85" {...p} />,
          li: (p) => <li className="leading-relaxed" {...p} />,
          strong: (p) => <strong className="font-semibold text-foreground" {...p} />,
          blockquote: (p) => <blockquote className="my-3 border-l-2 border-sky-400/40 bg-sky-400/[0.05] py-1 pl-3 text-sm text-sky-100/80" {...p} />,
          hr: () => <hr className="my-6 border-white/[0.08]" />,
          code: ({ className, children, ...props }) => {
            const isBlock = /language-/.test(className ?? '');
            if (isBlock) {
              return (
                <code className={cn('nextool-scroll glass-inset block overflow-x-auto rounded-md p-3 font-mono text-xs leading-relaxed text-sky-100/85', className)} {...props}>
                  {children}
                </code>
              );
            }
            return (
              <code className="rounded bg-white/[0.08] px-1.5 py-0.5 font-mono text-[0.8em] text-sky-200" {...props}>
                {children}
              </code>
            );
          },
          pre: (p) => <pre className="my-3" {...p} />,
          table: (p) => (
            <div className="nextool-scroll my-4 overflow-x-auto rounded-md border border-white/[0.08]">
              <table className="w-full text-left text-xs" {...p} />
            </div>
          ),
          th: (p) => <th className="border-b border-white/[0.1] bg-white/[0.04] px-3 py-2 font-medium text-sky-200" {...p} />,
          td: (p) => <td className="border-b border-white/[0.05] px-3 py-2 align-top text-foreground/85" {...p} />,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

export default function DocsView() {
  const [index, setIndex] = useState<DocMetaDTO[] | null>(null);
  const [indexError, setIndexError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [slug, setSlug] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<{ slug: string; page: DocPage | null; error: string | null } | null>(null);

  useEffect(() => {
    let alive = true;
    getDocsIndex()
      .then((d) => alive && setIndex(d.docs))
      .catch((e) => alive && setIndexError(e instanceof ApiClientError ? e.message : 'Documentation unavailable'));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!slug) return;
    let alive = true;
    getDocPage(slug)
      .then((d) => alive && setLoaded({ slug, page: d, error: null }))
      .catch((e) => alive && setLoaded({ slug, page: null, error: e instanceof ApiClientError ? e.message : 'Failed to load page' }));
    return () => {
      alive = false;
    };
  }, [slug]);

  // Derived loading state — no sync setState needed inside effects.
  const pageLoading = slug !== null && loaded?.slug !== slug;
  const page = loaded?.slug === slug ? loaded.page : null;
  const pageError = loaded?.slug === slug ? loaded.error : null;

  const groups = useMemo(() => {
    const docs = (index ?? []).filter(
      (d) => !query || d.title.toLowerCase().includes(query.toLowerCase()) || d.excerpt.toLowerCase().includes(query.toLowerCase()),
    );
    return groupByCategory(docs);
  }, [index, query]);

  const selected = index?.find((d) => d.slug === slug);

  return (
    <div className="space-y-4">
      <SectionTitle
        icon={<BookOpen className="size-4 text-sky-300" aria-hidden />}
        title="Documentation"
        desc={`Project documentation system — v${APP_VERSION}. Also available as markdown in the repository's /docs directory.`}
        right={<Badge variant="outline" className="font-tech border-sky-400/30 bg-sky-400/[0.07] text-[9px] uppercase tracking-wider text-sky-300">{index ? `${index.length} pages` : '…'}</Badge>}
      />

      {indexError ? (
        <ErrorCard title="Documentation index unavailable" message={indexError} onRetry={() => window.location.reload()} />
      ) : !index ? (
        <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
          <div className="space-y-2">
            {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-9 w-full" />)}
          </div>
          <div className="space-y-3">
            <Skeleton className="h-8 w-1/2" />
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-40 w-full" />
          </div>
        </div>
      ) : index.length === 0 ? (
        <EmptyState
          icon={<BookOpen className="size-6" aria-hidden />}
          title="No documentation pages found"
          hint="The /docs directory is empty. Documentation is delivered with the v1.0.1 release."
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
          {/* Index pane */}
          <div className={cn('glass-panel rounded-lg p-3', slug && 'hidden lg:block')}>
            <div className="relative mb-3">
              <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-slate-400" aria-hidden />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search docs…"
                aria-label="Search documentation"
                className="min-h-9 border-white/[0.09] bg-white/[0.04] pl-8 text-sm"
              />
            </div>
            <div className="nextool-scroll max-h-[60vh] space-y-3 overflow-y-auto pr-1 lg:max-h-[calc(100dvh-16rem)]">
              {groups.map(([category, docs]) => (
                <div key={category}>
                  <TechLabel className="mb-1.5 block">{category}</TechLabel>
                  <div className="space-y-0.5">
                    {docs.map((d) => (
                      <button
                        key={d.slug}
                        type="button"
                        onClick={() => setSlug(d.slug)}
                        aria-current={slug === d.slug ? 'page' : undefined}
                        className={cn(
                          'flex min-h-9 w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] transition-colors outline-ring/50 focus-visible:ring-2',
                          slug === d.slug
                            ? 'bg-primary-gradient-soft font-medium text-sky-100 ring-1 ring-sky-400/25'
                            : 'text-slate-300/90 hover:bg-white/[0.05] hover:text-foreground',
                        )}
                      >
                        <FileText className={cn('size-3.5 shrink-0', slug === d.slug ? 'text-sky-300' : 'text-slate-500')} aria-hidden />
                        <span className="truncate">{d.title}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
              {groups.length === 0 ? <p className="px-1 py-4 text-xs text-muted-foreground">No pages match “{query}”.</p> : null}
            </div>
          </div>

          {/* Content pane */}
          <div className="min-w-0">
            {slug === null ? (
              <div className="glass-panel hidden rounded-lg p-8 lg:block">
                <EmptyState
                  icon={<BookOpen className="size-6" aria-hidden />}
                  title="Select a documentation page"
                  hint="Architecture, runtime, CoreModule, tools, Goal/Live Mode, API reference, model & dataset format, deployment, troubleshooting and more."
                  className="border-0 bg-transparent"
                />
              </div>
            ) : pageLoading ? (
              <div className="glass-panel space-y-3 rounded-lg p-6">
                <Skeleton className="h-7 w-1/2" />
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-32 w-full" />
                <Skeleton className="h-4 w-2/3" />
              </div>
            ) : pageError ? (
              <ErrorCard title="Page unavailable" message={pageError} onRetry={() => setSlug(null)} />
            ) : page ? (
              <div className="glass-panel rounded-lg p-4 sm:p-6">
                <div className="mb-4 flex flex-wrap items-center gap-2">
                  <Button variant="ghost" size="sm" className="min-h-8 px-2 text-xs text-sky-300 lg:hidden" onClick={() => setSlug(null)}>
                    <ArrowLeft className="size-3.5" aria-hidden /> All docs
                  </Button>
                  {selected ? <Badge variant="outline" className="font-mono text-[10px] text-slate-400">{selected.category}</Badge> : null}
                  <span className="ml-auto font-mono text-[10px] text-slate-500">
                    updated {new Date(page.updatedAt).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}
                  </span>
                </div>
                <MarkdownProse content={page.content} />
              </div>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
