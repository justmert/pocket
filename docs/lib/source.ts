import { defineDocs } from 'fumadocs-mdx/macro';
import { applyMdxPreset } from 'fumadocs-mdx/config';
import { remarkMdxMermaid } from 'fumadocs-core/mdx-plugins';
import { loader } from 'fumadocs-core/source';

// `applyMdxPreset` rather than a bare `mdxOptions` object: setting mdxOptions
// directly REPLACES the default plugin set, which would take the heading ids,
// the syntax highlighting and the search index with it. The preset returns the
// defaults, and `remarkPlugins` receives them so the mermaid transform is
// appended rather than substituted.
const docs = defineDocs({
  dir: 'content/docs',
  docs: {
    mdxOptions: applyMdxPreset({
      // Passed uncalled: it is a unified plugin (options in, transformer out),
      // so calling it here would hand unified the transformer as the attacher.
      remarkPlugins: (plugins) => [...plugins, remarkMdxMermaid],
    }),
  },
});

export const source = loader({
  baseUrl: '/docs',
  source: docs.toFumadocsSource(),
});
