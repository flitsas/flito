import type { ReactNode } from 'react';
import { AlertCircle, AlertTriangle, Info, type LucideIcon } from 'lucide-react';
import AyudaImagen from './AyudaImagen';
import { parseMarkdown, type MdBlock, type MdInline, type TipoAviso } from '../../lib/ayudaMarkdown';

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
    if (n.type === 'img') return <AyudaImagen key={i} alt={n.alt} src={n.src} en="span" />;
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

// HU #13706 (UX HU-4): el tipo se lee en el RÓTULO (texto), con icono y tinta de apoyo. Fondo neutro
// común (`--flit-bg-table-header`, con par oscuro); tintas `*-text`, que tienen par oscuro (las
// `*-ink` y los `--flit-chip-*-bg` no). `role="note"`: contenido estático, no alerta; el rótulo no es
// encabezado, así que no entra en la tabla de contenido.
const AVISOS: Record<TipoAviso, { rotulo: string; tinta: string; Icono: LucideIcon }> = {
  nota: { rotulo: 'Nota', tinta: 'var(--flit-blue-text)', Icono: Info },
  importante: { rotulo: 'Importante', tinta: 'var(--flit-warning-text)', Icono: AlertCircle },
  precaucion: { rotulo: 'Precaución', tinta: 'var(--flit-danger-text)', Icono: AlertTriangle },
};

function Parrafos({ parrafos, puedeEnlazar }: { parrafos: MdInline[][]; puedeEnlazar: (href: string) => boolean }): ReactNode {
  return parrafos.map((p, i) => (
    <p key={i} className="break-words text-sm leading-6" style={{ color: 'var(--flit-text-primary)' }}>
      <Inline nodes={p} puedeEnlazar={puedeEnlazar} />
    </p>
  ));
}

function Bloque({ block, puedeEnlazar }: { block: MdBlock; puedeEnlazar: (href: string) => boolean }): ReactNode {
  const hStyle = { color: 'var(--flit-blue-text)' };
  // HU #13705 (AC7): id = ancla del encabezado (`anclaDeEncabezado`), foco de programa al saltar a él y
  // margen de scroll para no quedar bajo la topbar. El `h1` del .md baja a `h2`: el h1 es el del header.
  const hProps = (id: string) => ({ id, tabIndex: -1, className: 'flit-focus scroll-mt-24 rounded-sm' });
  if (block.type === 'h1' || block.type === 'h2') {
    const p = hProps(block.id);
    return <h2 {...p} className={`${p.className} text-lg font-semibold`} style={hStyle}><Inline nodes={block.children} puedeEnlazar={puedeEnlazar} /></h2>;
  }
  if (block.type === 'h3') {
    const p = hProps(block.id);
    return <h3 {...p} className={`${p.className} text-base font-semibold`} style={hStyle}><Inline nodes={block.children} puedeEnlazar={puedeEnlazar} /></h3>;
  }
  if (block.type === 'p') {
    // HU #13707: una imagen sola en su párrafo es una figura (fuera del `<p>`).
    const [unica] = block.children;
    if (block.children.length === 1 && unica.type === 'img') {
      return <AyudaImagen alt={unica.alt} src={unica.src} en="figure" />;
    }
    return (
      <p className="text-sm leading-6" style={{ color: 'var(--flit-text-primary)' }}>
        <Inline nodes={block.children} puedeEnlazar={puedeEnlazar} />
      </p>
    );
  }
  if (block.type === 'callout') {
    const { rotulo, tinta, Icono } = AVISOS[block.tipo];
    return (
      <div
        role="note"
        aria-label={rotulo}
        data-testid={`ayuda-aviso-${block.tipo}`}
        className="space-y-1 rounded-lg px-4 py-3"
        style={{ background: 'var(--flit-bg-table-header)', borderLeft: `3px solid ${tinta}` }}
      >
        <p className="flex items-center gap-1.5 text-sm font-semibold" style={{ color: tinta }}>
          <Icono aria-hidden="true" className="h-4 w-4 shrink-0" />
          <strong>{rotulo}</strong>
        </p>
        <Parrafos parrafos={block.parrafos} puedeEnlazar={puedeEnlazar} />
      </div>
    );
  }
  if (block.type === 'quote') {
    return (
      <blockquote className="space-y-1 pl-4" style={{ borderLeft: '3px solid var(--flit-border-soft)' }}>
        <Parrafos parrafos={block.parrafos} puedeEnlazar={puedeEnlazar} />
      </blockquote>
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
  { source, bloques, puedeEnlazar, label }: {
    source?: string;
    /** AST ya parseado (la ficha lo comparte con la tabla de contenido). Gana sobre `source`. */
    bloques?: MdBlock[];
    puedeEnlazar: (href: string) => boolean;
    label: string;
  },
) {
  const ast = bloques ?? parseMarkdown(source ?? '');
  return (
    <article className="space-y-4" aria-label={label}>
      {ast.map((block, i) => (
        <Bloque key={i} block={block} puedeEnlazar={puedeEnlazar} />
      ))}
    </article>
  );
}
