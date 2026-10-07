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
import { mkdir, writeFile, rm, readdir, readFile } from 'node:fs/promises';
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
  /** v1.0.3: well-known non-icon entries that were intentionally skipped (not an error). */
  ignored: { file: string; reason: string }[];
}

/**
 * v1.0.3 — common favicon-generator filenames mapped onto the canonical
 * icon-<size>.png names, so a standard favicon.io / realfavicongenerator ZIP
 * uploads without renaming. The alias is applied AFTER real PNG dimension
 * validation against the canonical size (content must still match).
 */
const NAME_ALIASES: [RegExp, string][] = [
  [/^favicon-16x16\.png$/i, 'icon-16.png'],
  [/^favicon-32x32\.png$/i, 'icon-32.png'],
  [/^android-chrome-192x192\.png$/i, 'icon-192.png'],
  [/^android-chrome-512x512\.png$/i, 'icon-512.png'],
  [/^apple-touch-icon.*\.png$/i, 'apple-touch-icon.png'],
  [/^apple-touch-icon-precomposed\.png$/i, 'apple-touch-icon.png'],
];

/** Well-known non-icon metadata files that are skipped instead of rejected. */
const IGNORED_ENTRIES = new Set(['site.webmanifest', 'manifest.json', 'browserconfig.xml']);

/**
 * v1.0.3 — testable pure helper: map a favicon-generator filename onto its
 * canonical icon name (icon-<size>.png / apple-touch-icon.png). Non-aliased
 * names pass through unchanged.
 */
export function canonicalIconName(baseName: string): string {
  const lower = baseName.toLowerCase();
  for (const [pattern, target] of NAME_ALIASES) {
    if (pattern.test(lower)) return target;
  }
  return baseName;
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
  const ignored: { file: string; reason: string }[] = [];
  let totalBytes = 0;

  const expectedIconSizes = [16, 32, 48, 72, 96, 128, 144, 152, 192, 384, 512];

  for (const [entryName, bytes] of Object.entries(entries)) {
    const baseName = entryName.split('/').pop() ?? entryName;
    if (!fileNameIsSafe(baseName)) {
      rejected.push({ file: entryName, reason: 'Unsafe file name (only letters, digits, dot, dash, underscore allowed).' });
      continue;
    }
    const lower = baseName.toLowerCase();
    // v1.0.3: well-known metadata files are skipped, not rejected.
    if (IGNORED_ENTRIES.has(lower) || lower.endsWith('.webmanifest') || lower.endsWith('.xml')) {
      ignored.push({ file: entryName, reason: 'Manifest/metadata entry — not an icon; skipped.' });
      continue;
    }
    // v1.0.3: canonicalize common generator names (favicon-32x32.png → icon-32.png …).
    const canonical = canonicalIconName(baseName);
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
      // Recognized naming: icon-<size>.png or apple-touch-icon.png (aliases
      // above were canonicalized first, so content is validated against the
      // CANONICAL declared size).
      const sizeMatch = /^icon-(\d{2,3})\.png$/i.exec(canonical.toLowerCase());
      if (sizeMatch) {
        const declared = Number(sizeMatch[1]);
        if (dims.width !== declared || dims.height !== declared) {
          rejected.push({ file: entryName, reason: `maps to icon-${declared}.png but must be exactly ${declared}x${declared}px (found ${dims.width}x${dims.height}).` });
          continue;
        }
        if (!expectedIconSizes.includes(declared)) {
          rejected.push({ file: entryName, reason: `Unexpected icon size ${declared}px — allowed: ${expectedIconSizes.join(', ')}.` });
          continue;
        }
      } else if (canonical.toLowerCase() !== 'apple-touch-icon.png') {
        rejected.push({ file: entryName, reason: 'PNG must be named icon-<size>.png (e.g. icon-192.png) or apple-touch-icon.png.' });
        continue;
      }
    }

    // v1.0.3: two source files can map to the same canonical name (e.g.
    // apple-touch-icon.png + apple-touch-icon-180x180.png) — keep the first.
    if (accepted.some((a) => a.file === canonical)) {
      ignored.push({ file: entryName, reason: `duplicate of ${canonical} — skipped.` });
      continue;
    }

    accepted.push({ file: canonical, width: dims?.width ?? null, height: dims?.height ?? null, bytes: bytes.byteLength });
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
    // accepted[].file is the CANONICAL name; find the original entry it came from.
    const entry = Object.entries(entries).find(([n]) => (n.split('/').pop() ?? n) === asset.file)
      ?? Object.entries(entries).find(([n]) => {
        const orig = (n.split('/').pop() ?? n).toLowerCase();
        return NAME_ALIASES.some(([p, t]) => t.toLowerCase() === asset.file.toLowerCase() && p.test(orig));
      });
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

  return { packageId, manifest, accepted, rejected, ignored };
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

/**
 * v1.0.13 §3 — self-healing branding adoption.
 *
 * The manifest lives in the Setting table while the icon files live on disk
 * under public/icons/<packageId>/. A database reset (prisma db push
 * --accept-data-loss / db:reset) wipes the Setting row but SURVIVES on disk,
 * which used to leave an orphaned package behind: the navbar fell back to the
 * monogram tile and metadata fell back to /logo.svg even though the generated
 * logo files were still served. This adoption path re-activates such an
 * orphaned package by rebuilding the manifest FROM THE ACTUAL FILES on disk
 * (favicon.ico + at least one valid icon-<size>.png, PNG IHDR dimensions
 * re-validated) — the same validation contract as stageIconPackage.
 *
 * Attempted at most once per process and only when the Setting row is truly
 * absent, so the happy path never pays for a directory scan.
 */
let adoptionAttempted = false;
export async function adoptOrphanedIconPackage(): Promise<boolean> {
  if (adoptionAttempted) return false;
  adoptionAttempted = true;
  try {
    const entries = await readdir(ICONS_ROOT, { withFileTypes: true });
    for (const dirEntry of entries) {
      if (!dirEntry.isDirectory() || !/^icons-[\w-]+$/.test(dirEntry.name)) continue;
      const pkgDir = path.join(ICONS_ROOT, dirEntry.name);
      const files = new Set((await readdir(pkgDir)).map((f) => f.toLowerCase()));
      if (!files.has('favicon.ico')) continue;

      const assets: IconAsset[] = [];
      const sized = [...files]
        .map((f) => /^icon-(\d{2,3})\.png$/.exec(f))
        .filter((m): m is RegExpExecArray => m !== null)
        .sort((a, b) => Number(a[1]) - Number(b[1]));
      for (const match of sized) {
        const file = match[0];
        const bytes = await readFile(path.join(pkgDir, file));
        const dims = pngDimensions(bytes);
        // Content must agree with the declared size — same rule as staging.
        if (!dims || dims.width !== Number(match[1]) || dims.height !== Number(match[1])) continue;
        assets.push({ file, width: dims.width, height: dims.height, bytes: bytes.byteLength });
      }
      if (assets.length === 0) continue;

      let appleTouch: string | null = null;
      if (files.has('apple-touch-icon.png')) {
        const at = await readFile(path.join(pkgDir, 'apple-touch-icon.png'));
        const dims = pngDimensions(at);
        if (dims) {
          assets.push({ file: 'apple-touch-icon.png', width: dims.width, height: dims.height, bytes: at.byteLength });
          appleTouch = 'apple-touch-icon.png';
        }
      }

      const manifest: BrandingManifest & { packageId: string } = {
        status: 'active',
        uploadedAt: new Date().toISOString(),
        activatedAt: new Date().toISOString(),
        assets,
        favicon: 'favicon.ico',
        appleTouch,
        p512: assets.find((a) => a.file === 'icon-512.png')?.file ?? null,
        p192: assets.find((a) => a.file === 'icon-192.png')?.file ?? null,
        packageId: dirEntry.name,
      };
      await db.setting.upsert({
        where: { key: BRAND_KEY },
        update: { value: JSON.stringify(manifest) },
        create: { key: BRAND_KEY, value: JSON.stringify(manifest) },
      });
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** Read the ACTIVE branding manifest (null when none). Used by layout metadata. */
export async function getActiveBranding(): Promise<(BrandingManifest & { packageId: string }) | null> {
  try {
    const row = await db.setting.findUnique({ where: { key: BRAND_KEY } });
    if (!row) {
      // v1.0.13 §3 — the Setting row is gone (db reset) while the generated
      // package survives on disk: adopt it so the real logo/favicon keep
      // loading instead of degrading to the fallback mark.
      const adopted = await adoptOrphanedIconPackage();
      if (!adopted) return null;
      const healed = await db.setting.findUnique({ where: { key: BRAND_KEY } });
      if (!healed) return null;
      const parsed = JSON.parse(healed.value) as BrandingManifest & { packageId: string };
      return parsed.status === 'active' ? parsed : null;
    }
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
