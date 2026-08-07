import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';

/**
 * Options shared by every layout.
 *
 * The wordmark is set in Figtree at its heaviest weight and lowercased, which
 * is how the wallet's own header draws it (popup/ui/screens/Home.tsx). It is
 * type rather than an image, so it takes the theme's ink and stays crisp.
 */
export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <span className="text-[19px] font-bold tracking-[-0.02em] text-fd-foreground">
          pocket
        </span>
      ),
      url: '/docs',
    },
    // Light is the wallet's public pocket, dark is its private one, so the
    // switch moves between two palettes the product already ships.
    themeSwitch: { enabled: true, mode: 'light-dark' },
  };
}
