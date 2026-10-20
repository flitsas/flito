// Ayuda FLITO (HU #11893): índice por permiso y superficie de ficha.
// El gate de ruta vive en App.tsx (`AyudaFlitoGate`), no `ProtectedRoute page="flito_ayuda"`.
// HU #13704: el índice y los estados viven en `components/ayuda/` (diseño slim §7).

import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import {
  entradaAyudaPorClave,
  puedeEnlazarFichaAyuda,
  puedeVerEntradaAyuda,
} from '../lib/ayudaFlito';
import { leerFichaParseada } from '../content/ayuda/cargarFichas';
import { fechaFichaLegible, type FichaParseada } from '../lib/ayudaFicha';
import { resumenDeEntrada } from '../lib/ayudaBusqueda';
import NoAccess from '../components/NoAccess';
import AyudaMarkdown from '../components/ayuda/AyudaMarkdown';
import AyudaIndice from '../components/ayuda/AyudaIndice';
import { ErrorAyuda, SkeletonFicha } from '../components/ayuda/AyudaEstados';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import {
  FlitCard, FlitEmpty, flitBtnSecondary, flitBtnSecondaryStyle,
} from '../components/flit/flitPageKit';
import { isValidPage } from '../lib/permissions';

type EstadoCarga = 'cargando' | 'error' | 'listo';

export default function FlitoAyuda() {
  const { slug } = useParams<{ slug?: string }>();
  if (slug) return <Ficha slug={slug} />;
  return <AyudaIndice />;
}

function Ficha({ slug }: { slug: string }) {
  const { user } = useAuth();
  const titleRef = useRef<HTMLHeadingElement>(null);
  const entrada = entradaAyudaPorClave(slug);
  const [estado, setEstado] = useState<EstadoCarga>('cargando');
  const [fuente, setFuente] = useState<FichaParseada | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    titleRef.current?.focus();
  }, [slug, estado]);

  useEffect(() => {
    if (!entrada || !puedeVerEntradaAyuda(user, entrada)) return undefined;
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
  }, [entrada, user, nonce]);

  const reintentar = useCallback(() => setNonce((n) => n + 1), []);
  const enlazar = useCallback((href: string) => puedeEnlazarFichaAyuda(user, href), [user]);
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
        <PageHeaderCard title={entrada.etiqueta} subtitle={resumen || undefined} leading={<VolverIndice />} titleRef={titleRef} />
        <SkeletonFicha />
      </div>
    );
  }

  if (estado === 'error') {
    return (
      <div className="space-y-4">
        <PageHeaderCard title={entrada.etiqueta} subtitle={resumen || undefined} leading={<VolverIndice />} titleRef={titleRef} actions={irPantalla} />
        <ErrorAyuda titulo="No se pudo cargar esta ficha." onReintentar={reintentar} volver />
      </div>
    );
  }

  if (!fuente) {
    return (
      <div className="space-y-4">
        <PageHeaderCard title={entrada.etiqueta} subtitle={resumen || undefined} leading={<VolverIndice />} titleRef={titleRef} actions={irPantalla} />
        <FlitEmpty>
          <p className="text-base font-semibold" style={{ color: 'var(--flit-text-primary)' }}>Esta ficha está pendiente.</p>
          <p className="mx-auto mt-2 max-w-lg">
            La ficha ya figura en el índice; el contenido se publicará en una entrega siguiente. No es un error.
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
        subtitle={resumen || undefined}
        leading={<VolverIndice />}
        titleRef={titleRef}
        actions={irPantalla}
      />
      <FlitCard>
        {fuente.encabezado && (
          <p className="mb-4 text-xs" style={{ color: 'var(--flit-text-secondary)' }} data-testid="ayuda-ficha-version">
            Versión {fuente.encabezado.version} · {fechaFichaLegible(fuente.encabezado.fecha)}
          </p>
        )}
        <AyudaMarkdown source={fuente.cuerpo} puedeEnlazar={enlazar} label={entrada.etiqueta} />
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
