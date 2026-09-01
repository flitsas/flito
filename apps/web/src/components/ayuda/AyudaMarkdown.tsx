import type { ReactNode } from 'react';
import { parseMarkdown, type MdBlock, type MdInline } from '../../lib/ayudaMarkdown';

// AST → React. Cero dangerouslySetInnerHTML. HTML crudo del .md llega como texto.

function Inline({ nodes, puedeEnlazar }: { nodes: MdInline[]; puedeEnlazar: (href: string) => boolean }): ReactNode {
  return nodes.map((n, i) => {
    if (n.type === 'text') return <span key={i}>{n.value}</span>;
    if (n.type === 'strong') return <strong key={i}><Inline nodes={n.children} puedeEnlazar={puedeEnlazar} /></strong>;
    if (n.type === 'code') {
      return (
        <code
          key={i}
          className="rounded px-1 py-0.5 font-mono text-[0.85em]"
          style={{ background: 'var(--flit-bg-app)', color: 'var(--flit-text-primary)' }}
        >
          {n.value}
        </code>
      );
    }
    if (!puedeEnlazar(n.href)) {
      return <span key={i}><Inline nodes={n.children} puedeEnlazar={puedeEnlazar} /></span>;
    }
    return (
      <a
        key={i}
        href={n.href}
        className="flit-focus underline"
        style={{ color: 'var(--flit-blue-ink)' }}
        rel={n.href.startsWith('http') ? 'noopener noreferrer' : undefined}
        target={n.href.startsWith('http') ? '_blank' : undefined}
      >
        <Inline nodes={n.children} puedeEnlazar={puedeEnlazar} />
      </a>
    );
  });
}

function Bloque({ block, puedeEnlazar }: { block: MdBlock; puedeEnlazar: (href: string) => boolean }): ReactNode {
  const hStyle = { color: 'var(--flit-blue-text)' };
  if (block.type === 'h1') return <h2 className="text-lg font-semibold" style={hStyle}><Inline nodes={block.children} puedeEnlazar={puedeEnlazar} /></h2>;
  if (block.type === 'h2') return <h2 className="text-lg font-semibold" style={hStyle}><Inline nodes={block.children} puedeEnlazar={puedeEnlazar} /></h2>;
  if (block.type === 'h3') return <h3 className="text-base font-semibold" style={hStyle}><Inline nodes={block.children} puedeEnlazar={puedeEnlazar} /></h3>;
  if (block.type === 'p') {
    return (
      <p className="text-sm leading-6" style={{ color: 'var(--flit-text-primary)' }}>
        <Inline nodes={block.children} puedeEnlazar={puedeEnlazar} />
      </p>
    );
  }
  if (block.type === 'ul') {
    return (
      <ul className="list-disc space-y-1 pl-5 text-sm leading-6" style={{ color: 'var(--flit-text-primary)' }}>
        {block.items.map((item, i) => (
          <li key={i}><Inline nodes={item} puedeEnlazar={puedeEnlazar} /></li>
        ))}
      </ul>
    );
  }
  if (block.type === 'ol') {
    return (
      <ol className="list-decimal space-y-1 pl-5 text-sm leading-6" style={{ color: 'var(--flit-text-primary)' }}>
        {block.items.map((item, i) => (
          <li key={i}><Inline nodes={item} puedeEnlazar={puedeEnlazar} /></li>
        ))}
      </ol>
    );
  }
  return (
    <pre
      className="overflow-x-auto rounded-lg p-3 font-mono text-xs"
      style={{ background: 'var(--flit-bg-app)', color: 'var(--flit-text-primary)', border: '1px solid var(--flit-border-soft)' }}
    >
      <code>{block.type === 'pre' ? block.code : ''}</code>
    </pre>
  );
}

export default function AyudaMarkdown(
  { source, puedeEnlazar, label }: {
    source: string;
    puedeEnlazar: (href: string) => boolean;
    label: string;
  },
) {
  const ast = parseMarkdown(source);
  return (
    <article className="space-y-4" aria-label={label}>
      {ast.map((block, i) => (
        <Bloque key={i} block={block} puedeEnlazar={puedeEnlazar} />
      ))}
    </article>
  );
}
