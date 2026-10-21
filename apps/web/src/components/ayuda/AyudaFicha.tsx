// Ficha de Ayuda FLITO (HU #11893 · versión y fecha HU #13703 · Feature #13691 HU #13705).
// Extraída de `pages/FlitoAyuda.tsx` (diseño slim §7): 4 estados, foco en el `#ancla`, tabla de
// contenido y Anterior/Siguiente dentro de lo visible.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../../lib/auth';
import {
  capitulosEnOrdenDeIndice,
  entradaAyudaPorClave,
  puedeEnlazarFichaAyuda,
  puedeVerEntradaAyuda,
  vecinasVisibles,
} from '../../lib/ayudaFlito';
import { leerFichaParseada } from '../../content/ayuda/cargarFichas';
import { GRUPO_AYUDA_LABEL, type EntradaAyuda } from '../../content/ayuda/catalogo';
import { fechaFichaLegible, type FichaParseada } from '../../lib/ayudaFicha';
import { resumenDeEntrada } from '../../lib/ayudaBusqueda';
import { parseMarkdown } from '../../lib/ayudaMarkdown';
import NoAccess from '../NoAccess';
import AyudaMarkdown from './AyudaMarkdown';
import AyudaAplicaPara from './AyudaAplicaPara';
import { ErrorAyuda, SkeletonFicha } from './AyudaEstados';
import {
  TablaContenidoLateral, TablaContenidoPlegable, fichaConTabla, seccionesDeFicha,
} from './AyudaTablaContenido';
import PageHeaderCard from '../flit/PageHeaderCard';
import {
  FlitCard, FlitEmpty, flitBtnSecondary, flitBtnSecondaryStyle,
} from '../flit/flitPageKit';
import { isValidPage } from '../../lib/permissions';

type EstadoCarga = 'cargando' | 'error' | 'listo';

function anclaDeHash(hash: string): string {
  if (!hash.startsWith('#') || hash.length < 2) return '';
  try {
    return decodeURIComponent(hash.slice(1));
  } catch {
    return '';
  }
}

export default function AyudaFicha({ slug }: { slug: string }) {
  const { user } = useAuth();
  const { hash } = useLocation();
  const titleRef = useRef<HTMLHeadingElement>(null);
  const entrada = entradaAyudaPorClave(slug);
  const visible = !!entrada && puedeVerEntradaAyuda(user, entrada);
  const [estado, setEstado] = useState<EstadoCarga>('cargando');
  const [fuente, setFuente] = useState<FichaParseada | null>(null);
  const ancla = anclaDeHash(hash);

  useEffect(() => {
    if (!entrada || !visible) return undefined;
    let cancel = false;
    setEstado('cargando');
    setFuente(null);
    leerFichaParseada(entrada.clave)
      .then((ficha) => {
        if (cancel) return;
        setFuente(ficha);
        setEstado('listo');
      })
      .catch(() => {
        if (cancel) return;
        setEstado('error');
      });
    return () => { cancel = true; };
  }, [entrada, visible]);

  // Foco (AC2/AC3): con el cuerpo ya pintado, si el `#ancla` existe salta a ese encabezado y le da el
  // foco; si no existe (o no hay ancla), el foco va al título, sin mensaje. Salto instantáneo.
  useEffect(() => {
    if (estado === 'cargando') {
      titleRef.current?.focus();
      return;
    }
    const destino = ancla ? document.getElementById(ancla) : null;
    if (destino && destino.closest('[data-ayuda-cuerpo]')) {
      destino.scrollIntoView({ block: 'start' });
      destino.focus({ preventScroll: true });
      return;
    }
    titleRef.current?.focus();
  }, [slug, estado, ancla]);

  // Reintentar recarga el documento, igual que el índice (HU #13704 AC8): Chrome guarda en su mapa de
  // módulos el `import()` que falló y repetirlo en la misma página (el antiguo reintento por nonce)
  // vuelve a fallar sin pedir nada a la red, así que nunca tenía éxito.
  const reintentar = useCallback(() => window.location.reload(), []);
  const enlazar = useCallback((href: string) => puedeEnlazarFichaAyuda(user, href), [user]);
  const bloques = useMemo(() => (fuente ? parseMarkdown(fuente.cuerpo) : []), [fuente]);
  const secciones = useMemo(() => seccionesDeFicha(bloques), [bloques]);
  const vecinas = useMemo(() => vecinasVisibles(capitulosEnOrdenDeIndice(user), slug), [user, slug]);
  const resumen = entrada ? resumenDeEntrada(entrada, fuente) : '';

  if (!entrada) {
    return (
      <div className="space-y-4">
        <PageHeaderCard title="Ayuda FLITO" leading={<VolverIndice />} />
        <FlitEmpty>
          <p className="text-base font-semibold" style={{ color: 'var(--flit-text-primary)' }}>Esta ficha no existe.</p>
          <p className="mx-auto mt-2 max-w-lg">Esa ficha no forma parte de la Ayuda FLITO.</p>
          <Link to="/flito/ayuda" className={`${flitBtnSecondary} mt-4`} style={flitBtnSecondaryStyle}>Volver al índice</Link>
        </FlitEmpty>
      </div>
    );
  }

  if (!visible) {
    if (entrada.permiso && isValidPage(entrada.permiso)) {
      return <NoAccess page={entrada.permiso} />;
    }
    return <NoAccess label={entrada.etiqueta} />;
  }

  const irPantalla = entrada.to ? (
    <Link
      to={entrada.to}
      aria-label={`Ir a la pantalla ${entrada.etiqueta}`}
      className={flitBtnSecondary}
      style={flitBtnSecondaryStyle}
    >
      Ir a la pantalla
    </Link>
  ) : undefined;

  const header = (conAccion: boolean) => (
    <PageHeaderCard
      title={entrada.etiqueta}
      subtitle={resumen || undefined}
      leading={<VolverIndice />}
      titleRef={titleRef}
      actions={conAccion ? irPantalla : undefined}
    />
  );

  if (estado === 'cargando') {
    return (
      <div className="space-y-4">
        {header(false)}
        <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_15rem] lg:items-start lg:gap-6">
          <SkeletonFicha />
          {/* Reserva la columna de la TOC en `lg+` para que el artículo no salte al cargar. */}
          <div aria-hidden="true" className="hidden h-40 lg:block" style={{ background: 'var(--flit-border-soft)', borderRadius: 8 }} />
        </div>
      </div>
    );
  }

  if (estado === 'error') {
    return (
      <div className="space-y-4">
        {header(true)}
        <ErrorAyuda titulo="No se pudo cargar esta ficha." onReintentar={reintentar} volver />
      </div>
    );
  }

  if (!fuente) {
    return (
      <div className="space-y-4">
        {header(true)}
        <FlitEmpty>
          <p className="text-base font-semibold" style={{ color: 'var(--flit-text-primary)' }}>Esta ficha está pendiente.</p>
          <p className="mx-auto mt-2 max-w-lg">
            La ficha ya figura en el índice; el contenido se publicará en una entrega siguiente. No es un error.
          </p>
          <Link to="/flito/ayuda" className={`${flitBtnSecondary} mt-4`} style={flitBtnSecondaryStyle}>Volver al índice</Link>
        </FlitEmpty>
        <AnteriorSiguiente {...vecinas} />
      </div>
    );
  }

  const conTabla = fichaConTabla(secciones);
  const articulo = (
    <FlitCard>
      <div data-ayuda-cuerpo>
        {fuente.encabezado && (
          <p className="mb-4 text-xs" style={{ color: 'var(--flit-text-secondary)' }} data-testid="ayuda-ficha-version">
            Versión {fuente.encabezado.version} · {fechaFichaLegible(fuente.encabezado.fecha)}
          </p>
        )}
        <AyudaMarkdown bloques={bloques} puedeEnlazar={enlazar} label={entrada.etiqueta} />
      </div>
      <AyudaAplicaPara entrada={entrada} />
    </FlitCard>
  );

  return (
    <div className="space-y-4">
      {header(true)}
      {conTabla ? (
        <div className="space-y-4 lg:grid lg:grid-cols-[minmax(0,1fr)_15rem] lg:items-start lg:gap-6 lg:space-y-0">
          <TablaContenidoPlegable secciones={secciones} actual={ancla} />
          <div className="min-w-0">{articulo}</div>
          <TablaContenidoLateral secciones={secciones} actual={ancla} />
        </div>
      ) : articulo}
      <AnteriorSiguiente {...vecinas} />
    </div>
  );
}

function VolverIndice() {
  return (
    <Link
      to="/flito/ayuda"
      className="flit-focus text-sm font-medium"
      style={{ color: 'var(--flit-blue-ink)' }}
    >
      ← Volver al índice
    </Link>
  );
}

const tarjetaVecina = {
  borderRadius: 'var(--flit-radius-card)',
  border: '1px solid var(--flit-border-soft)',
  background: 'var(--flit-bg-card)',
} as const;

function EnlaceVecina({ entrada, lado }: { entrada: EntradaAyuda; lado: 'anterior' | 'siguiente' }) {
  const siguiente = lado === 'siguiente';
  return (
    <Link
      to={`/flito/ayuda/${entrada.clave}`}
      aria-label={`${siguiente ? 'Ficha siguiente' : 'Ficha anterior'}: ${entrada.etiqueta}`}
      className={`flit-focus block min-w-0 px-4 py-3 transition-colors hover:bg-[color:var(--flit-bg-hover)] sm:w-1/2${siguiente ? ' sm:ml-auto sm:text-right' : ''}`}
      style={tarjetaVecina}
      data-testid={`ayuda-ficha-${lado}`}
    >
      <span className="block text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
        {siguiente ? <>Siguiente <span aria-hidden="true">→</span></> : <><span aria-hidden="true">←</span> Anterior</>}
      </span>
      <span className="mt-0.5 block break-words text-sm font-semibold" style={{ color: 'var(--flit-blue-text)' }}>
        {GRUPO_AYUDA_LABEL[entrada.grupo]} · {entrada.etiqueta}
      </span>
    </Link>
  );
}

/** Anterior/Siguiente en el orden del índice, solo fichas visibles (AC5). Se apilan bajo `sm`. */
function AnteriorSiguiente({ anterior, siguiente }: { anterior?: EntradaAyuda; siguiente?: EntradaAyuda }) {
  if (!anterior && !siguiente) return null;
  return (
    <nav aria-label="Navegación entre fichas" className="flex flex-col gap-3 sm:flex-row">
      {anterior && <EnlaceVecina entrada={anterior} lado="anterior" />}
      {siguiente && <EnlaceVecina entrada={siguiente} lado="siguiente" />}
    </nav>
  );
}
