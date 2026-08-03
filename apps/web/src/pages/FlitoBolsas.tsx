// FLITO — Bolsas prepago (Feature #11120, HU #11127–#11130; reestructurado en la #11210).
//
// UNA sola vista. Antes eran tres pestañas —tablero, cliente y organismo— y ninguna contestaba sola
// la pregunta de Financiera: dónde hay que poner plata hoy. Ahora los KPI encabezan la pantalla y
// debajo van dos acordeones, clientes y tránsitos, con la misma anatomía de tarjeta; el detalle se
// abre en un modal por encima, para no perder el sitio al revisar uno tras otro.
//
// La página no pinta datos por su cuenta: coordina qué se está mirando y reparte. El extracto, la
// tendencia, el resumen del cierre y la tabla de movimientos salen TODOS del mismo libro, y pedirlos
// por separado sería arriesgarse a enseñar dos cifras distintas del mismo dinero.
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
import FlitModal from '../components/flit/FlitModal';
import { FlitCard, flitInp, flitBtnSecondary, flitBtnSecondaryStyle } from '../components/flit/flitPageKit';
import { type ClienteOpcion } from '../components/flito/BolsaAbrirCliente';
import BolsaAcciones from '../components/flito/BolsaAcciones';
import BolsaExtracto from '../components/flito/BolsaExtracto';
import BolsaMovimientos from '../components/flito/BolsaMovimientos';
import BolsaOrganismoDetalle, { nombreOrganismo } from '../components/flito/BolsaOrganismo';
import BolsasTablero from '../components/flito/BolsasTablero';

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
  const [periodo, setPeriodo] = useState(periodoActual);
  const [nonce, setNonce] = useState(0);
  const [clientes, setClientes] = useState<ClienteOpcion[]>([]);

  /** Cliente cuyo detalle está abierto en el modal. `null` = tablero a secas. */
  const [detalleCliente, setDetalleCliente] = useState<number | null>(null);
  /** Organismo cuyo detalle está abierto en el modal. */
  const [detalleOrganismo, setDetalleOrganismo] = useState<string | null>(null);

  const recargar = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    api.get<ClienteOpcion[]>('/clients')
      .then((c) => setClientes(Array.isArray(c) ? c.map((x) => ({ id: x.id, name: x.name })) : []))
      // Sin la lista de clientes se pierde el botón de abrir bolsa, no la pantalla: las bolsas ya
      // abiertas siguen listándose y su detalle sigue accesible.
      .catch(() => setClientes([]));
  }, []);

  return (
    <div className="space-y-4">
      <PageHeaderCard
        title="Bolsas prepago"
        subtitle="El saldo que cada cliente tiene precargado y el que FLIT mantiene en cada organismo."
      />

      <FlitCard>
        <div className="flex flex-wrap items-end gap-4">
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
          <p className="pb-2 text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>
            Las entradas y salidas de las tarjetas de cliente, el desglose y el cierre son del periodo
            elegido. El saldo y las cifras de los organismos son siempre el acumulado.
          </p>
        </div>
      </FlitCard>

      <BolsasTablero
        periodo={periodo}
        clientes={clientes}
        nonce={nonce}
        onCambio={recargar}
        onVerCliente={setDetalleCliente}
        onVerOrganismo={setDetalleOrganismo}
      />

      {detalleCliente !== null && (
        <ModalDetalleCliente
          companiaId={detalleCliente}
          nombrePorDefecto={clientes.find((c) => c.id === detalleCliente)?.name ?? `Cliente ${detalleCliente}`}
          periodo={periodo}
          onClose={() => setDetalleCliente(null)}
          onCambio={recargar}
        />
      )}

      {detalleOrganismo !== null && (
        <FlitModal title={nombreOrganismo(detalleOrganismo)} onClose={() => setDetalleOrganismo(null)} full>
          <BolsaOrganismoDetalle codigo={detalleOrganismo} onCambio={recargar} />
        </FlitModal>
      )}
    </div>
  );
}

/**
 * Detalle de la bolsa de un cliente: extracto, acciones y libro.
 *
 * Trae sus propios datos y no los hereda del tablero a propósito: el tablero enseña el saldo y el
 * movimiento del mes, mientras que aquí hacen falta el extracto, los cierres y el libro completo, y
 * arrastrar todo eso por el tablero significaría pedirlo para clientes que nadie va a abrir.
 */
function ModalDetalleCliente({ companiaId, nombrePorDefecto, periodo, onClose, onCambio }: {
  companiaId: number;
  nombrePorDefecto: string;
  periodo: string;
  onClose: () => void;
  onCambio: () => void;
}) {
  /** Traer el libro entero en vez de solo el periodo. Solo afecta a la tabla de movimientos. */
  const [verTodo, setVerTodo] = useState(false);
  const [nonce, setNonce] = useState(0);
  const [bolsa, setBolsa] = useState<BolsaConRiesgo | null>(null);
  /** El cliente existe pero no tiene bolsa (404). No es un error: es una bolsa por abrir. */
  const [sinBolsa, setSinBolsa] = useState(false);
  const [extracto, setExtracto] = useState<ExtractoCliente | null>(null);
  const [movimientos, setMovimientos] = useState<MovimientoBolsaDto[] | null>(null);
  const [cierres, setCierres] = useState<CierreDto[]>([]);
  const [error, setError] = useState<string | null>(null);

  /** Refresca el modal Y el tablero: la recarga que se registre aquí cambia la tarjeta de allá. */
  const refrescar = useCallback(() => { setNonce((n) => n + 1); onCambio(); }, [onCambio]);

  useEffect(() => {
    let vigente = true;
    setError(null);
    setMovimientos(null);
    const q = verTodo ? '' : `?periodo=${periodo}`;

    Promise.all([
      // El 404 es la respuesta legítima de un cliente sin bolsa, no un fallo que deba tumbar la
      // vista: se traduce a `sinBolsa` y el resto del modal sigue funcionando.
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
      .catch((e) => { if (vigente) setError(errorMessage(e)); });

    return () => { vigente = false; };
  }, [companiaId, periodo, verTodo, nonce]);

  const nombre = bolsa?.companiaNombre ?? nombrePorDefecto;

  // El cierre y la corrección se razonan SOBRE EL PERIODO, aunque la tabla esté enseñando el libro
  // entero: confirmar un cierre con las cifras de todos los meses sería sellar un reporte falso.
  const delPeriodo = (movimientos ?? []).filter((m) => m.periodo === periodo);
  const periodoCerrado = cierres.some((c) => c.periodo === periodo);

  return (
    <FlitModal title={nombre} onClose={onClose} full>
      {error ? (
        <div>
          <p className="text-sm" style={{ color: 'var(--flit-danger)' }}>{error}</p>
          <button type="button" className={`${flitBtnSecondary} mt-3`} style={flitBtnSecondaryStyle}
            onClick={() => setNonce((n) => n + 1)}>
            Reintentar
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={verTodo} onChange={(e) => setVerTodo(e.target.checked)} />
            <span>Ver el libro completo (todos los periodos)</span>
          </label>

          {bolsa && (
            <BolsaExtracto bolsa={bolsa} extracto={extracto} movimientos={delPeriodo} periodo={periodo} />
          )}

          {sinBolsa && (
            <FlitCard>
              <h2 className="text-sm font-bold" style={{ color: 'var(--flit-blue-text)' }}>
                {nombre} todavía no tiene bolsa
              </h2>
              <p className="mt-1 text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
                La bolsa se abre sola con la primera recarga: registra el valor con su comprobante
                y desde ese momento cada trámite del cliente descuenta de este saldo.
              </p>
            </FlitCard>
          )}

          <BolsaAcciones
            companiaId={companiaId}
            companiaNombre={nombre}
            periodo={periodo}
            periodoCerrado={periodoCerrado}
            cierres={cierres}
            movimientos={delPeriodo}
            saldoActual={bolsa?.saldo ?? 0}
            onHecho={refrescar}
          />

          <BolsaMovimientos
            companiaNombre={nombre}
            periodo={periodo}
            todosLosPeriodos={verTodo}
            movimientos={movimientos}
            error={null}
            onReintentar={refrescar}
          />
        </div>
      )}
    </FlitModal>
  );
}
