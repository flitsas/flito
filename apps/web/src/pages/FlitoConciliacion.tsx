// FLITO — Conciliación · bandeja de boletas (Feature #11623, HU #11680).
//
// Financiera paga en el portal externo una boleta que agrupa varios SOAT de un mismo cliente,
// descarga el Excel y lo carga aquí: FLITO lo cruza por número de póliza contra los SOAT pagados y,
// **solo si todo cuadra**, se concilia y sale el dinero de las bolsas. Esta pantalla es la lista; el
// cuadre vive en `/flito/conciliacion/:boletaId`, en ruta propia y no en un modal, porque el reporte
// de costos tiene que poder enlazar a una boleta y un modal no es enlazable.
//
// **El gate de rol va aquí, antes del `useEffect`**, y no solo en `ProtectedRoute`: con el slug
// concedido a mano a un rol que la API no admite, la pantalla cargaría para soltar un 403 en vez de
// decir que no hay acceso — que es exactamente lo que el AC1 prohíbe. Espejo de `puedeVerBolsas`.
//
// Dentro **no hay modo lectura**: quien entra, puede todo. `admin` y `financiera` y nadie más, así
// que cualquier condicional por rol dentro de estos componentes sería código muerto que un día miente.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { EstadoBoleta, type BoletaDetalleDto, type BoletaListadoDto } from '@operaciones/shared-types';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { puedeConciliar } from '../lib/conciliacion';
import NoAccess from '../components/NoAccess';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import PageContentSkeleton from '../components/flit/PageContentSkeleton';
import RangoFechas from '../components/flit/RangoFechas';
import FlitSelect from '../components/flit/FlitSelect';
import BandejaBoletas from '../components/flito/conciliacion/BandejaBoletas';
import CargarBoletaModal, { type ClienteOpcion } from '../components/flito/conciliacion/CargarBoletaModal';
import {
  FlitCard, FlitEmpty, FlitPillButton, FlitPillGroup,
  flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle,
} from '../components/flit/flitPageKit';

export default function FlitoConciliacion() {
  const { user } = useAuth();
  if (!puedeConciliar(user?.role)) return <NoAccess page="flito_conciliacion" />;
  return <Conciliacion />;
}

interface Filtros {
  companiaId: string;
  estado: '' | EstadoBoleta;
  desde: string;
  hasta: string;
}

const SIN_FILTROS: Filtros = { companiaId: '', estado: '', desde: '', hasta: '' };

const ESTADOS: { valor: Filtros['estado']; etiqueta: string }[] = [
  { valor: '', etiqueta: 'Todas' },
  { valor: EstadoBoleta.CARGADA, etiqueta: 'Por conciliar' },
  { valor: EstadoBoleta.CONCILIADA, etiqueta: 'Conciliadas' },
  { valor: EstadoBoleta.DESCARTADA, etiqueta: 'Descartadas' },
];

function Conciliacion() {
  const navigate = useNavigate();
  const [filtros, setFiltros] = useState<Filtros>(SIN_FILTROS);
  // Pila de cursores: `null` es la primera página. El API pagina por cursor y no devuelve totales,
  // así que «Anterior» es desapilar y no restar uno a un número que nadie tiene.
  const [cursores, setCursores] = useState<(string | null)[]>([null]);
  const [listado, setListado] = useState<BoletaListadoDto | null>(null);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [cargandoBoleta, setCargandoBoleta] = useState(false);
  const [enfocarTabla, setEnfocarTabla] = useState(false);
  const tablaRef = useRef<HTMLDivElement>(null);

  const [clientes, setClientes] = useState<ClienteOpcion[] | null>(null);
  const [falloClientes, setFalloClientes] = useState(false);
  const [nonceClientes, setNonceClientes] = useState(0);

  const cursor = cursores[cursores.length - 1];

  useEffect(() => {
    let vivo = true;
    setFalloClientes(false);
    api.get<ClienteOpcion[]>('/clients')
      .then((c) => { if (vivo) setClientes(Array.isArray(c) ? c.map((x) => ({ id: x.id, name: x.name })) : []); })
      // Sin la lista de clientes se pierde el filtro por cliente, no la pantalla: las boletas se
      // siguen listando y su detalle sigue accesible.
      .catch(() => { if (vivo) { setClientes([]); setFalloClientes(true); } });
    return () => { vivo = false; };
  }, [nonceClientes]);

  useEffect(() => {
    let vivo = true;
    setCargando(true);
    setError(null);
    // Los cuatro filtros van en la query porque NINGUNO es PII: id de cliente, estado y dos fechas.
    // La póliza y la placa no son filtros de este endpoint y no pueden serlo (AGENTS.md 14).
    const q = new URLSearchParams();
    if (filtros.companiaId) q.set('companiaId', filtros.companiaId);
    if (filtros.estado) q.set('estado', filtros.estado);
    if (filtros.desde) q.set('desde', filtros.desde);
    if (filtros.hasta) q.set('hasta', filtros.hasta);
    if (cursor) q.set('cursor', cursor);
    api.get<BoletaListadoDto>(`/flito/conciliacion/boletas?${q.toString()}`)
      .then((r) => { if (vivo) setListado(r); })
      .catch((e) => { if (vivo) { setError(errorMessage(e)); setListado(null); } })
      .finally(() => { if (vivo) setCargando(false); });
    return () => { vivo = false; };
  }, [filtros, cursor, nonce]);

  // El foco a la tabla se mueve cuando la lista YA está pintada: hacerlo en el mismo clic lo pondría
  // sobre el contenido viejo.
  useEffect(() => {
    if (enfocarTabla && !cargando && listado) {
      tablaRef.current?.focus();
      setEnfocarTabla(false);
    }
  }, [enfocarTabla, cargando, listado]);

  /** Cambiar cualquier criterio descarta la pila entera: los cursores son de la lista anterior. */
  const cambiarFiltros = useCallback((cambio: Partial<Filtros>) => {
    setFiltros((f) => ({ ...f, ...cambio }));
    setCursores([null]);
  }, []);

  const hayFiltros = filtros.companiaId !== '' || filtros.estado !== ''
    || filtros.desde !== '' || filtros.hasta !== '';

  function limpiarFiltros(): void {
    // Limpiar de verdad: se resetea el estado Y se vuelve a pedir la lista. Es el bug #11648, que ya
    // se rompió una vez pintando el vacío sin quitar los filtros.
    setFiltros(SIN_FILTROS);
    setCursores([null]);
    setNonce((n) => n + 1);
  }

  function alCargar(boleta: BoletaDetalleDto): void {
    setCargandoBoleta(false);
    // El cuadre ya viene resuelto en la respuesta de la carga: se navega al detalle con el foco
    // puesto en su <h1>, en vez de dejarlo en el <body> del documento nuevo.
    navigate(`/flito/conciliacion/${boleta.id}`, {
      state: { desdeCarga: true, filasOmitidas: boleta.filasOmitidas },
    });
  }

  const acciones = (
    <button
      type="button"
      className={flitBtnPrimary}
      style={flitBtnPrimaryStyle}
      onClick={() => setCargandoBoleta(true)}
    >
      + Cargar boleta
    </button>
  );

  return (
    <div className="space-y-4">
      <PageHeaderCard
        title="Conciliación"
        subtitle={'Las boletas que la financiera pagó en el portal SOAT, cruzadas contra los SOAT de '
          + 'FLITO. Cargar una boleta no mueve dinero: eso pasa al conciliarla.'}
        actions={acciones}
      />

      <FlitCard>
        <div className="flex flex-wrap items-end gap-4">
          <div className="w-[240px]">
            <FlitSelect
              label="Cliente"
              value={filtros.companiaId}
              opciones={[
                { valor: '', etiqueta: 'Todos los clientes' },
                ...(clientes ?? []).map((c) => ({ valor: String(c.id), etiqueta: c.name })),
              ]}
              onChange={(v) => cambiarFiltros({ companiaId: v })}
              disabled={clientes === null || falloClientes}
              mensaje={falloClientes ? 'No se pudo cargar la lista de clientes.' : null}
              fallo={falloClientes}
              onReintentar={falloClientes ? () => { setClientes(null); setNonceClientes((n) => n + 1); } : undefined}
              textoReintento="Reintentar los clientes"
            />
          </div>

          <FlitPillGroup label="Estado de la boleta">
            {ESTADOS.map((e) => (
              <FlitPillButton
                key={e.valor || 'todas'}
                active={filtros.estado === e.valor}
                pressed={filtros.estado === e.valor}
                onClick={() => cambiarFiltros({ estado: e.valor })}
              >
                {e.etiqueta}
              </FlitPillButton>
            ))}
          </FlitPillGroup>

          <RangoFechas
            etiqueta="Pagadas entre"
            valor={{ desde: filtros.desde, hasta: filtros.hasta }}
            onCambio={(r) => cambiarFiltros({ desde: r.desde, hasta: r.hasta })}
          />

          {hayFiltros && (
            <button
              type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle}
              onClick={limpiarFiltros}
            >
              Limpiar filtros
            </button>
          )}
        </div>
      </FlitCard>

      {cargando && <PageContentSkeleton />}

      {!cargando && error && (
        <FlitCard>
          <p className="text-sm font-semibold" style={{ color: 'var(--flit-danger-ink)' }}>
            No se pudo cargar la lista de boletas.
          </p>
          <p className="mt-1 text-sm" style={{ color: 'var(--flit-text-secondary)' }}>{error}</p>
          <button
            type="button" className={`${flitBtnSecondary} mt-3`} style={flitBtnSecondaryStyle}
            onClick={() => setNonce((n) => n + 1)}
          >
            Reintentar
          </button>
        </FlitCard>
      )}

      {!cargando && !error && listado && listado.items.length === 0 && (
        <FlitEmpty>
          {hayFiltros ? (
            <>
              <p className="text-base font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
                Ninguna boleta con los filtros puestos.
              </p>
              <p className="mx-auto mt-2 max-w-lg">
                Prueba con otro cliente, otro estado o un rango de fechas más amplio.
              </p>
              <button
                type="button" className={`${flitBtnSecondary} mt-4`} style={flitBtnSecondaryStyle}
                onClick={limpiarFiltros}
              >
                Limpiar filtros
              </button>
            </>
          ) : (
            <>
              <p className="text-base font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
                Todavía no hay boletas cargadas.
              </p>
              <p className="mx-auto mt-2 max-w-xl">
                Cuando la financiera pague una boleta en el portal SOAT, descarga el Excel y cárgalo
                aquí: FLITO lo cruza con los SOAT del cliente y te dice qué cuadra y qué no.
              </p>
              <button
                type="button" className={`${flitBtnPrimary} mt-4`} style={flitBtnPrimaryStyle}
                onClick={() => setCargandoBoleta(true)}
              >
                Cargar boleta
              </button>
            </>
          )}
        </FlitEmpty>
      )}

      {!cargando && !error && listado && listado.items.length > 0 && (
        <BandejaBoletas
          items={listado.items}
          parcial={listado.siguienteCursor !== null || cursores.length > 1}
          pagina={cursores.length}
          hayAnterior={cursores.length > 1}
          haySiguiente={listado.siguienteCursor !== null}
          onAnterior={() => setCursores((c) => c.slice(0, -1))}
          onSiguiente={() => setCursores((c) => [...c, listado.siguienteCursor])}
          onRevisar={() => { cambiarFiltros({ estado: EstadoBoleta.CARGADA }); setEnfocarTabla(true); }}
          tablaRef={tablaRef}
        />
      )}

      {cargandoBoleta && (
        <CargarBoletaModal
          clientes={clientes}
          falloClientes={falloClientes}
          onReintentarClientes={() => { setClientes(null); setNonceClientes((n) => n + 1); }}
          onCerrar={() => setCargandoBoleta(false)}
          onCargada={alCargar}
          onVerBoleta={(id) => { setCargandoBoleta(false); navigate(`/flito/conciliacion/${id}`); }}
        />
      )}
    </div>
  );
}
