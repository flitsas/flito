// Índice de Ayuda FLITO (HU #11893 · búsqueda HU #11901 · relevancia Feature #13691 HU #13704).
// Sin consulta: agrupado en el orden del menú (HU #13431). Con consulta (P9-1a): una sola lista
// ordenada por relevancia, con el grupo como etiqueta de cada fila. La consulta no va a la URL.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../lib/auth';
import { capitulosEnOrdenDeIndice } from '../../lib/ayudaFlito';
import { leerFichasParseadas, verificarBundleAyuda } from '../../content/ayuda/cargarFichas';
import type { FichaParseada } from '../../lib/ayudaFicha';
import { GRUPO_AYUDA_LABEL, GRUPOS_ORDEN, type EntradaAyuda } from '../../content/ayuda/catalogo';
import { documentoDeEntrada, ordenarPorRelevancia, resumenDeEntrada } from '../../lib/ayudaBusqueda';
import PageHeaderCard from '../flit/PageHeaderCard';
import PageContentSkeleton from '../flit/PageContentSkeleton';
import StatusChip from '../flit/StatusChip';
import GradientButton from '../flit/GradientButton';
import { Icono, IconoModulo } from '../flit/kit/Icono';
import { FlitField, flitInp } from '../flit/flitPageKit';
import { AyudaSinModulos, AyudaSinResultados, ErrorAyuda } from './AyudaEstados';

const SUBTITULO = 'Guías de las pantallas que usted ya puede abrir.';
const ANUNCIO_MS = 300;

type EstadoCarga = 'cargando' | 'error' | 'listo';

/** Rejilla de accesos del kit (`.accesos` de la propuesta, molde `#ayuda`): tarjetas de 210 px mínimo. */
const REJILLA = 'grid grid-cols-[repeat(auto-fill,minmax(min(100%,15rem),1fr))] gap-4';
const CABECERA = { title: 'Ayuda FLITO', subtitle: SUBTITULO, icono: 'flito-ayuda' } as const;

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
  const capitulos = useMemo(() => capitulosEnOrdenDeIndice(user), [user]);

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
        <PageHeaderCard {...CABECERA} miga={[]} />
        <PageContentSkeleton />
      </div>
    );
  }

  if (estado === 'error') {
    return (
      <div className="space-y-4">
        <PageHeaderCard {...CABECERA} miga={[]} />
        <ErrorAyuda titulo="No se pudo cargar el índice de ayuda." onReintentar={reintentar} />
      </div>
    );
  }

  const anuncioVigente = q !== '' && anunciada === q;

  return (
    <div className="space-y-6">
      <PageHeaderCard {...CABECERA} miga={[]} />
      <div className="card space-y-2">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-0 basis-full lg:max-w-xl lg:flex-1 lg:basis-auto">
            <FlitField label="Buscar fichas">
              <span className="relative block">
                <Icono
                  nombre="buscar"
                  size={18}
                  className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-[color:var(--color-text-tertiary)]"
                />
              <input
                ref={inputBuscarRef}
                id="ayuda-buscar-fichas"
                type="search"
                className={`${flitInp} h-10 pl-10`}
                placeholder="Buscar fichas…"
                value={consulta}
                onChange={(e) => setConsulta(e.target.value)}
                maxLength={100}
                autoComplete="off"
              />
              </span>
            </FlitField>
          </div>
          {consulta !== '' && (
            <GradientButton type="button" variant="secondary" onClick={limpiarBusqueda}>
              Limpiar búsqueda
            </GradientButton>
          )}
        </div>
        <p
          role="status"
          aria-live="polite"
          className="min-h-[1.25rem] break-words text-sm text-[color:var(--color-text-secondary)]"
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
                className="mb-3 text-lg font-medium text-[color:var(--color-text-primary)]"
              >
                {GRUPO_AYUDA_LABEL[grupo]}
              </h2>
              <ul className={REJILLA}>
                {items.map((entrada) => (
                  <li key={entrada.clave} className="min-w-0">
                    <FilaFicha entrada={entrada} ficha={fichas.get(entrada.clave) ?? null} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </nav>
      ) : resultados.length > 0 && (
        <ol aria-label="Resultados de la búsqueda" className={REJILLA}>
          {resultados.map(({ entrada }) => (
            <li key={entrada.clave} className="min-w-0">
              <FilaFicha entrada={entrada} ficha={fichas.get(entrada.clave) ?? null} conGrupo />
            </li>
          ))}
        </ol>
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
      data-kit="acceso"
      className="flit-focus flex h-full min-h-[72px] items-start gap-3.5 rounded-[9px] border border-[color:var(--color-border)] bg-[var(--color-surface-elevated)] p-4 transition-colors hover:border-[color:var(--kit-azul)] hover:bg-[var(--kit-hover)]"
    >
      <IconoModulo clave={entrada.clave} disco size={40} className="shrink-0" />
      <span className="min-w-0 flex-1">
        {conGrupo && (
          <span
            className="mb-1 block text-xs font-light text-[color:var(--color-text-tertiary)]"
            data-testid="ayuda-fila-grupo"
          >
            {grupo}
          </span>
        )}
        <span className="block break-words text-base font-semibold text-[color:var(--color-action)]">{entrada.etiqueta}</span>
        <span className="mt-0.5 block break-words text-sm text-[color:var(--color-text-tertiary)]">{resumenDeEntrada(entrada, ficha)}</span>
        {pendiente && <span className="mt-2 block"><StatusChip tone="active">Ficha pendiente</StatusChip></span>}
      </span>
    </Link>
  );
}
