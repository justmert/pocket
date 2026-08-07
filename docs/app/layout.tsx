import './global.css';
import { RootProvider } from 'fumadocs-ui/provider/next';
import { DM_Mono, Figtree } from 'next/font/google';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';

// The two faces the wallet itself uses. Figtree carries every heading and every
// line of prose; DM Mono carries verbatim data (addresses, hashes, contract
// ids), which is read one character at a time.
const figtree = Figtree({
  subsets: ['latin'],
  variable: '--font-figtree',
  display: 'swap',
});

const dmMono = DM_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-dm-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: {
    default: 'Pocket',
    template: '%s · Pocket',
  },
  description:
    'A self-custody Stellar wallet with two pockets: one public, one private. Confidential, not anonymous.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // next-themes owns the class, which is why `suppressHydrationWarning` is
    // here: the server cannot know which theme this reader chose, so the
    // provider's inline script writes the class before paint and React is told
    // not to complain about the attribute it did not render.
    <html lang="en" className={`${figtree.variable} ${dmMono.variable}`} suppressHydrationWarning>
      <body className="flex min-h-screen flex-col font-sans">
        <RootProvider theme={{ defaultTheme: 'light' }}>{children}</RootProvider>
      </body>
    </html>
  );
}
