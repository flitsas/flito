// Ayuda FLITO (HU #11893): índice por permiso y superficie de ficha.
// El gate de ruta vive en App.tsx (`AyudaFlitoGate`), no `ProtectedRoute page="flito_ayuda"`.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import {
  capitulosVisibles,
  entradaAyudaPorClave,
  puedeEnlazarFichaAyuda,
  puedeVerEntradaAyuda,
} from '../lib/ayudaFlito';
import { existeFichaMd, leerFichaMd, verificarBundleAyuda } from '../content/ayuda/cargarFichas';
import { GRUPO_AYUDA_LABEL, type AyudaGrupo, type EntradaAyuda } from '../content/ayuda/catalogo';
import NoAccess from '../components/NoAccess';
import AyudaMarkdown from '../components/ayuda/AyudaMarkdown';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import PageContentSkeleton from '../components/flit/PageContentSkeleton';
import StatusChip from '../components/flit/StatusChip';
import { FlitCard, FlitEmpty, flitBtnSecondary, flitBtnSecondaryStyle } from '../components/flit/flitPageKit';
import { isValidPage } from '../lib/permissions';

const GRUPOS_ORDEN: AyudaGrupo[] = ['gestion', 'finanzas', 'administracion'];
type EstadoCarga = 'cargando' | 'error' | 'listo';

function SkeletonFicha() {
  const bar = (w: string) => ({ background: 'var(--flit-border-soft)', borderRadius: 8, width: w, height: 12 });
  return (
    <div aria-busy="true" aria-label="Cargando ficha" role="status" className="animate-pulse motion-reduce:animate-none">
      <FlitCard>
        <div className="space-y-3">
          <div style={bar('35%')} />
          <div style={bar('90%')} />
          <div style={bar('75%')} />
          <div style={bar('60%')} />
        </div>
      </FlitCard>
    </div>
  );
}

function ErrorAyuda(
  { titulo, detalle, onReintentar, volver }: {
    titulo: string;
    detalle: string;
    onReintentar: () => void;
    volver?: boolean;
  },
) {
  return (
    <FlitCard>
      <div role="alert">
        <h2 className="text-base font-semibold" style={{ color: 'var(--flit-danger-ink)' }}>{titulo}</h2>
        <p className="mt-2 text-sm" style={{ color: 'var(--flit-text-secondary)' }}>{detalle}</p>
        <div className="mt-4 flex flex-wrap gap-3">
          <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={onReintentar}>
            Reintentar
          </button>
          {volver && (
            <Link to="/flito/ayuda" className={flitBtnSecondary} style={flitBtnSecondaryStyle}>
              Volver al índice
            </Link>
          )}
        </div>
      </div>
    </FlitCard>
  );
}

export default function FlitoAyuda() {
  const { slug } = useParams<{ slug?: string }>();
  if (slug) return <Ficha slug={slug} />;
  return <Indice />;
}

function Indice() {
  const { user } = useAuth();
  const [estado, setEstado] = useState<EstadoCarga>('cargando');
  const [error, setError] = useState('');
  const [nonce, setNonce] = useState(0);
  const [presentes, setPresentes] = useState<ReadonlySet<string>>(new Set());

  const capitulos = useMemo(() => capitulosVisibles(user), [user]);

  useEffect(() => {
    let cancel = false;
    setEstado('cargando');
    setError('');
    verificarBundleAyuda()
      .then(() => {
        if (cancel) return;
        setPresentes(new Set(capitulos.filter((c) => existeFichaMd(c.clave)).map((c) => c.clave)));
        setEstado('listo');
      })
      .catch((e) => {
        if (cancel) return;
        setError(errorMessage(e));
        setEstado('error');
      });
    return () => { cancel = true; };
  }, [nonce, capitulos]);

  const reintentar = useCallback(() => setNonce((n) => n + 1), []);

  const agrupados = useMemo(() => GRUPOS_ORDEN
    .map((grupo) => ({ grupo, items: capitulos.filter((c) => c.grupo === grupo) }))
    .filter((g) => g.items.length > 0), [capitulos]);

  if (estado === 'cargando') {
    return (
      <div className="space-y-4">
        <PageHeaderCard title="Ayuda FLITO" subtitle="Guías de las pantallas que usted ya puede abrir." />
        <PageContentSkeleton />
      </div>
    );
  }

  if (estado === 'error') {
    return (
      <div className="space-y-4">
        <PageHeaderCard title="Ayuda FLITO" subtitle="Guías de las pantallas que usted ya puede abrir." />
        <ErrorAyuda titulo="No se pudo cargar el índice de ayuda." detalle={error} onReintentar={reintentar} />
      </div>
    );
  }

  if (capitulos.length === 0) {
    return (
      <div className="space-y-4">
        <PageHeaderCard title="Ayuda FLITO" subtitle="Guías de las pantallas que usted ya puede abrir." />
        <FlitEmpty>
          <p className="text-base font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
            No hay capítulos de ayuda para las pantallas que usted puede abrir.
          </p>
          <p className="mx-auto mt-2 max-w-lg">
            Si cree que debería ver una guía, pídale a un administrador que le habilite esa pantalla. La ayuda no se concede aparte.
          </p>
          <Link to="/" className={`${flitBtnSecondary} mt-4`} style={flitBtnSecondaryStyle}>Volver al tablero</Link>
        </FlitEmpty>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeaderCard title="Ayuda FLITO" subtitle="Guías de las pantallas que usted ya puede abrir." />
      <nav aria-label="Capítulos de ayuda" className="space-y-6">
        {agrupados.map(({ grupo, items }) => (
          <section key={grupo} aria-labelledby={`ayuda-grupo-${grupo}`}>
            <h2
              id={`ayuda-grupo-${grupo}`}
              className="mb-2 text-xs font-semibold uppercase tracking-[0.18em]"
              style={{ color: 'var(--flit-text-muted)' }}
            >
              {GRUPO_AYUDA_LABEL[grupo]}
            </h2>
            <div
              className="overflow-hidden bg-white"
              style={{ borderRadius: 'var(--flit-radius-card)', border: '1px solid var(--flit-border-soft)', boxShadow: 'var(--flit-shadow-card)' }}
            >
              <ul>
                {items.map((entrada, idx) => (
                  <li key={entrada.clave} style={idx > 0 ? { borderTop: '1px solid var(--flit-border-soft)' } : undefined}>
                    <FilaCapitulo entrada={entrada} pendiente={!presentes.has(entrada.clave)} />
                  </li>
                ))}
              </ul>
            </div>
          </section>
        ))}
      </nav>
    </div>
  );
}

function FilaCapitulo({ entrada, pendiente }: { entrada: EntradaAyuda; pendiente: boolean }) {
  const nombre = pendiente ? `Ficha pendiente de ${entrada.etiqueta}` : `Abrir ficha de ${entrada.etiqueta}`;
  return (
    <Link
      to={`/flito/ayuda/${entrada.clave}`}
      aria-label={nombre}
      className="flit-focus flex items-center gap-3 px-5 py-4 transition-colors hover:bg-[color:var(--flit-bg-app)]"
    >
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold" style={{ color: 'var(--flit-blue-text)' }}>{entrada.etiqueta}</span>
        <span className="mt-0.5 block text-sm" style={{ color: 'var(--flit-text-secondary)' }}>{entrada.resumen}</span>
      </span>
      {pendiente && <StatusChip tone="active">Ficha pendiente</StatusChip>}
      <span aria-hidden="true" className="text-lg" style={{ color: 'var(--flit-text-muted)' }}>→</span>
    </Link>
  );
}

function Ficha({ slug }: { slug: string }) {
  const { user } = useAuth();
  const titleRef = useRef<HTMLHeadingElement>(null);
  const entrada = entradaAyudaPorClave(slug);
  const [estado, setEstado] = useState<EstadoCarga>('cargando');
  const [error, setError] = useState('');
  const [fuente, setFuente] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    titleRef.current?.focus();
  }, [slug, estado]);

  useEffect(() => {
    if (!entrada || !puedeVerEntradaAyuda(user, entrada)) return undefined;
    let cancel = false;
    setEstado('cargando');
    setError('');
    setFuente(null);
    leerFichaMd(entrada.clave)
      .then((md) => {
        if (cancel) return;
        setFuente(md);
        setEstado('listo');
      })
      .catch((e) => {
        if (cancel) return;
        setError(errorMessage(e));
        setEstado('error');
      });
    return () => { cancel = true; };
  }, [entrada, user, nonce]);

  const reintentar = useCallback(() => setNonce((n) => n + 1), []);
  const enlazar = useCallback((href: string) => puedeEnlazarFichaAyuda(user, href), [user]);

  if (!entrada) {
    return (
      <div className="space-y-4">
        <PageHeaderCard title="Ayuda FLITO" leading={<VolverIndice />} />
        <FlitEmpty>
          <p className="text-base font-semibold" style={{ color: 'var(--flit-text-primary)' }}>Esta ficha no existe.</p>
          <p className="mx-auto mt-2 max-w-lg">Ese capítulo no forma parte de la ayuda FLITO.</p>
          <Link to="/flito/ayuda" className={`${flitBtnSecondary} mt-4`} style={flitBtnSecondaryStyle}>Volver al índice</Link>
        </FlitEmpty>
      </div>
    );
  }

  if (!puedeVerEntradaAyuda(user, entrada)) {
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

  if (estado === 'cargando') {
    return (
      <div className="space-y-4">
        <PageHeaderCard title={entrada.etiqueta} subtitle={entrada.resumen} leading={<VolverIndice />} titleRef={titleRef} />
        <SkeletonFicha />
      </div>
    );
  }

  if (estado === 'error') {
    return (
      <div className="space-y-4">
        <PageHeaderCard title={entrada.etiqueta} subtitle={entrada.resumen} leading={<VolverIndice />} titleRef={titleRef} actions={irPantalla} />
        <ErrorAyuda titulo="No se pudo cargar esta ficha." detalle={error} onReintentar={reintentar} volver />
      </div>
    );
  }

  if (!fuente) {
    return (
      <div className="space-y-4">
        <PageHeaderCard title={entrada.etiqueta} subtitle={entrada.resumen} leading={<VolverIndice />} titleRef={titleRef} actions={irPantalla} />
        <FlitEmpty>
          <p className="text-base font-semibold" style={{ color: 'var(--flit-text-primary)' }}>Esta ficha está pendiente.</p>
          <p className="mx-auto mt-2 max-w-lg">
            El capítulo ya figura en el índice; el contenido se publicará en una entrega siguiente. No es un error.
          </p>
          <Link to="/flito/ayuda" className={`${flitBtnSecondary} mt-4`} style={flitBtnSecondaryStyle}>Volver al índice</Link>
        </FlitEmpty>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PageHeaderCard
        title={entrada.etiqueta}
        subtitle={entrada.resumen}
        leading={<VolverIndice />}
        titleRef={titleRef}
        actions={irPantalla}
      />
      <FlitCard>
        <AyudaMarkdown source={fuente} puedeEnlazar={enlazar} label={entrada.etiqueta} />
      </FlitCard>
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
