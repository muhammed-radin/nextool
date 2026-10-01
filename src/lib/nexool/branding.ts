/**
 * NexTool v1.0.2 — branding/icon package service.
 *
 * Accepts an uploaded ZIP (icons.zip) containing favicon.ico + sized PNG icons.
 * Validation is REAL (no blind extraction):
 *  - zip structure is parsed with fflate
 *  - only *.ico / *.png entries with safe names are accepted
 *  - PNG entries must carry a valid IHDR header; dimensions are parsed from it
 *  - every accepted file is size-capped; total budget enforced
 *  - expected filenames (favicon.ico, icon-<size>.png, apple-touch-icon.png)
 *    are recognized; unknown files are rejected with a reason
 *
 * Staging/activation: the manifest is stored in the Setting table under key
 * "branding.icons" with status staged|active. Only "active" packages are read
 * by generateMetadata (layout.tsx) — files live in public/icons/<packageId>/.
 */
import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { db } from '@/lib/db';
import { unzipSync } from 'fflate';
import type { BrandingManifest, IconAsset } from './types';

const BRAND_KEY = 'branding.icons';
const ICONS_ROOT = path.join(process.cwd(), 'public', 'icons');
const MAX_FILE_BYTES = 2 * 1024 * 1024; // 2 MiB per icon file
const MAX_TOTAL_BYTES = 8 * 1024 * 1024; // 8 MiB per package
const MAX_ENTRIES = 40;

/** PNG dimension parser — IHDR big-endian width/height at bytes 16..24. */
export function pngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 33 || !sig.every((b, i) => bytes[i] === b)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (width === 0 || height === 0 || width > 16384 || height > 16384) return null;
  return { width, height };
}

function fileNameIsSafe(name: string): boolean {
  return /^[\w.-]+$/.test(name) && !name.includes('..');
}

export interface IconUploadResult {
  packageId: string;
  manifest: BrandingManifest;
  accepted: IconAsset[];
  rejected: { file: string; reason: string }[];
}

/**
 * Validate + stage an uploaded icons zip. Throws Error with a readable message
 * when the zip is unusable. Files are written under public/icons/<packageId>/
 * and the manifest is stored as status:"staged" (activation is explicit).
 */
export async function stageIconPackage(zipBytes: Uint8Array): Promise<IconUploadResult> {
  if (zipBytes.byteLength > MAX_TOTAL_BYTES) {
    throw new Error(`Package exceeds the ${MAX_TOTAL_BYTES / 1024 / 1024} MiB total size limit.`);
  }
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(zipBytes);
  } catch {
    throw new Error('File is not a valid ZIP archive.');
  }

  const rawNames = Object.keys(entries).filter((n) => !n.endsWith('/'));
  if (rawNames.length === 0) throw new Error('ZIP archive is empty.');
  if (rawNames.length > MAX_ENTRIES) throw new Error(`ZIP contains too many files (max ${MAX_ENTRIES}).`);

  const packageId = `icons-${Date.now().toString(36)}`;
  const accepted: IconAsset[] = [];
  const rejected: { file: string; reason: string }[] = [];
  let totalBytes = 0;

  const expectedIconSizes = [16, 32, 48, 72, 96, 128, 144, 152, 192, 384, 512];

  for (const [entryName, bytes] of Object.entries(entries)) {
    const baseName = entryName.split('/').pop() ?? entryName;
    if (!fileNameIsSafe(baseName)) {
      rejected.push({ file: entryName, reason: 'Unsafe file name (only letters, digits, dot, dash, underscore allowed).' });
      continue;
    }
    const lower = baseName.toLowerCase();
    const isPng = lower.endsWith('.png');
    const isIco = lower.endsWith('.ico');
    if (!isPng && !isIco) {
      rejected.push({ file: entryName, reason: 'Only .png and .ico files are supported.' });
      continue;
    }
    if (bytes.byteLength > MAX_FILE_BYTES) {
      rejected.push({ file: entryName, reason: `File exceeds ${MAX_FILE_BYTES / 1024} KiB per-file limit.` });
      continue;
    }
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_TOTAL_BYTES) {
      rejected.push({ file: entryName, reason: 'Package total size budget exhausted.' });
      continue;
    }

    let dims: { width: number; height: number } | null = null;
    if (isPng) {
      dims = pngDimensions(bytes);
      if (!dims) {
        rejected.push({ file: entryName, reason: 'Not a valid PNG (missing/corrupt IHDR header).' });
        continue;
      }
      // Recognized naming: icon-<size>.png or apple-touch-icon.png
      const sizeMatch = /^icon-(\d{2,3})\.png$/i.exec(lower);
      if (sizeMatch) {
        const declared = Number(sizeMatch[1]);
        if (dims.width !== declared || dims.height !== declared) {
          rejected.push({ file: entryName, reason: `icon-${declared}.png must be exactly ${declared}x${declared}px (found ${dims.width}x${dims.height}).` });
          continue;
        }
        if (!expectedIconSizes.includes(declared)) {
          rejected.push({ file: entryName, reason: `Unexpected icon size ${declared}px — allowed: ${expectedIconSizes.join(', ')}.` });
          continue;
        }
      } else if (lower !== 'apple-touch-icon.png') {
        rejected.push({ file: entryName, reason: 'PNG must be named icon-<size>.png (e.g. icon-192.png) or apple-touch-icon.png.' });
        continue;
      }
    }

    accepted.push({ file: baseName, width: dims?.width ?? null, height: dims?.height ?? null, bytes: bytes.byteLength });
  }

  const hasFavicon = accepted.some((a) => a.file.toLowerCase() === 'favicon.ico');
  if (!hasFavicon) {
    throw new Error(
      rejected.length > 0
        ? `Package rejected: favicon.ico is required. Issues: ${rejected.slice(0, 3).map((r) => `${r.file} — ${r.reason}`).join(' ')}`
        : 'Package rejected: favicon.ico is required in the ZIP root.',
    );
  }
  if (accepted.length === 1) {
    throw new Error('Package rejected: provide at least one sized PNG icon besides favicon.ico (e.g. icon-192.png).');
  }

  // Persist files under public/icons/<packageId>/
  const dir = path.join(ICONS_ROOT, packageId);
  await mkdir(dir, { recursive: true });
  for (const asset of accepted) {
    const entry = Object.entries(entries).find(([n]) => (n.split('/').pop() ?? n) === asset.file);
    if (entry) await writeFile(path.join(dir, asset.file), entry[1]);
  }

  const manifest: BrandingManifest = {
    status: 'staged',
    uploadedAt: new Date().toISOString(),
    activatedAt: null,
    assets: accepted,
    favicon: 'favicon.ico',
    appleTouch: accepted.find((a) => a.file.toLowerCase() === 'apple-touch-icon.png')?.file ?? null,
    p512: accepted.find((a) => a.file === 'icon-512.png')?.file ?? null,
    p192: accepted.find((a) => a.file === 'icon-192.png')?.file ?? null,
  };

  await db.setting.upsert({
    where: { key: BRAND_KEY },
    update: { value: JSON.stringify({ ...manifest, packageId }) },
    create: { key: BRAND_KEY, value: JSON.stringify({ ...manifest, packageId }) },
  });

  return { packageId, manifest, accepted, rejected };
}

/** Activate the staged package (used by generateMetadata). */
export async function activateIconPackage(packageId: string): Promise<BrandingManifest | null> {
  const row = await db.setting.findUnique({ where: { key: BRAND_KEY } });
  if (!row) return null;
  const stored = JSON.parse(row.value) as BrandingManifest & { packageId: string };
  if (stored.packageId !== packageId) throw new Error('Staged package mismatch — upload again before applying.');
  const activated: BrandingManifest & { packageId: string } = {
    ...stored,
    status: 'active',
    activatedAt: new Date().toISOString(),
  };
  await db.setting.update({ where: { key: BRAND_KEY }, data: { value: JSON.stringify(activated) } });
  return activated;
}

/** Read the ACTIVE branding manifest (null when none). Used by layout metadata. */
export async function getActiveBranding(): Promise<(BrandingManifest & { packageId: string }) | null> {
  try {
    const row = await db.setting.findUnique({ where: { key: BRAND_KEY } });
    if (!row) return null;
    const parsed = JSON.parse(row.value) as BrandingManifest & { packageId: string };
    return parsed.status === 'active' ? parsed : null;
  } catch {
    return null;
  }
}

/** Public URL prefix for a package's files. */
export function iconUrl(packageId: string, file: string): string {
  return `/icons/${packageId}/${file}`;
}

/** Remove a staged (not active) package from disk + DB. */
export async function discardIconPackage(): Promise<boolean> {
  const row = await db.setting.findUnique({ where: { key: BRAND_KEY } });
  if (!row) return false;
  const stored = JSON.parse(row.value) as BrandingManifest & { packageId: string };
  if (stored.status === 'active') return false;
  await rm(path.join(ICONS_ROOT, stored.packageId), { recursive: true, force: true });
  await db.setting.delete({ where: { key: BRAND_KEY } }).catch(() => undefined);
  return true;
}
