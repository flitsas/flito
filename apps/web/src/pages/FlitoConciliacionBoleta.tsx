// FLITO — Conciliación · el cuadre de una boleta (Feature #11623, HU #11680).
//
// **Esta es la pantalla del Feature**; todo lo demás la rodea. Vive en ruta propia y no en un modal
// porque el reporte de costos tiene que poder enlazar a una boleta, y un modal no es enlazable. El
// identificador del path es un uuid OPACO: ni la póliza ni la placa aparecen jamás en la URL, ni en
// el path ni en la query (AC7). Tampoco en el `document.title`, que lleva la referencia.
//
// El gate de rol va **antes del `useEffect` que pide la boleta**, y ese es todo el sentido de que
// esté aquí y no solo en `ProtectedRoute`: entrar por el enlace profundo con un rol equivocado
// dispararía el `GET /boletas/:id` y devolvería un 403 antes de que la ruta alcanzara a pintar
// `NoAccess`. El AC1 pide que no salga ni una petición.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  EstadoBoleta,
  type BoletaDetalleDto, type ComprobanteBoletaDto, type ConciliacionRealizadaDto,
} from '@operaciones/shared-types';
import { ApiError, api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fechaDia, pesos } from '../lib/bolsas';
import {
  ETIQUETA_ESTADO_BOLETA, TONO_ESTADO_BOLETA, avisoDeRespuesta, avisoReconstruido, guardarAviso,
  leerAviso, puedeConciliar, type AvisoConciliacion,
} from '../lib/conciliacion';
import NoAccess from '../components/NoAccess';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import PageContentSkeleton from '../components/flit/PageContentSkeleton';
import StatusChip from '../components/flit/StatusChip';
import AccionesBoleta from '../components/flito/conciliacion/AccionesBoleta';
import AvisoConciliada from '../components/flito/conciliacion/AvisoConciliada';
import BloqueConciliar from '../components/flito/conciliacion/BloqueConciliar';
import ComprobantePse from '../components/flito/conciliacion/ComprobantePse';
import TablaCuadre from '../components/flito/conciliacion/TablaCuadre';
import { FlitCard, flitBtnSecondary, flitBtnSecondaryStyle } from '../components/flit/flitPageKit';

const VOLVER = '/flito/conciliacion';

export default function FlitoConciliacionBoleta() {
  const { user } = useAuth();
  if (!user || !puedeConciliar(user.role)) return <NoAccess page="flito_conciliacion" />;
  // El id baja como prop —y no se vuelve a pedir con `useAuth` abajo— porque es lo que namespacia
  // el aviso guardado: sin usuario no hay pantalla, así que aquí ya está garantizado que existe.
  return <Boleta userId={user.id} />;
}

/** Lo que la bandeja deja dicho al navegar tras una carga: de dónde se viene y qué se ignoró. */
interface EstadoNavegacion {
  desdeCarga?: boolean;
  filasOmitidas?: number;
}

function Boleta({ userId }: { userId: number }) {
  const { boletaId = '' } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const traspaso = (location.state ?? {}) as EstadoNavegacion;

  const [boleta, setBoleta] = useState<BoletaDetalleDto | null>(null);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<{ mensaje: string; noExiste: boolean } | null>(null);
  const [nonce, setNonce] = useState(0);
  const [avisoFresco, setAvisoFresco] = useState<AvisoConciliacion | null>(null);
  const [enfocarAviso, setEnfocarAviso] = useState(false);
  const tituloRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    let vivo = true;
    setCargando(true);
    setError(null);
    api.get<BoletaDetalleDto>(`/flito/conciliacion/boletas/${boletaId}`)
      .then((b) => { if (vivo) setBoleta(b); })
      .catch((e) => {
        if (!vivo) return;
        setBoleta(null);
        // El 404 se distingue del 500 porque la salida es otra: reintentar un 404 no sirve de nada.
        setError({ mensaje: errorMessage(e), noExiste: e instanceof ApiError && e.status === 404 });
      })
      .finally(() => { if (vivo) setCargando(false); });
    return () => { vivo = false; };
  }, [boletaId, nonce]);

  // El título del documento lleva la REFERENCIA de la boleta, nunca una placa ni una póliza: es lo
  // que queda por escrito en el historial del navegador (AC7).
  useEffect(() => {
    if (!boleta) return undefined;
    const anterior = document.title;
    document.title = `${boleta.referencia} · Conciliación`;
    return () => { document.title = anterior; };
  }, [boleta]);

  // Al llegar desde la carga, el foco va al <h1> del cuadre. Sin esto se queda en el <body> del
  // documento nuevo y quien navega con teclado vuelve a empezar por la barra de navegación.
  useEffect(() => {
    if (traspaso.desdeCarga && boleta) tituloRef.current?.focus();
  }, [traspaso.desdeCarga, boleta]);

  /**
   * El aviso del AC5, por orden de fiabilidad: el de esta conciliación, el que quedó guardado en la
   * pestaña (para que sobreviva a una recarga) y, en último lugar, el reconstruido del detalle —que
   * dice cuántos SOAT y por cuánto, y calla los saldos porque el detalle no los trae—.
   */
  const aviso = useMemo(() => {
    if (!boleta || boleta.estado !== EstadoBoleta.CONCILIADA) return null;
    return avisoFresco ?? leerAviso(userId, boleta.id) ?? avisoReconstruido(boleta);
  }, [boleta, avisoFresco, userId]);

  if (cargando) return <PageContentSkeleton />;

  if (error || !boleta) {
    return (
      <div className="space-y-4">
        <VolverALaBandeja />
        <FlitCard>
          <p className="text-sm font-semibold" style={{ color: 'var(--flit-danger-ink)' }}>
            {error?.noExiste ? 'Esa boleta no existe o se descartó.' : 'No se pudo cargar la boleta.'}
          </p>
          {!error?.noExiste && error && (
            <p className="mt-1 text-sm" style={{ color: 'var(--flit-text-secondary)' }}>{error.mensaje}</p>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            {/* Reintentar un 404 no sirve de nada, así que ahí no está. Lo que sí está siempre es la
                salida: sin ella, un 500 persistente deja al usuario encerrado en una URL que no carga. */}
            {!error?.noExiste && (
              <button
                type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle}
                onClick={() => setNonce((n) => n + 1)}
              >
                Reintentar
              </button>
            )}
            <Link to={VOLVER} className={flitBtnSecondary} style={flitBtnSecondaryStyle}>
              Volver a Conciliación
            </Link>
          </div>
        </FlitCard>
      </div>
    );
  }

  const cargada = boleta.estado === EstadoBoleta.CARGADA;

  function alConciliar(resultado: ConciliacionRealizadaDto): void {
    const nuevo = avisoDeRespuesta(resultado);
    // Se guarda ANTES de pintar: si la pestaña se recarga en el instante siguiente, el aviso sigue
    // ahí con sus cifras (AC5). Solo conteos e importes — ni una placa, ni una póliza.
    guardarAviso(userId, resultado.boleta.id, nuevo);
    setBoleta(resultado.boleta);
    setAvisoFresco(nuevo);
    setEnfocarAviso(true);
  }

  return (
    <div className="space-y-4">
      <VolverALaBandeja />

      <PageHeaderCard
        titleRef={tituloRef}
        title={`${boleta.referencia} · ${boleta.companiaNombre ?? 'Cliente sin nombre'}`}
        subtitle={`Pagada el ${fechaDia(boleta.fechaPago)} · ${boleta.filas === 1 ? '1 línea' : `${boleta.filas} líneas`} `
          + `· ${pesos(boleta.totalDeclarado)} · cargada por ${boleta.cargadaPorNombre}`}
        leading={
          <StatusChip tone={TONO_ESTADO_BOLETA[boleta.estado]}>
            {ETIQUETA_ESTADO_BOLETA[boleta.estado]}
          </StatusChip>
        }
        actions={cargada ? (
          <AccionesBoleta
            boletaId={boleta.id}
            onCuadreActualizado={setBoleta}
            onDescartada={() => navigate(VOLVER)}
          />
        ) : undefined}
      />

      {/* Una fila del Excel sin número de póliza —típicamente la de totales que algunas descargas
          añaden al final— se ignora, y se dice: una fila ignorada que SÍ era un pago cambia el total
          declarado, y quien acaba de cargar tiene que poder verlo. */}
      {traspaso.filasOmitidas ? (
        <FlitCard>
          <p className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
            {traspaso.filasOmitidas === 1
              ? 'Se ignoró 1 fila del Excel porque no traía número de póliza.'
              : `Se ignoraron ${traspaso.filasOmitidas} filas del Excel porque no traían número de póliza.`}
            {' Suele ser la fila de totales del portal; si no lo era, el total de la boleta se queda corto.'}
          </p>
        </FlitCard>
      ) : null}

      {boleta.estado === EstadoBoleta.DESCARTADA && (
        <FlitCard>
          <p className="text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
            Esta boleta está descartada.
          </p>
          <p className="mt-1 text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
            No se descontó nada de ninguna bolsa. Su archivo se puede volver a cargar desde la bandeja.
          </p>
        </FlitCard>
      )}

      {aviso && <AvisoConciliada aviso={aviso} boleta={boleta} enfocar={enfocarAviso} />}

      {cargada && (
        <BloqueConciliar
          boleta={boleta}
          onCuadreActualizado={setBoleta}
          onConciliada={alConciliar}
          focoDeRespaldo={tituloRef}
        />
      )}

      <TablaCuadre boleta={boleta} />

      <ComprobantePse
        boleta={boleta}
        onComprobante={(c: ComprobanteBoletaDto) => setBoleta((b) => (b ? { ...b, comprobante: c } : b))}
      />
    </div>
  );
}

function VolverALaBandeja() {
  return (
    <Link
      to={VOLVER}
      className="flit-focus inline-flex items-center text-sm font-medium"
      style={{ color: 'var(--flit-blue-text)' }}
    >
      ‹ Volver a Conciliación
    </Link>
  );
}
