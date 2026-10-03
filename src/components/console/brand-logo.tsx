'use client';

/**
 * NexTool v1.0.4 §1 — product identity uses the REAL NexTool logo.
 *
 * The logo source of truth is the ACTIVE branding/icon package (uploaded via
 * the icons ZIP flow, v1.0.3): layout.tsx already serves favicons from it,
 * and this component mirrors that for in-app branding. The best square PNG
 * (apple-touch-icon 180px / icon-192 / icon-512 …) is picked from the live
 * manifest — never a recreated or unrelated SVG.
 *
 * Fallback (no package): a plain monogram tile on the brand gradient —
 * typography only, deliberately NOT a fake logo.
 *
 * The manifest fetch is cached at module level so navigating between views
 * never refetches, and every BrandLogo instance updates together.
 */

import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import { APP_NAME } from '@/lib/nexool/version';
import type { BrandingManifest } from '@/lib/nexool/types';

interface ActiveBranding {
  packageId: string;
  assets: { file: string; width: number | null; height: number; bytes: number }[];
  favicon?: string | null;
  appleTouch?: string | null;
}

let cacheUrl: string | null | undefined; // undefined = not yet resolved
let cachePromise: Promise<string | null> | null = null;
const listeners = new Set<(url: string | null) => void>();

/** Preferred square PNG sizes for in-app display (best first). */
const PREFERRED = ['apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'icon-32.png', 'icon-16.png'];

function pickLogoAsset(branding: ActiveBranding | null): string | null {
  if (!branding?.packageId || !branding.assets?.length) return null;
  const byName = new Map(branding.assets.map((a) => [a.file, a]));
  for (const name of PREFERRED) {
    const asset = byName.get(name);
    if (asset && (asset.width ?? 0) > 0) return `/icons/${branding.packageId}/${asset.file}`;
  }
  // Any sized PNG as a last resort (never the .ico for in-app display).
  const anyPng = branding.assets.find((a) => a.file.endsWith('.png') && (a.width ?? 0) > 0);
  return anyPng ? `/icons/${branding.packageId}/${anyPng.file}` : null;
}

async function fetchLogoUrl(): Promise<string | null> {
  try {
    const res = await fetch('/api/icons');
    const json = (await res.json().catch(() => null)) as { ok?: boolean; data?: { active?: ActiveBranding | null } } | null;
    if (!res.ok || !json?.ok || !json.data) return null;
    return pickLogoAsset(json.data.active ?? null);
  } catch {
    return null;
  }
}

/** Shared logo URL (null = still loading or no active package). */
export function useBrandLogoUrl(): string | null {
  const [url, setUrl] = useState<string | null>(() => cacheUrl ?? null);

  useEffect(() => {
    if (cacheUrl !== undefined) {
      // Resolved between render and effect (rare race) — defer the update so
      // the effect body never sets state synchronously.
      const id = setTimeout(() => setUrl(cacheUrl ?? null), 0);
      return () => clearTimeout(id);
    }
    listeners.add(setUrl);
    if (!cachePromise) {
      cachePromise = fetchLogoUrl().then((resolved) => {
        cacheUrl = resolved;
        listeners.forEach((fn) => fn(resolved));
        listeners.clear();
        return resolved;
      });
    }
    return () => {
      listeners.delete(setUrl);
    };
  }, []);

  return url;
}

/**
 * The NexTool product logo. Sizes: the tile is `size-7` by default; the img
 * fills it with rounded corners. Alt text carries the product name.
 */
export function BrandLogo({ className }: { className?: string }) {
  const url = useBrandLogoUrl();

  if (url) {
    return (
      <span className={cn('flex size-7 items-center justify-center overflow-hidden rounded-md bg-primary-gradient glow-blue', className)}>
        <img
          src={url}
          alt={`${APP_NAME} logo`}
          className="size-full rounded-md object-cover"
          draggable={false}
        />
      </span>
    );
  }

  // Loading or no active package — neutral monogram on the brand gradient.
  return (
    <span
      aria-label={`${APP_NAME} logo`}
      role="img"
      className={cn(
        'flex size-7 items-center justify-center rounded-md bg-primary-gradient glow-blue font-tech text-xs font-bold text-white',
        className,
      )}
    >
      N
    </span>
  );
}
