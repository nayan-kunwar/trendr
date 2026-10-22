import type { Metadata, Viewport } from 'next';
import { GeistMono } from 'geist/font/mono';
import { GeistSans } from 'geist/font/sans';
import type { ReactNode } from 'react';

import { AuthProvider } from '@/components/auth-provider';
import { SiteFooter } from '@/components/site-footer';
import { SiteHeader } from '@/components/site-header';
import { ThemeProvider } from '@/components/theme-provider';

import './globals.css';

const siteUrl = process.env.WEB_PUBLIC_URL ?? 'http://localhost:3000';

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: 'Trendr — What developers are building right now',
    template: '%s · Trendr',
  },
  description:
    'Trendr ranks GitHub repos, npm and PyPI packages, Hugging Face models, arXiv papers and MCP servers by growth velocity.',
  applicationName: 'Trendr',
  keywords: [
    'trending repositories',
    'open source trends',
    'npm trends',
    'PyPI trends',
    'Hugging Face models',
    'arXiv papers',
    'MCP servers',
  ],
  openGraph: {
    type: 'website',
    siteName: 'Trendr',
    title: 'Trendr — What developers are building right now',
    description: 'Cross-source growth rankings for GitHub, npm, PyPI, Hugging Face, arXiv and MCP.',
    url: siteUrl,
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Trendr — What developers are building right now',
    description: 'Growth rankings across six open-source ecosystems.',
  },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#09090b' },
  ],
  colorScheme: 'light dark',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${GeistSans.variable} ${GeistMono.variable}`}
    >
      <body className="flex min-h-screen flex-col font-sans antialiased">
        <ThemeProvider attribute="class" defaultTheme="dark" enableSystem disableTransitionOnChange>
          <AuthProvider>
            <SiteHeader />
            <div className="flex-1">{children}</div>
            <SiteFooter />
          </AuthProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
