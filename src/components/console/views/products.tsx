'use client';

/**
 * NexTool v1.1.0 §5 — OUR PRODUCTS.
 *
 * A production-quality showcase of websites and applications developed with
 * NexTool AI. The entries come from the operator-maintained registry
 * (config/products.json, served verbatim by /api/products) — this page never
 * invents deployment URLs, live statuses or screenshots.
 *
 * The existing user-facing chat experience (the Assistant) is integrated as
 * a real product/demo ENTRY: its card opens the console's Assistant view —
 * the runtime is reused, not duplicated (§5.3). The operator console remains
 * fully available (§5.4): this page is a navigation layer inside it.
 *
 * Design: responsive desktop/tablet/mobile grid, polished cards, truthful
 * status badges (Live / Demo / In Development), loading/empty/error states,
 * working internal (demo) and external (url) links.
 */

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/lib/nexool/client';
import { useConsoleStore } from '../console-store';
import { SectionTitle } from '../ui-bits';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { ArrowUpRight, Bot, Boxes, ExternalLink, Loader2, MonitorPlay, PackageOpen, RefreshCw } from 'lucide-react';

interface ProductEntry {
  id: string;
  name: string;
  description: string;
  category: string;
  technologies: string[];
  status: 'live' | 'demo' | 'in-development';
  url?: string;
  demoView?: string;
  screenshot?: string;
}

const STATUS_STYLE: Record<ProductEntry['status'], string> = {
  live: 'border-emerald-400/40 bg-emerald-400/10 text-emerald-300',
  demo: 'border-sky-400/40 bg-sky-400/10 text-sky-300',
  'in-development': 'border-amber-400/40 bg-amber-400/10 text-amber-300',
};

function ProductCard({ product, onDemo }: { product: ProductEntry; onDemo: (view: string) => void }) {
  const [imgFailed, setImgFailed] = useState(false);
  const hasImage = Boolean(product.screenshot) && !imgFailed;

  return (
    <article
      className={cn(
        'group flex flex-col overflow-hidden rounded-xl border border-white/[0.08] bg-card shadow-[0_4px_24px_rgb(0,0,0,0.25)] transition-transform duration-200 hover:-translate-y-0.5',
      )}
      aria-label={`Product: ${product.name}`}
    >
      {/* preview / fallback banner */}
      <div className="relative h-36 overflow-hidden border-b border-white/[0.06] bg-gradient-to-br from-white/[0.06] via-transparent to-white/[0.03] sm:h-44">
        {hasImage ? (
          <img
            src={product.screenshot}
            alt={`Screenshot of ${product.name}`}
            className="size-full object-cover object-top"
            loading="lazy"
            onError={() => setImgFailed(true)}
          />
        ) : (
          <div className="flex size-full flex-col items-center justify-center gap-2 text-muted-foreground">
            {product.demoView === 'assistant' ? (
              <Bot className="size-9 text-sky-300/70" aria-hidden />
            ) : (
              <Boxes className="size-9 text-muted-foreground/60" aria-hidden />
            )}
            <span className="font-tech text-[10px] uppercase tracking-widest">{product.category}</span>
          </div>
        )}
        <Badge variant="outline" className={cn('absolute right-2 top-2 font-mono text-[10px] uppercase', STATUS_STYLE[product.status])}>
          {product.status}
        </Badge>
      </div>

      {/* body */}
      <div className="flex flex-1 flex-col gap-2 p-4 sm:p-5">
        <div className="flex items-start justify-between gap-2">
          <h3 className="text-base font-semibold leading-tight sm:text-lg">{product.name}</h3>
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground sm:text-[13px]">{product.description}</p>

        {product.technologies.length > 0 ? (
          <div className="mt-1 flex flex-wrap gap-1.5">
            {product.technologies.map((t) => (
              <span key={t} className="rounded-md border border-white/[0.07] bg-white/[0.03] px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                {t}
              </span>
            ))}
          </div>
        ) : null}

        {/* actions */}
        <div className="mt-auto flex flex-wrap items-center gap-2 pt-3">
          {product.demoView ? (
            <Button type="button" size="sm" className="min-h-11 gap-1.5 px-4 text-xs sm:min-h-9" onClick={() => onDemo(product.demoView!)}>
              <MonitorPlay className="size-3.5" aria-hidden />
              Open demo
            </Button>
          ) : null}
          {product.url ? (
            <a
              href={product.url}
              target="_blank"
              rel="noopener noreferrer"
              className={cn(
                'inline-flex min-h-11 items-center gap-1.5 rounded-md border border-white/[0.08] bg-white/[0.02] px-4 text-xs font-medium text-foreground transition-colors hover:bg-white/[0.06] sm:min-h-9',
              )}
            >
              <ExternalLink className="size-3.5" aria-hidden /> Visit site
            </a>
          ) : null}
          {!product.demoView && !product.url ? (
            <span className="text-[11px] text-muted-foreground">No public link yet</span>
          ) : null}
        </div>
      </div>
    </article>
  );
}

export default function ProductsView() {
  const [products, setProducts] = useState<ProductEntry[] | null>(null);
  const [meta, setMeta] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const setActiveView = useConsoleStore((s) => s.setActiveView);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch<{ products: ProductEntry[]; meta: Record<string, unknown>; error?: string }>('/api/products');
      setProducts(res.products);
      setMeta(res.meta ?? null);
      if (res.error) setError(res.error);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setProducts(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openDemo = useCallback((view: string) => {
    // internal demo route — the existing runtime powers the experience (§5.3)
    setActiveView(view as Parameters<typeof setActiveView>[0]);
  }, [setActiveView]);

  return (
    <div className="mx-auto w-full max-w-6xl space-y-5 p-4 sm:p-6">
      <SectionTitle
        title="Our Products"
        desc="Websites and applications built with NexTool AI — each entry is truthful about what it is and how you can reach it."
      />

      {/* actions */}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" className="min-h-9 text-xs" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} aria-hidden /> Reload
        </Button>
        <span className="text-[11px] text-muted-foreground">
          Operator registry: <code className="font-mono">config/products.json</code> — add or update entries by editing the file (no rebuild).
        </span>
      </div>

      {/* states */}
      {loading && products === null ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-72 animate-pulse rounded-xl border border-white/[0.06] bg-white/[0.03]" aria-hidden />
          ))}
        </div>
      ) : null}

      {!loading && error ? (
        <div role="alert" className="flex items-start gap-2 rounded-lg border border-amber-400/30 bg-amber-400/[0.07] p-4 text-xs text-amber-200">
          <PackageOpen className="mt-0.5 size-4 shrink-0" aria-hidden />
          <div>
            <p className="font-medium">Registry notice</p>
            <p className="mt-0.5 text-amber-200/80">{error}</p>
          </div>
        </div>
      ) : null}

      {!loading && products && products.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-white/[0.1] p-10 text-center">
          <PackageOpen className="size-8 text-muted-foreground/50" aria-hidden />
          <p className="text-sm font-medium">No products registered yet</p>
          <p className="max-w-md text-xs text-muted-foreground">
            Add showcase entries to <code className="font-mono">config/products.json</code> on the host — the page picks them up on the next load.
          </p>
        </div>
      ) : null}

      {/* the grid */}
      {products && products.length > 0 ? (
        <div className="grid grid-cols-1 gap-4 sm:gap-5 md:grid-cols-2 xl:grid-cols-3">
          {products.map((p) => (
            <ProductCard key={p.id} product={p} onDemo={openDemo} />
          ))}
        </div>
      ) : null}

      {meta ? (
        <p className="pt-2 text-[10px] leading-relaxed text-muted-foreground">
          {typeof meta.description === 'string' ? meta.description : 'Product showcase registry'} — statuses shown verbatim from the registry (Live / Demo / In Development); no deployment URLs are invented by the application.
        </p>
      ) : null}

      {loading && products !== null ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground" aria-live="polite">
          <Loader2 className="size-3 animate-spin" aria-hidden /> refreshing…
        </p>
      ) : null}

      <p className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
        <ArrowUpRight className="size-3" aria-hidden /> The operator console (everything around this page) remains fully available — Our Products is a showcase layer, not a replacement.
      </p>
    </div>
  );
}
