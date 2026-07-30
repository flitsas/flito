// FLITO — Bolsas prepago (Feature #11120, HU #11127–#11130).
//
// Tres vistas de lo mismo, en pestañas: el tablero de todos los clientes, el detalle de uno y el
// estado de cuenta de un organismo. La página no pinta nada por su cuenta: coordina qué cliente y
// qué periodo se están mirando y reparte los datos, porque el extracto, la tendencia, el resumen del
// cierre y la tabla de movimientos salen TODOS del mismo libro y pedirlos por separado sería
// arriesgarse a enseñar dos cifras distintas del mismo dinero.
//
// El acceso está cerrado a Administración y Financiera, igual que el router de la API: aquí se ve el
// dinero del cliente y ni siquiera auditoría entra, a diferencia del resto de FLITO.

import { useCallback, useEffect, useState } from 'react';
import {
  type BolsaConRiesgo, type CierreDto, type ExtractoCliente, type MovimientoBolsaDto,
} from '@operaciones/shared-types';
import { ApiError, api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { etiquetaPeriodo, periodoActual, puedeVerBolsas, ultimosPeriodos } from '../lib/bolsas';
import NoAccess from '../components/NoAccess';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import {
  FlitCard, FlitEmpty, FlitPillButton, FlitPillGroup, flitInp,
  flitBtnSecondary, flitBtnSecondaryStyle,
} from '../components/flit/flitPageKit';
import BolsaAcciones from '../components/flito/BolsaAcciones';
import BolsaExtracto from '../components/flito/BolsaExtracto';
import BolsaMovimientos from '../components/flito/BolsaMovimientos';
import BolsaOrganismo from '../components/flito/BolsaOrganismo';
import BolsasTablero from '../components/flito/BolsasTablero';

type Tab = 'tablero' | 'cliente' | 'organismos';

/** Lo único que necesita el selector de cliente. `/clients` devuelve bastante más. */
interface ClienteOpcion {
  id: number;
  name: string;
}

/** Cuántos meses ofrece el selector de periodo. Un año cubre cualquier cierre que siga en disputa. */
const PERIODOS_OFRECIDOS = 12;

export default function FlitoBolsas() {
  const { user } = useAuth();
  // El gate va aquí y no solo en el router: con el permiso concedido a mano a un rol que la API no
  // admite, la pantalla cargaría para soltar seis 403 seguidos en vez de decir que no hay acceso.
  if (!puedeVerBolsas(user?.role)) return <NoAccess page="flito_bolsas" />;
  return <Bolsas />;
}

function Bolsas() {
  const [tab, setTab] = useState<Tab>('tablero');
  const [companiaId, setCompaniaId] = useState<number | null>(null);
  const [periodo, setPeriodo] = useState(periodoActual);
  /** Traer el libro entero en vez de solo el periodo. Solo afecta a la tabla de movimientos. */
  const [verTodo, setVerTodo] = useState(false);
  const [nonce, setNonce] = useState(0);

  const [clientes, setClientes] = useState<ClienteOpcion[]>([]);
  const [bolsa, setBolsa] = useState<BolsaConRiesgo | null>(null);
  /** El cliente existe pero no tiene bolsa (404). No es un error: es una bolsa por abrir. */
  const [sinBolsa, setSinBolsa] = useState(false);
  const [extracto, setExtracto] = useState<ExtractoCliente | null>(null);
  const [movimientos, setMovimientos] = useState<MovimientoBolsaDto[] | null>(null);
  const [cierres, setCierres] = useState<CierreDto[]>([]);
  const [errorCliente, setErrorCliente] = useState<string | null>(null);

  const recargar = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    api.get<ClienteOpcion[]>('/clients')
      .then((c) => setClientes(Array.isArray(c) ? c.map((x) => ({ id: x.id, name: x.name })) : []))
      // Sin la lista de clientes se pierde el selector, no la pantalla: desde el tablero se sigue
      // llegando al detalle de cualquier cliente que ya tenga bolsa.
      .catch(() => setClientes([]));
  }, []);

  useEffect(() => {
    if (companiaId === null) return;
    let vigente = true;
    setErrorCliente(null);
    setMovimientos(null);
    const q = verTodo ? '' : `?periodo=${periodo}`;

    Promise.all([
      // El 404 es la respuesta legítima de un cliente sin bolsa, no un fallo que deba tumbar la
      // vista: se traduce a `sinBolsa` y el resto de la pantalla sigue funcionando.
      api.get<BolsaConRiesgo>(`/flito/bolsas/${companiaId}`)
        .catch((e) => { if (e instanceof ApiError && e.status === 404) return null; throw e; }),
      api.get<ExtractoCliente>(`/flito/bolsas/${companiaId}/extracto?periodo=${periodo}`),
      api.get<MovimientoBolsaDto[]>(`/flito/bolsas/${companiaId}/movimientos${q}`),
      api.get<CierreDto[]>(`/flito/bolsas/${companiaId}/cierres`),
    ])
      .then(([b, e, m, c]) => {
        if (!vigente) return;
        setBolsa(b);
        setSinBolsa(b === null);
        setExtracto(e);
        setMovimientos(Array.isArray(m) ? m : []);
        setCierres(Array.isArray(c) ? c : []);
      })
      .catch((e) => { if (vigente) setErrorCliente(errorMessage(e)); });

    return () => { vigente = false; };
  }, [companiaId, periodo, verTodo, nonce]);

  const verCliente = (id: number) => { setCompaniaId(id); setTab('cliente'); };

  const nombreCliente = bolsa?.companiaNombre
    ?? clientes.find((c) => c.id === companiaId)?.name
    ?? (companiaId === null ? '' : `Cliente ${companiaId}`);

  // El cierre y la corrección se razonan SOBRE EL PERIODO, aunque la tabla esté enseñando el libro
  // entero: confirmar un cierre con las cifras de todos los meses sería sellar un reporte falso.
  const delPeriodo = (movimientos ?? []).filter((m) => m.periodo === periodo);
  const periodoCerrado = cierres.some((c) => c.periodo === periodo);

  return (
    <div className="space-y-4">
      <PageHeaderCard
        title="Bolsas prepago"
        subtitle="El saldo que cada cliente tiene precargado, en qué se va y qué le debemos a cada organismo."
      />

      <FlitPillGroup>
        <FlitPillButton active={tab === 'tablero'} onClick={() => setTab('tablero')}>Tablero</FlitPillButton>
        <FlitPillButton active={tab === 'cliente'} onClick={() => setTab('cliente')}>Cliente</FlitPillButton>
        <FlitPillButton active={tab === 'organismos'} onClick={() => setTab('organismos')}>Organismos</FlitPillButton>
      </FlitPillGroup>

      {tab === 'tablero' && <BolsasTablero periodo={periodo} onVerCliente={verCliente} />}

      {tab === 'cliente' && (
        <>
          <FlitCard>
            <div className="flex flex-wrap items-end gap-4">
              <label className="block min-w-[260px] flex-1">
                <span className="mb-1 block text-[11px] font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
                  Cliente
                </span>
                <select className={flitInp} value={companiaId ?? ''}
                  onChange={(e) => setCompaniaId(e.target.value === '' ? null : Number(e.target.value))}>
                  <option value="">Elige un cliente…</option>
                  {clientes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </label>

              <label className="block w-[200px]">
                <span className="mb-1 block text-[11px] font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
                  Periodo contable
                </span>
                <select className={flitInp} value={periodo} onChange={(e) => setPeriodo(e.target.value)}>
                  {ultimosPeriodos(PERIODOS_OFRECIDOS).map((p) => (
                    <option key={p} value={p}>{etiquetaPeriodo(p)}</option>
                  ))}
                </select>
              </label>

              <label className="flex items-center gap-2 pb-2 text-sm">
                <input type="checkbox" checked={verTodo} onChange={(e) => setVerTodo(e.target.checked)} />
                <span>Ver el libro completo</span>
              </label>
            </div>
            <p className="mt-2 text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>
              El desglose, la tendencia y el cierre son siempre del periodo elegido. «Ver el libro
              completo» solo amplía la tabla de movimientos, para rastrear algo que viene de atrás.
            </p>
          </FlitCard>

          {companiaId === null ? (
            <FlitCard>
              <FlitEmpty>
                Elige un cliente para ver su saldo, en qué se está consumiendo y su historial de
                movimientos. Desde el tablero también se llega con un clic.
              </FlitEmpty>
            </FlitCard>
          ) : errorCliente ? (
            <FlitCard>
              <p className="text-sm" style={{ color: 'var(--flit-danger)' }}>{errorCliente}</p>
              <button type="button" className={`${flitBtnSecondary} mt-3`} style={flitBtnSecondaryStyle}
                onClick={recargar}>
                Reintentar
              </button>
            </FlitCard>
          ) : (
            <>
              {bolsa && (
                <BolsaExtracto bolsa={bolsa} extracto={extracto} movimientos={delPeriodo} periodo={periodo} />
              )}

              {sinBolsa && (
                <FlitCard>
                  <h2 className="text-sm font-bold" style={{ color: 'var(--flit-blue-text)' }}>
                    {nombreCliente} todavía no tiene bolsa
                  </h2>
                  <p className="mt-1 text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
                    La bolsa se abre sola con la primera recarga: registra el valor con su comprobante
                    y desde ese momento cada trámite del cliente descuenta de este saldo.
                  </p>
                </FlitCard>
              )}

              <BolsaAcciones
                companiaId={companiaId}
                companiaNombre={nombreCliente}
                periodo={periodo}
                periodoCerrado={periodoCerrado}
                cierres={cierres}
                movimientos={delPeriodo}
                saldoActual={bolsa?.saldo ?? 0}
                onHecho={recargar}
              />

              <BolsaMovimientos
                companiaNombre={nombreCliente}
                periodo={periodo}
                todosLosPeriodos={verTodo}
                movimientos={movimientos}
                error={null}
                onReintentar={recargar}
              />
            </>
          )}
        </>
      )}

      {/* Los trámites del organismo llegan con `companiaId`; la lista de clientes que ya tiene la
          página los convierte en nombres, en vez de pedirla otra vez desde dentro. */}
      {tab === 'organismos' && <BolsaOrganismo clientes={clientes} />}
    </div>
  );
}
