// Servicios de la compañía en Clientes (HU #14105 sobre #13935/#13968/#14104).
//
// SOAT, Impuestos y Logística son los tres SERVICIOS y se leen igual: el interruptor dice «FLITO
// gestiona» (marcado = FLITO lo gestiona; el dato sigue siendo `*Autogestionable`, así que
// `gestiona = !dato`). En la lista van como un chip por servicio en una sola columna; en el modal de
// edición, como tres filas homogéneas.
//
// Logística encendida EXIGE proveedor (RN-PLOGC-1, lo valida también el servidor con 422). Al apagarla
// el proveedor NO se borra: se muestra en solo lectura y mientras esté asignado no se puede inactivar.
//
// «SOAT sin trámite» (#13968): solo el selector de proveedor, y solo con la función
// `parametrizacion.companias.soat_sin_tramite`; sin ella no aparece nada de eso (ni en el chip).
// «Parcial» ya no se muestra ni se envía (`logisticaPermiteParcial` no se toca).

import { useId, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { toastOk } from '../flit/ToastFlito';
import { api, ApiError } from '../../lib/api';
import FlitModal from '../flit/FlitModal';
import FlitSelect from '../flit/FlitSelect';
import FlitSwitch from '../flit/FlitSwitch';
import StatusChip from '../flit/StatusChip';
import GradientButton from '../flit/GradientButton';
import { opcionesConEstado } from '../flit/opcionesConEstado';
import {
  FlitPillGroup, FlitPillButton, flitBtnSecondary, flitBtnSecondaryStyle,
} from '../flit/flitPageKit';
import type { CatalogoProveedores } from '../../pages/users/AtaduraFields';
import FichaFiscal from './FichaFiscal';
import { useProveedoresLogistica } from './proveedoresDatos';

export interface Client {
  id: number; name: string; document: string | null; documentType: string | null;
  phone: string | null; email: string | null; address: string | null;
  city: string | null;
  /** HU #13948: el listado ya no trae eliminados; `false` = inactivo. */
  active: boolean;
  soatAutogestionable: boolean; impuestosAutogestionable: boolean; logisticaAutogestionable: boolean;
  /**
   * A qué gestor salen las solicitudes de «SOAT sin trámite», ya RESUELTO por `GET /clients`
   * (HU #12079). `null` = ninguno. `activo: false` = las solicitudes nuevas caen en la contingencia.
   */
  gestorSoatSinTramite: { id: string; nombre: string; activo: boolean } | null;
  /** HU #13967/#13968: la compañía no tiene proveedor y algún usuario ya tiene el permiso: sin efecto. */
  permisoSinTramiteSinEfecto?: boolean;
  /**
   * HU #14105: proveedor de logística. `GET /clients` aún no lo entrega; la web lo une desde
   * `GET /flito/parametrizacion/companias`. `undefined` = desconocido (no se marca nada); `null` = sin proveedor.
   */
  proveedorLogisticaId?: string | null;
}

/** Logística encendida (FLITO gestiona) y con proveedor CONOCIDAMENTE vacío. */
export const sinProveedorLogistica = (c: Client): boolean =>
  !c.logisticaAutogestionable && c.proveedorLogisticaId === null;

// ─────────── «SOAT sin trámite»: copy y lógica ya existentes (HU #12079 → #13968) ───────────
const PROVEEDOR_LABEL = 'Proveedor de SOAT sin trámite';
const PROVEEDOR_NINGUNO = 'Sin proveedor';
const PROVEEDOR_AYUDA = 'A este proveedor salen las solicitudes nuevas. Con «Sin proveedor», los usuarios de la compañía no pueden solicitar SOAT sin trámite. Las ya radicadas conservan su proveedor.';
const PROVEEDOR_CARGANDO = 'Cargando proveedores…';
const PROVEEDOR_ERROR = 'No se pudieron cargar los proveedores.';
const PROVEEDOR_VACIO = 'No hay proveedores de SOAT activos. Cree uno en la pestaña Proveedores.';
const PROVEEDOR_REINTENTO = 'Volver a cargar';
const AVISO_PERMISO_SIN_EFECTO = 'Tiene usuarios con permiso de SOAT sin trámite, pero no tiene proveedor elegido: el permiso no toma efecto hasta elegirlo.';
const ERROR_PROVEEDOR_NO_ACTIVO = 'Ese proveedor ya no está activo. Elija otro o «Sin proveedor».';
const ERROR_SIN_PERMISO = 'No tiene permiso para elegir el proveedor de esta compañía.';
const ERROR_GENERICO = 'No se pudo guardar el proveedor. Intente de nuevo en un momento.';
const ERROR_SIN_PERMISO_SERVICIOS = 'No tiene permiso para guardar estos cambios en esta compañía.';
const ERROR_GENERICO_SERVICIOS = 'No se pudieron guardar los cambios. Intente de nuevo en un momento.';
const TOAST_CON_PROVEEDOR = 'Proveedor de SOAT sin trámite actualizado. Las solicitudes ya radicadas conservan el suyo.';
const toastSinProveedor = (compania: string) =>
  `${compania} queda sin proveedor: sus usuarios no pueden solicitar SOAT sin trámite.`;

// ─────────── Logística ───────────
const LOG_LABEL = 'Proveedor de logística';
const LOG_REQUERIDO = 'Elija el proveedor que atenderá los viajes de esta compañía.';
const LOG_AYUDA_APAGADA = 'Sin logística de FLITO, la compañía se encarga de sus viajes y no tendrá viajes en FLITO.';
const LOG_VACIO_PUEDE = 'No hay proveedores de logística activos. Cree uno en la pestaña Proveedores.';
const LOG_VACIO_NO_PUEDE = 'No hay proveedores de logística activos. Pida a un administrador que cree uno.';
const LOG_ERROR = 'No pudimos cargar los proveedores de logística.';
const ERROR_LOG_NO_ACTIVO = 'Ese proveedor de logística ya no está activo. Elija otro.';

function mensajeErrorGuardado(err: unknown, enviaSoatSinTramite: boolean): string {
  const status = err instanceof ApiError ? err.status : 0;
  if (status === 403) return enviaSoatSinTramite ? ERROR_SIN_PERMISO : ERROR_SIN_PERMISO_SERVICIOS;
  if (status === 422) return ERROR_LOG_NO_ACTIVO;
  if ((status === 400 || status === 409) && enviaSoatSinTramite) return ERROR_PROVEEDOR_NO_ACTIVO;
  return enviaSoatSinTramite ? ERROR_GENERICO : ERROR_GENERICO_SERVICIOS;
}

/** Lo que la parte «SOAT sin trámite» del chip dice, en tono neutro: nombre, «(inactivo)» o «Sin proveedor». */
function textoCanal(c: Client): string {
  const g = c.gestorSoatSinTramite;
  if (!g) return PROVEEDOR_NINGUNO;
  return g.activo ? g.nombre : `${g.nombre} (inactivo)`;
}

// ───────────────────────────── Lista: un chip por servicio ─────────────────────────────

export function ChipsServicios({ c, nombreProveedorLogistica, editaSinTramite, puedeAbrir, onAbrir }: {
  c: Client; nombreProveedorLogistica: string | null; editaSinTramite: boolean; puedeAbrir: boolean; onAbrir: () => void;
}) {
  const gestiona = (autogestionable: boolean) => (autogestionable ? 'Autogestiona' : 'FLITO gestiona');
  const soat = `SOAT · ${gestiona(c.soatAutogestionable)}${editaSinTramite ? ` · Proveedor SOAT sin trámite: ${textoCanal(c)}` : ''}`;
  const sin = sinProveedorLogistica(c);
  const logistica = c.logisticaAutogestionable ? 'Logística · Autogestiona'
    : sin ? 'Logística · Sin proveedor'
      : `Logística · Proveedor: ${nombreProveedorLogistica ?? 'asignado'}`;
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label={`Servicios de ${c.name}`}>
      <li><StatusChip tone="neutral">{soat}</StatusChip></li>
      <li><StatusChip tone="neutral">{`Impuestos · ${gestiona(c.impuestosAutogestionable)}`}</StatusChip></li>
      <li>
        {sin && puedeAbrir ? (
          <button type="button" onClick={onAbrir} aria-label={`Logística de ${c.name}: sin proveedor. Elegir proveedor`}
            className="flit-focus rounded-full transition-colors hover:bg-[var(--flit-bg-hover)]">
            <StatusChip tone="warning">{logistica}</StatusChip>
          </button>
        ) : <StatusChip tone={sin ? 'warning' : 'neutral'}>{logistica}</StatusChip>}
      </li>
    </ul>
  );
}

// ───────────────────────────── Modal de edición ─────────────────────────────

type Pestana = 'servicios' | 'fiscales' | 'tarifas';

function FilaServicio({ titulo, etiqueta, checked, onToggle, disabled, children }: {
  titulo: string; etiqueta: string; checked: boolean; onToggle: (v: boolean) => void; disabled: boolean; children?: ReactNode;
}) {
  const id = useId();
  return (
    <div className="border-b py-3 last:border-b-0" style={{ borderColor: 'var(--flit-border-soft)' }}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>{titulo}</span>
        <span className="flex items-center gap-2">
          <span id={id} className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>FLITO gestiona</span>
          {disabled
            ? <span className="px-2 text-sm font-medium" style={{ color: 'var(--flit-text-primary)' }}>{checked ? 'Sí' : 'No'}</span>
            : <FlitSwitch checked={checked} onToggle={onToggle} etiqueta={etiqueta} />}
        </span>
      </div>
      {children && <div className="mt-2 space-y-3">{children}</div>}
    </div>
  );
}

export function ModalCliente({ cliente, editaAutogestion, editaSinTramite, puedeCrearProveedor, veTarifas, editable, proveedoresSoat, onClose, onGuardado, onFiscalGuardado }: {
  cliente: Client; editaAutogestion: boolean; editaSinTramite: boolean; puedeCrearProveedor: boolean; veTarifas: boolean;
  editable: boolean; proveedoresSoat: CatalogoProveedores; onClose: () => void; onGuardado: () => void; onFiscalGuardado: () => void;
}) {
  const idAviso = useId();
  const [pestana, setPestana] = useState<Pestana>('servicios');
  const [soat, setSoat] = useState(!cliente.soatAutogestionable);
  const [impuestos, setImpuestos] = useState(!cliente.impuestosAutogestionable);
  const [logistica, setLogistica] = useState(!cliente.logisticaAutogestionable);
  const actualLog = cliente.proveedorLogisticaId ?? '';
  const [provLog, setProvLog] = useState(actualLog);
  const actualSin = cliente.gestorSoatSinTramite?.id ?? '';
  const [provSin, setProvSin] = useState(actualSin);
  const [errorServidor, setErrorServidor] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);

  const log = useProveedoresLogistica(true);
  const logCargando = log.data === null && !log.error;
  const ofrecidosLog = useMemo(() => (log.data ?? []).map((p) => ({ id: p.id, nombre: p.nombre, activo: p.activo })), [log.data]);
  const logVacio = log.data !== null && !ofrecidosLog.some((p) => p.activo || p.id === actualLog);
  const nombreLog = ofrecidosLog.find((p) => p.id === provLog)?.nombre ?? null;
  const logInutil = logCargando || log.error || logVacio;
  const mensajeLog = log.error ? LOG_ERROR : logCargando ? PROVEEDOR_CARGANDO : logVacio ? (puedeCrearProveedor ? LOG_VACIO_PUEDE : LOG_VACIO_NO_PUEDE) : null;

  const { data, error: errorCarga, recargar } = proveedoresSoat;
  const cargando = data === null && !errorCarga;
  const sinEfecto = cliente.permisoSinTramiteSinEfecto === true;
  const ofrecidos = useMemo(() => {
    const catalogo = data ?? [];
    const asignado = cliente.gestorSoatSinTramite;
    return asignado && !catalogo.some((p) => p.id === asignado.id)
      ? [...catalogo, { id: asignado.id, nombre: asignado.nombre, activo: asignado.activo }]
      : catalogo;
  }, [data, cliente.gestorSoatSinTramite]);
  const vacio = data !== null && !ofrecidos.some((p) => p.activo || p.id === actualSin);
  const mensaje = errorCarga ? PROVEEDOR_ERROR : cargando ? PROVEEDOR_CARGANDO : vacio ? PROVEEDOR_VACIO : null;
  const selectorInutil = cargando || vacio || !!errorCarga;

  // Si la asignación es desconocida (no se pudo leer) y la logística no se tocó, no se exige aquí:
  // el servidor valida el estado final (RN-PLOGC-1) y no se bloquea otro cambio por un dato ausente.
  const logisticaTocada = logistica !== !cliente.logisticaAutogestionable;
  const faltaProveedor = logistica && !provLog && (logisticaTocada || cliente.proveedorLogisticaId === null);
  const cambios = useMemo(() => {
    const b: Record<string, unknown> = {};
    if (soat !== !cliente.soatAutogestionable) b.soatAutogestionable = !soat;
    if (impuestos !== !cliente.impuestosAutogestionable) b.impuestosAutogestionable = !impuestos;
    if (logistica !== !cliente.logisticaAutogestionable) b.logisticaAutogestionable = !logistica;
    if (provLog !== actualLog && provLog) b.proveedorLogisticaId = provLog;
    if (editaSinTramite && provSin !== actualSin) b.proveedorSoatSinTramiteId = provSin || null;
    return b;
  }, [soat, impuestos, logistica, provLog, provSin, cliente, actualLog, actualSin, editaSinTramite]);

  const guardar = async (e: FormEvent) => {
    e.preventDefault();
    if (faltaProveedor) return;
    if (Object.keys(cambios).length === 0) { onClose(); return; }
    setErrorServidor(null); setGuardando(true);
    try {
      await api.patch(`/flito/parametrizacion/companias/${cliente.id}`, cambios);
      // Un toast por acción, el más específico.
      if ('proveedorSoatSinTramiteId' in cambios) {
        toastOk(provSin ? TOAST_CON_PROVEEDOR : toastSinProveedor(cliente.name), { id: `compania-${cliente.id}` });
      } else if ('proveedorLogisticaId' in cambios) {
        toastOk(`Proveedor asignado a ${cliente.name}.`, { id: `compania-${cliente.id}` });
      } else toastOk('Cambios guardados.', { id: `compania-${cliente.id}` });
      onGuardado();
    } catch (err) {
      setErrorServidor(mensajeErrorGuardado(err, 'proveedorSoatSinTramiteId' in cambios));
    } finally { setGuardando(false); }
  };

  const datos: [string, string][] = [
    ['Documento', `${cliente.documentType ?? 'NIT'} ${cliente.document || '—'}`],
    ['Ciudad', cliente.city || '—'], ['Teléfono', cliente.phone || '—'], ['Email', cliente.email || '—'],
  ];
  const sololectura = !editaAutogestion;

  return (
    <FlitModal title={`Editar · ${cliente.name}`} onClose={onClose} wide>
      <div className="space-y-4">
        <FlitPillGroup>
          <FlitPillButton active={pestana === 'servicios'} pressed={pestana === 'servicios'} onClick={() => setPestana('servicios')}><span style={{ textTransform: 'none' }}>Datos y servicios</span></FlitPillButton>
          <FlitPillButton active={pestana === 'fiscales'} pressed={pestana === 'fiscales'} onClick={() => setPestana('fiscales')}><span style={{ textTransform: 'none' }}>Datos fiscales</span></FlitPillButton>
          {veTarifas && <FlitPillButton active={pestana === 'tarifas'} pressed={pestana === 'tarifas'} onClick={() => setPestana('tarifas')}><span style={{ textTransform: 'none' }}>Tarifas</span></FlitPillButton>}
        </FlitPillGroup>

        {pestana === 'fiscales' && (
          <FichaFiscal embebido clienteId={cliente.id} clienteNombre={cliente.name} editable={editable}
            onClose={onClose} onGuardado={onFiscalGuardado} />
        )}

        {pestana === 'tarifas' && (
          <div className="space-y-3">
            <p className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>Los valores negociados de {cliente.name} se administran en el configurador de tarifas.</p>
            <Link to={`/flito/tarifas/${cliente.id}`} className={flitBtnSecondary} style={flitBtnSecondaryStyle}>Abrir tarifas</Link>
          </div>
        )}

        {pestana === 'servicios' && (
          <form onSubmit={guardar} className="space-y-4" noValidate>
            <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
              {datos.map(([k, v]) => (
                <div key={k}>
                  <dt className="text-[11px] font-semibold" style={{ color: 'var(--flit-text-secondary)' }}>{k}</dt>
                  <dd className="break-words text-sm" style={{ color: 'var(--flit-text-primary)' }}>{v}</dd>
                </div>
              ))}
            </dl>

            <section aria-labelledby={`${idAviso}-t`}>
              <h3 id={`${idAviso}-t`} className="text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>Servicios</h3>
              <FilaServicio titulo="SOAT" etiqueta={`FLITO gestiona SOAT de ${cliente.name}`} checked={soat} onToggle={setSoat} disabled={sololectura}>
                {editaSinTramite && (<>
                  {sinEfecto && (
                    <p id={idAviso} className="rounded-lg px-3 py-2 text-sm font-semibold"
                      style={{ background: 'var(--flit-chip-warning-bg)', color: 'var(--flit-warning-ink)' }}>
                      {AVISO_PERMISO_SIN_EFECTO}
                    </p>
                  )}
                  <FlitSelect
                    label={PROVEEDOR_LABEL} value={provSin}
                    onChange={(v) => { setProvSin(v); setErrorServidor(null); }}
                    opciones={opcionesConEstado(ofrecidos, data ? provSin : '', { placeholder: PROVEEDOR_NINGUNO })}
                    ayuda={PROVEEDOR_AYUDA} mensaje={mensaje} fallo={!!errorCarga} disabled={selectorInutil}
                    onReintentar={errorCarga ? recargar : undefined} textoReintento={PROVEEDOR_REINTENTO}
                    describedBy={sinEfecto ? idAviso : undefined}
                  />
                </>)}
              </FilaServicio>
              <FilaServicio titulo="Impuestos" etiqueta={`FLITO gestiona Impuestos de ${cliente.name}`} checked={impuestos} onToggle={setImpuestos} disabled={sololectura} />
              <FilaServicio titulo="Logística" etiqueta={`FLITO gestiona Logística de ${cliente.name}`} checked={logistica} onToggle={setLogistica} disabled={sololectura}>
                {logistica ? (
                  <FlitSelect
                    label={LOG_LABEL} required value={provLog}
                    onChange={(v) => { setProvLog(v); setErrorServidor(null); }}
                    opciones={opcionesConEstado(ofrecidosLog, provLog, { placeholder: 'Elija un proveedor' })}
                    mensaje={mensajeLog} fallo={log.error} disabled={sololectura || !!logInutil}
                    onReintentar={log.error ? log.recargar : undefined} textoReintento={PROVEEDOR_REINTENTO}
                    error={faltaProveedor && !logInutil ? LOG_REQUERIDO : null}
                  />
                ) : (<>
                  <p className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>{LOG_AYUDA_APAGADA}</p>
                  {provLog && (
                    <p className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
                      Proveedor conservado: <strong style={{ color: 'var(--flit-text-primary)' }}>{nombreLog ?? 'asignado'}</strong>.
                      {' '}Mientras esté asignado, no se puede inactivar.
                    </p>
                  )}
                </>)}
              </FilaServicio>
            </section>

            {errorServidor && (
              <p role="alert" className="text-sm font-semibold" style={{ color: 'var(--flit-danger-text)' }}>{errorServidor}</p>
            )}
            <div className="flex flex-wrap justify-end gap-2">
              <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={onClose}>
                {sololectura ? 'Cerrar' : 'Cancelar'}
              </button>
              {!sololectura && (
                <GradientButton type="submit" disabled={guardando || faltaProveedor}>
                  {guardando ? 'Guardando…' : 'Guardar cambios'}
                </GradientButton>
              )}
            </div>
          </form>
        )}
      </div>
    </FlitModal>
  );
}
