import type { Metadata, Viewport } from "next";
import { Readex_Pro, Michroma, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { APP_NAME, APP_VERSION } from "@/lib/nexool/version";
import { getActiveBranding, iconUrl } from "@/lib/nexool/branding";

// Primary interface typography — headings, body, navigation, forms.
const readexPro = Readex_Pro({
  variable: "--font-readex-pro",
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
  display: "swap",
});

// Secondary technical typography — version badges, system indicators, metadata.
const michroma = Michroma({
  variable: "--font-michroma",
  subsets: ["latin"],
  weight: "400",
  display: "swap",
});

// Monospace — terminal output, JSON, code.
const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

/**
 * v1.0.2 §59/§60 — icons come from the ACTIVE branding package (Settings →
 * Branding & icons) when one exists; otherwise the default /logo.svg applies.
 * Nothing stale is referenced: the manifest is the single source of truth.
 */
export async function generateMetadata(): Promise<Metadata> {
  let icons: Metadata["icons"];
  const branding = await getActiveBranding().catch(() => null);
  if (branding) {
    const dir = (file: string) => iconUrl(branding.packageId, file);
    const sized = branding.assets
      .filter((a) => a.width && a.height)
      .map((a) => ({ url: dir(a.file), sizes: `${a.width}x${a.height}`, type: 'image/png' }));
    icons = {
      icon: branding.favicon ? [{ url: dir(branding.favicon) }, ...sized] : sized,
      apple: branding.appleTouch ? dir(branding.appleTouch) : undefined,
    };
  } else {
    // v1.0.13 §3 — hardcoded CORRECT generated logo paths. The shipped
    // branding package lives at /icons/icons-muy8s37a/ (public/icons/); when
    // no active manifest exists (fresh DB before adoption) the metadata still
    // points at the REAL shipped assets instead of a wrong/stale path.
    const gen = (file: string) => `/icons/icons-muy8s37a/${file}`;
    icons = {
      icon: [
        { url: gen('favicon.ico') },
        { url: gen('icon-16.png'), sizes: '16x16', type: 'image/png' },
        { url: gen('icon-32.png'), sizes: '32x32', type: 'image/png' },
        { url: gen('icon-48.png'), sizes: '48x48', type: 'image/png' },
        { url: gen('icon-192.png'), sizes: '192x192', type: 'image/png' },
        { url: gen('icon-512.png'), sizes: '512x512', type: 'image/png' },
        { url: '/logo.svg', type: 'image/svg+xml' },
      ],
      apple: gen('apple-touch-icon.png'),
    };
  }

  return {
    title: `${APP_NAME} — AI Operations Console`,
    description:
      `${APP_NAME} v${APP_VERSION} — specialized AI task-processing, decision, planning, observation, automation and tool-execution runtime with a real-time operations console.`,
    keywords: [
      "NexTool",
      "Q1",
      "AI operations console",
      "task processing",
      "tool execution",
      "automation runtime",
      "event-driven automation",
      "live mode",
    ],
    applicationName: APP_NAME,
    icons,
  };
}

export const viewport: Viewport = {
  themeColor: "#050914",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`dark ${readexPro.variable} ${michroma.variable} ${geistMono.variable}`}
      suppressHydrationWarning
    >
      <body className="font-sans antialiased bg-background text-foreground">
        {children}
        <Toaster />
      </body>
    </html>
  );
}
