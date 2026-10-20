// Índice de Ayuda FLITO (HU #11893 · búsqueda HU #11901 · relevancia Feature #13691 HU #13704).
// Sin consulta: agrupado en el orden del menú (HU #13431). Con consulta (P9-1a): una sola lista
// ordenada por relevancia, con el grupo como etiqueta de cada fila. La consulta no va a la URL.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../lib/auth';
import { capitulosVisibles } from '../../lib/ayudaFlito';
import { leerFichasParseadas, verificarBundleAyuda } from '../../content/ayuda/cargarFichas';
import type { FichaParseada } from '../../lib/ayudaFicha';
import { GRUPO_AYUDA_LABEL, type AyudaGrupo, type EntradaAyuda } from '../../content/ayuda/catalogo';
import { documentoDeEntrada, ordenarPorRelevancia, resumenDeEntrada } from '../../lib/ayudaBusqueda';
import PageHeaderCard from '../flit/PageHeaderCard';
import PageContentSkeleton from '../flit/PageContentSkeleton';
import StatusChip from '../flit/StatusChip';
import { FlitField, flitBtnSecondary, flitBtnSecondaryStyle, flitInp } from '../flit/flitPageKit';
import { AyudaSinModulos, AyudaSinResultados, ErrorAyuda } from './AyudaEstados';

const GRUPOS_ORDEN: AyudaGrupo[] = ['general', 'gestion', 'finanzas', 'administracion'];
const SUBTITULO = 'Guías de las pantallas que usted ya puede abrir.';
const ANUNCIO_MS = 300;

type EstadoCarga = 'cargando' | 'error' | 'listo';

const tarjeta = {
  borderRadius: 'var(--flit-radius-card)',
  border: '1px solid var(--flit-border-soft)',
  boxShadow: 'var(--flit-shadow-card)',
  background: 'var(--flit-bg-card)',
} as const;

function textoConteo(total: number, consulta: string): string {
  return total === 1
    ? `1 ficha coincide con "${consulta}"`
    : `${total} fichas coinciden con "${consulta}"`;
}

export default function AyudaIndice() {
  const { user } = useAuth();
  const [estado, setEstado] = useState<EstadoCarga>('cargando');
  const [fichas, setFichas] = useState<ReadonlyMap<string, FichaParseada | null>>(() => new Map());
  const [consulta, setConsulta] = useState('');
  const [anunciada, setAnunciada] = useState('');
  const inputBuscarRef = useRef<HTMLInputElement>(null);

  // Orden del índice: grupo (orden del menú) y, dentro, el del catálogo. Es el desempate del ranking.
  const capitulos = useMemo(() => {
    const visibles = capitulosVisibles(user);
    return GRUPOS_ORDEN.flatMap((g) => visibles.filter((c) => c.grupo === g));
  }, [user]);

  useEffect(() => {
    if (capitulos.length === 0) {
      setEstado('listo');
      return undefined;
    }
    let cancel = false;
    setEstado('cargando');
    const slugs = capitulos.map((c) => c.clave);
    verificarBundleAyuda()
      .then(() => leerFichasParseadas(slugs))
      .then((map) => {
        if (cancel) return;
        setFichas(map);
        setEstado('listo');
      })
      .catch(() => {
        if (cancel) return;
        setEstado('error');
      });
    return () => { cancel = true; };
  }, [capitulos]);

  const q = consulta.trim();

  // El conteo se anuncia cuando el usuario deja de escribir, no por tecla.
  useEffect(() => {
    const t = setTimeout(() => setAnunciada(q), ANUNCIO_MS);
    return () => clearTimeout(t);
  }, [q]);

  // Reintentar recarga el documento: el navegador guarda en su mapa de módulos el `import()` que
  // falló y repetirlo en la misma página vuelve a fallar sin pedir nada a la red (AC8).
  const reintentar = useCallback(() => window.location.reload(), []);

  const documentos = useMemo(
    () => capitulos.map((c) => documentoDeEntrada(c, fichas.get(c.clave))),
    [capitulos, fichas],
  );
  const resultados = useMemo(() => ordenarPorRelevancia(documentos, q), [documentos, q]);

  const agrupados = useMemo(() => GRUPOS_ORDEN
    .map((grupo) => ({ grupo, items: capitulos.filter((c) => c.grupo === grupo) }))
    .filter((g) => g.items.length > 0), [capitulos]);

  const limpiarBusqueda = useCallback(() => {
    setConsulta('');
    inputBuscarRef.current?.focus();
  }, []);

  if (capitulos.length === 0) return <AyudaSinModulos />;

  if (estado === 'cargando') {
    return (
      <div className="space-y-4">
        <PageHeaderCard title="Ayuda FLITO" subtitle={SUBTITULO} />
        <PageContentSkeleton />
      </div>
    );
  }

  if (estado === 'error') {
    return (
      <div className="space-y-4">
        <PageHeaderCard title="Ayuda FLITO" subtitle={SUBTITULO} />
        <ErrorAyuda titulo="No se pudo cargar el índice de ayuda." onReintentar={reintentar} />
      </div>
    );
  }

  const anuncioVigente = q !== '' && anunciada === q;

  return (
    <div className="space-y-6">
      <PageHeaderCard title="Ayuda FLITO" subtitle={SUBTITULO} />
      <div className="space-y-2">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-0 basis-full lg:max-w-xl lg:flex-1 lg:basis-auto">
            <FlitField label="Buscar fichas">
              <input
                ref={inputBuscarRef}
                id="ayuda-buscar-fichas"
                type="search"
                className={flitInp}
                placeholder="Buscar fichas…"
                value={consulta}
                onChange={(e) => setConsulta(e.target.value)}
                maxLength={100}
                autoComplete="off"
              />
            </FlitField>
          </div>
          {consulta !== '' && (
            <button
              type="button"
              className={flitBtnSecondary}
              style={flitBtnSecondaryStyle}
              onClick={limpiarBusqueda}
            >
              Limpiar búsqueda
            </button>
          )}
        </div>
        <p
          role="status"
          aria-live="polite"
          className="min-h-[1.25rem] break-words text-sm"
          style={{ color: 'var(--flit-text-secondary)' }}
        >
          {anuncioVigente && (resultados.length === 0
            ? <AyudaSinResultados consulta={q} />
            : textoConteo(resultados.length, q))}
        </p>
      </div>

      {q === '' ? (
        <nav aria-label="Fichas de ayuda" className="space-y-6">
          {agrupados.map(({ grupo, items }) => (
            <section key={grupo} aria-labelledby={`ayuda-grupo-${grupo}`}>
              <h2
                id={`ayuda-grupo-${grupo}`}
                className="mb-2 text-xs font-semibold uppercase tracking-[0.18em]"
                style={{ color: 'var(--flit-text-secondary)' }}
              >
                {GRUPO_AYUDA_LABEL[grupo]}
              </h2>
              <div className="overflow-hidden" style={tarjeta}>
                <ul>
                  {items.map((entrada, idx) => (
                    <li key={entrada.clave} style={idx > 0 ? { borderTop: '1px solid var(--flit-border-soft)' } : undefined}>
                      <FilaFicha entrada={entrada} ficha={fichas.get(entrada.clave) ?? null} />
                    </li>
                  ))}
                </ul>
              </div>
            </section>
          ))}
        </nav>
      ) : resultados.length > 0 && (
        <div className="overflow-hidden" style={tarjeta}>
          <ol aria-label="Resultados de la búsqueda">
            {resultados.map(({ entrada }, idx) => (
              <li key={entrada.clave} style={idx > 0 ? { borderTop: '1px solid var(--flit-border-soft)' } : undefined}>
                <FilaFicha entrada={entrada} ficha={fichas.get(entrada.clave) ?? null} conGrupo />
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

export function FilaFicha(
  { entrada, ficha, conGrupo = false }: { entrada: EntradaAyuda; ficha: FichaParseada | null; conGrupo?: boolean },
) {
  const pendiente = ficha == null;
  const grupo = GRUPO_AYUDA_LABEL[entrada.grupo];
  const base = pendiente ? `Ficha pendiente de ${entrada.etiqueta}` : `Abrir ficha de ${entrada.etiqueta}`;
  const nombre = conGrupo ? `${base}, ${grupo}` : base;
  return (
    <Link
      to={`/flito/ayuda/${entrada.clave}`}
      aria-label={nombre}
      className="flit-focus flex items-center gap-3 px-5 py-4 transition-colors hover:bg-[color:var(--flit-bg-app)]"
    >
      <span className="min-w-0 flex-1">
        {conGrupo && (
          <span
            className="mb-1 block text-xs font-semibold uppercase tracking-[0.18em]"
            style={{ color: 'var(--flit-text-secondary)' }}
            data-testid="ayuda-fila-grupo"
          >
            {grupo}
          </span>
        )}
        <span className="block break-words text-sm font-semibold" style={{ color: 'var(--flit-blue-text)' }}>{entrada.etiqueta}</span>
        <span className="mt-0.5 block break-words text-sm" style={{ color: 'var(--flit-text-secondary)' }}>{resumenDeEntrada(entrada, ficha)}</span>
        {pendiente && <span className="mt-2 block sm:hidden"><StatusChip tone="active">Ficha pendiente</StatusChip></span>}
      </span>
      {pendiente && <span className="hidden sm:inline-flex"><StatusChip tone="active">Ficha pendiente</StatusChip></span>}
      <span aria-hidden="true" className="text-lg" style={{ color: 'var(--flit-text-muted)' }}>→</span>
    </Link>
  );
}
