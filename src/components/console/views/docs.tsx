'use client';

/**
 * Docs view (v1.0.1) — in-console documentation reader backed by /api/docs.
 * Renders the markdown documentation system from <project>/docs with the
 * NexTool design system. Two-pane on ≥lg, index → content flow on mobile.
 * Long-form text stays on solid readable surfaces (no heavy glass over text).
 *
 * v1.0.5 §6 — documentation navigation: every markdown link inside a page is
 * classified by the CENTRALIZED resolver (src/lib/nexool/docs-link-resolver.ts):
 *   external (http/mailto) → normal target=_blank anchor (§6.6)
 *   in-page anchor (#foo)  → native scroll — headings carry headingSlug ids
 *   internal doc link      → navigates WITHIN this view (setSlug of the resolved
 *                            target; never a browser route → never a 404, §6.1/6.4);
 *                            unresolvable targets show an in-viewer not-found
 *                            state instead (§6.5).
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { ApiClientError, getDocPage, getDocsIndex, type DocMetaDTO, type DocPage } from '@/lib/nexool/client';
import {
  docLinkAnchor,
  headingSlug,
  isExternalHref,
  isInPageAnchor,
  isInternalDocLink,
  normalizeDocHref,
  resolveDocSlug,
} from '@/lib/nexool/docs-link-resolver';
import { APP_VERSION } from '@/lib/nexool/version';
import { EmptyState, ErrorCard, SectionTitle, TechLabel } from '../ui-bits';
import { AlertTriangle, ArrowLeft, BookOpen, FileText, Search } from 'lucide-react';

/** Plain text of arbitrary React children — powers headingSlug ids for headings. */
function childrenToText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(childrenToText).join('');
  if (typeof node === 'object' && 'props' in node) {
    const props = (node as { props?: { children?: ReactNode } }).props;
    return childrenToText(props?.children);
  }
  return '';
}

const DOC_LINK_CLASS =
  'cursor-pointer text-sky-300 underline decoration-sky-400/40 underline-offset-2 hover:text-sky-200';

function groupByCategory(docs: DocMetaDTO[]): [string, DocMetaDTO[]][] {
  const map = new Map<string, DocMetaDTO[]>();
  for (const d of docs) {
    const arr = map.get(d.category) ?? [];
    arr.push(d);
    map.set(d.category, arr);
  }
  return Array.from(map.entries());
}

function MarkdownProse({
  content,
  availableSlugs,
  onOpenDoc,
  onMissingDoc,
}: {
  content: string;
  availableSlugs: string[];
  /** Navigate to a resolved doc page inside this view, optionally to an anchor. */
  onOpenDoc: (slug: string, anchor: string) => void;
  /** Link target that does not exist in the documentation index (§6.5). */
  onMissingDoc: (requested: string) => void;
}) {
  return (
    <div className="nextool-docs">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: (p) => <h1 id={headingSlug(childrenToText(p.children))} className="mb-4 mt-8 border-b border-white/[0.08] pb-2 text-2xl font-semibold text-foreground first:mt-0" {...p} />,
          h2: (p) => <h2 id={headingSlug(childrenToText(p.children))} className="mb-3 mt-8 text-lg font-semibold text-sky-200" {...p} />,
          h3: (p) => <h3 id={headingSlug(childrenToText(p.children))} className="mb-2 mt-6 text-sm font-semibold uppercase tracking-wide text-sky-300/90" {...p} />,
          h4: (p) => <h4 id={headingSlug(childrenToText(p.children))} className="mb-2 mt-6 text-sm font-semibold text-foreground/90" {...p} />,
          p: (p) => <p className="my-3 text-sm leading-relaxed text-foreground/85 [overflow-wrap:anywhere]" {...p} />,
          a: ({ href, node: _node, children, ...rest }) => {
            const target = href ?? '';
            // §6.6 — http(s)/mailto/tel keep normal external behavior.
            if (isExternalHref(target)) {
              return <a className={DOC_LINK_CLASS} target="_blank" rel="noreferrer" {...rest}>{children}</a>;
            }
            // §6.6 — in-page anchors scroll within the current page (headings have ids).
            if (isInPageAnchor(target)) {
              return <a className={DOC_LINK_CLASS} href={target} {...rest}>{children}</a>;
            }
            // §6.1/6.2/6.4 — internal doc links resolve via the centralized resolver
            // and navigate INSIDE the Docs view; they never hit an app route (404).
            if (isInternalDocLink(target)) {
              return (
                <button
                  type="button"
                  className={cn('text-left', DOC_LINK_CLASS)}
                  onClick={() => {
                    const resolved = resolveDocSlug(target, availableSlugs);
                    if (resolved) onOpenDoc(resolved, docLinkAnchor(target));
                    else onMissingDoc(normalizeDocHref(target));
                  }}
                >
                  {children}
                </button>
              );
            }
            return <a className={DOC_LINK_CLASS} {...rest}>{children}</a>;
          },
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
              <code className="rounded bg-white/[0.08] px-1.5 py-0.5 font-mono text-[0.8em] text-sky-200 [overflow-wrap:anywhere] whitespace-normal" {...props}>
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
  // §6.5 — in-viewer not-found state for internal links that resolve to nothing.
  const [notFound, setNotFound] = useState<{ requested: string } | null>(null);
  // Anchor part of a cross-page doc link, scrolled to once the target page rendered.
  const [pendingAnchor, setPendingAnchor] = useState<string | null>(null);

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

  /**
   * §6.4 — single navigation entry point for the whole view (index clicks and
   * resolved internal doc links). Clears transient states, then loads the page
   * INSIDE this view — the browser never navigates to an app route. Plain
   * navigation scrolls the content pane back to the top; anchor navigations let
   * the heading scroll below take over positioning instead.
   */
  const openDoc = (nextSlug: string, anchor = '') => {
    setNotFound(null);
    setPendingAnchor(anchor || null);
    setSlug(nextSlug);
    if (!anchor) window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const availableSlugs = useMemo(() => (index ?? []).map((d) => d.slug), [index]);

  const groups = useMemo(() => {
    const docs = (index ?? []).filter(
      (d) => !query || d.title.toLowerCase().includes(query.toLowerCase()) || d.excerpt.toLowerCase().includes(query.toLowerCase()),
    );
    return groupByCategory(docs);
  }, [index, query]);

  const selected = index?.find((d) => d.slug === slug);

  // §6.4 — after a link navigated to `<slug>#<anchor>`, scroll to the heading
  // once the target page has rendered. headingSlug is used on BOTH sides
  // (heading ids + lookup), with a dashed-candidate fallback for GitHub-style
  // double-dash anchors that cannot be matched 1:1.
  useEffect(() => {
    if (!pendingAnchor || pageLoading || !page) return;
    const anchor = pendingAnchor.trim();
    const candidates = [headingSlug(anchor), anchor.replace(/-+/g, '-'), anchor];
    const timer = window.setTimeout(() => {
      for (const id of candidates) {
        const el = document.getElementById(id);
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'start' });
          break;
        }
      }
      setPendingAnchor(null);
    }, 80);
    return () => window.clearTimeout(timer);
  }, [pendingAnchor, pageLoading, page]);

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
                        onClick={() => openDoc(d.slug)}
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
            {notFound ? (
              // §6.5 — in-viewer error state (never a generic Next.js 404).
              <div className="flex flex-col items-start gap-3 rounded-lg border border-rose-400/30 bg-rose-400/5 p-4">
                <div className="flex items-center gap-2 text-sm font-medium text-rose-300">
                  <AlertTriangle className="size-4 shrink-0" aria-hidden /> Documentation page not found.
                </div>
                <p className="font-mono text-xs break-all text-rose-200/80">Requested: {notFound.requested}</p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setNotFound(null);
                    setPendingAnchor(null);
                    setSlug(null);
                  }}
                  className="min-h-9 border-rose-400/30 text-rose-200 hover:bg-rose-400/10"
                >
                  <ArrowLeft className="size-3.5" aria-hidden /> Return to Documentation
                </Button>
              </div>
            ) : slug === null ? (
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
                <MarkdownProse
                  content={page.content}
                  availableSlugs={availableSlugs}
                  onOpenDoc={openDoc}
                  onMissingDoc={(requested) => setNotFound({ requested })}
                />
              </div>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
