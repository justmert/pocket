'use client';

import { useEffect, useId, useState } from 'react';
import { useTheme } from 'next-themes';

/**
 * Mermaid, rendered on the client and themed from the wallet's own palette.
 *
 * The library is imported lazily and the promise is cached at module scope, so
 * a page carrying three diagrams pays for the (large) bundle once rather than
 * three times, and a page carrying none never loads it at all.
 *
 * Rendering is client-only by necessity: mermaid measures text by putting the
 * graph in a real DOM and reading it back, so there is no server pass that
 * could produce the same SVG.
 */
let mermaidPromise: Promise<typeof import('mermaid').default> | undefined;

function loadMermaid() {
  mermaidPromise ??= import('mermaid').then((m) => m.default);
  return mermaidPromise;
}

/*
 * Both palettes come from extension/src/entrypoints/popup/ui/theme.ts, the same
 * stops the rest of these pages use. Mermaid's `base` theme is the only one
 * that honours every variable below; the named themes override several of them.
 */
const PALETTE = {
  dark: {
    surface: '#0b1a22', // cool[750], the raised card
    surfaceAlt: '#11242d', // cool[800]
    border: '#264554', // cool[625]
    text: '#eeeef0', // paper[100]
    subdued: '#b3b3bd', // paper[150]
    accent: '#00b4ff', // sky[400]
    line: '#547283', // cool[450]
  },
  light: {
    surface: '#fcfdfe', // warm[0], the page
    surfaceAlt: '#eef1f5', // warm[100]
    border: '#dce2e8', // warm[200]
    text: '#1a2f39', // cool[700]
    subdued: '#3a5464', // cool[550]
    accent: '#005c8a', // sky[700], the stop that clears contrast on near-white
    line: '#7493a2', // cool[400]
  },
} as const;

function themeVariables(mode: 'light' | 'dark') {
  const p = PALETTE[mode];
  return {
    // Nodes.
    primaryColor: p.surface,
    primaryTextColor: p.text,
    primaryBorderColor: p.border,
    secondaryColor: p.surfaceAlt,
    secondaryTextColor: p.text,
    secondaryBorderColor: p.border,
    tertiaryColor: p.surfaceAlt,
    tertiaryTextColor: p.text,
    tertiaryBorderColor: p.border,
    nodeBorder: p.border,
    nodeTextColor: p.text,
    mainBkg: p.surface,

    // Edges, and the label that sits on one.
    lineColor: p.line,
    edgeLabelBackground: p.surfaceAlt,
    textColor: p.subdued,
    titleColor: p.text,

    // Subgraphs.
    clusterBkg: 'transparent',
    clusterBorder: p.border,

    // Sequence diagrams.
    actorBkg: p.surface,
    actorBorder: p.accent,
    actorTextColor: p.text,
    actorLineColor: p.line,
    signalColor: p.subdued,
    signalTextColor: p.text,
    labelBoxBkgColor: p.surfaceAlt,
    labelBoxBorderColor: p.border,
    labelTextColor: p.text,
    loopTextColor: p.text,
    noteBkgColor: p.surfaceAlt,
    noteBorderColor: p.border,
    noteTextColor: p.text,
    sequenceNumberColor: p.surface,

    // State diagrams. `stateLabelColor` is not optional: mermaid resolves it as
    // `stateLabelColor || stateBkg || primaryTextColor`, so setting a surface
    // colour without it paints every state's label in the colour of the box it
    // sits inside, and each state renders as an empty rectangle.
    stateLabelColor: p.text,
    stateBkg: p.surface,
    transitionColor: p.line,
    transitionLabelColor: p.subdued,
    specialStateColor: p.accent,
    compositeBackground: p.surface,
    compositeTitleBackground: p.surfaceAlt,
    compositeBorder: p.border,
    innerEndBackground: p.accent,
    labelColor: p.text,
    altBackground: p.surfaceAlt,

    // The page's own faces, so a diagram is set in the same type as its prose.
    fontFamily: 'var(--font-figtree), system-ui, sans-serif',
    fontSize: '14px',
  };
}

export function Mermaid({ chart }: { chart: string }) {
  // `useId` returns colons, which are not legal in the DOM ids mermaid writes
  // into the SVG it produces.
  const id = useId().replace(/[^a-zA-Z0-9]/g, '');
  const { resolvedTheme } = useTheme();
  const [svg, setSvg] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    const mode = resolvedTheme === 'light' ? 'light' : 'dark';

    void loadMermaid().then(async (mermaid) => {
      mermaid.initialize({
        startOnLoad: false,
        theme: 'base',
        themeVariables: themeVariables(mode),
        // SVG text rather than foreignObject HTML in flowcharts: it inherits
        // the page's font stack reliably.
        flowchart: { htmlLabels: false, curve: 'basis', padding: 12 },
        sequence: { useMaxWidth: true },
        securityLevel: 'strict',
      });

      const rendered = await mermaid.render(`mermaid-${id}`, chart.trim());
      if (!cancelled) setSvg(rendered.svg);
    });

    return () => {
      cancelled = true;
    };
  }, [chart, id, resolvedTheme]);

  // Reserved space rather than a spinner: a diagram is never the reason
  // somebody opened the page, and a placeholder that shifts the prose under it
  // costs more than the wait it announces.
  const className =
    'fd-mermaid my-6 overflow-x-auto rounded-xl border border-fd-border bg-fd-card p-5';

  if (svg === undefined) {
    return <div className={className} aria-busy="true" style={{ minHeight: '10rem' }} />;
  }

  return <div className={className} dangerouslySetInnerHTML={{ __html: svg }} />;
}
