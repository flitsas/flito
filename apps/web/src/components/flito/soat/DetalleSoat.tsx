// Detalle del SOAT (modal). HU #12819, §7 de `docs/ux/flito-soat-rediseno-experiencia.md`.
//
// Orden de arriba abajo, por lo que se viene a hacer y no por cómo llegó el dato:
//   1 · estado  2 · aviso contextual (motivo de la novedad / solo lectura / error de la acción)
//   3 · la acción del estado (una primaria)  4 · comprobante (ver y descargar, la misma intención)
//   5 · datos  6 · compradores  7 · «Corregir el caso» (Operaciones)  8 · historial
// Antes las acciones iban al final, detrás del historial, y el motivo de la novedad —lo más
// importante de un caso `con_novedad`— también. Los formularios de motivo se pintan en el sitio del
// grupo que los abrió: rechazar/reactivar sustituyen la zona 3; los de corrección, la 7.
//
// Notificación (§8): la acción correcta cierra el modal Y deja un toast; la fallida se queda aquí, en
// línea y con `role="alert"`, nunca con el mensaje crudo del API.

import { useState, type ReactNode, type RefObject } from 'react';
import { Eye, FileUp, Lock, TriangleAlert } from 'lucide-react';
import { ESTADO_SOAT_LABEL, EstadoSoat } from '@operaciones/shared-types';
import { api, ApiError } from '../../../lib/api';
import FlitModal from '../../flit/FlitModal';
import HistorialEstados from '../../flit/HistorialEstados';
import ChipSinGestion from '../../flit/ChipSinGestion';
import VisorSoportes from '../../flit/VisorSoportes';
import { documentoConTipo } from '../../flit/columnasComunes';
import { toastOk } from '../../flit/ToastFlito';
import { textoVigenciaSoat } from '../../../lib/vigenciaSoatCola';
import { BotonComprobanteDetalle, type EstadoDescargaComprobante } from '../DescargarComprobanteSoat';
import {
  FlitField, flitInp, flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary,
} from '../../flit/flitPageKit';
import ChipEstadoSoat from './ChipEstadoSoat';
import { ESTADOS_DESTINO_REVERSA, fecha, fechaDia, pesos, type Proveedor, type SoatItem } from './tipos';

type Accion = 'idle' | 'rechazar' | 'reactivar' | 'reversar' | 'proveedor' | 'asumir' | 'devolver';

/** Si el servidor contestó un 409/422 con una frase de NEGOCIO, esa; si no, la del botón. */
function textoError(e: unknown, queSeIntento: string): string {
  if (e instanceof ApiError && (e.status === 409 || e.status === 422)) {
    const cuerpo = e.rawDetails as { error?: unknown } | null | undefined;
    const texto = typeof cuerpo?.error === 'string' ? cuerpo.error.trim() : '';
    if (texto) return texto;
  }
  return `No se pudo ${queSeIntento}. Intenta de nuevo.`;
}

const ROTULO = 'text-[11px] font-semibold uppercase tracking-wide';

export default function DetalleSoat({ soat, esOperaciones, esGestor, soloLectura, esCliente, proveedores, restoreFocusRef, descarga, onClose, onCambio }: {
  soat: SoatItem; esOperaciones: boolean; esGestor: boolean; soloLectura: boolean; esCliente: boolean;
  /** `null` = sin `soat.soportes.descargar`: el botón no existe en el DOM (AC4). */
  descarga: EstadoDescargaComprobante | null;
  proveedores: Proveedor[]; restoreFocusRef?: RefObject<HTMLElement | null>;
  onClose: () => void; onCambio: () => void;
}) {
  const [accion, setAccion] = useState<Accion>('idle');
  const [motivo, setMotivo] = useState('');
  const [estadoDestino, setEstadoDestino] = useState<EstadoSoat>(EstadoSoat.PENDIENTE);
  const [proveedorSoatId, setProveedorSoatId] = useState(soat.proveedorSoatId ?? '');
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  // Visor de los comprobantes de ESTE SOAT (la factura de la aseguradora), encima del detalle.
  const [verSoportes, setVerSoportes] = useState(false);

  const placa = soat.placa ?? 'el SOAT';
  const enAdquisicion = soat.estado === EstadoSoat.SOLICITADO;
  const rechazado = soat.estado === EstadoSoat.CON_NOVEDAD;
  // Una solicitud del canal es, desde que se radica, un SOAT en gestión como cualquier otro (HU
  // #12079). El traspaso de gestión solo tiene sentido mientras está en gestión y sin pagar: en
  // Pendiente el destino se elige al enviarlo, y en Pagado el dinero ya salió.
  const traspasable = enAdquisicion || rechazado;
  const cargaFactura = enAdquisicion && (esOperaciones || esGestor);
  const hayAccionDelEstado = cargaFactura || (rechazado && esOperaciones);

  const cancelar = () => { setAccion('idle'); setMotivo(''); setError(null); };
  const ejecutar = async (fn: () => Promise<unknown>, queSeIntento: string, exito: string) => {
    setEnviando(true); setError(null);
    try { await fn(); toastOk(exito); onCambio(); }
    catch (e) { setError(textoError(e, queSeIntento)); }
    finally { setEnviando(false); }
  };

  const subirFactura = (file: File) => ejecutar(() => {
    const form = new FormData(); form.append('archivo', file);
    return api.post(`/flito/soat/${soat.id}/factura`, form);
  }, 'cargar la factura', `Factura cargada para ${placa}.`);

  const formMotivo = (etiqueta: string, ruta: string, cuerpo: Record<string, unknown>, queSeIntento: string, exito: string,
    opciones: { minLen?: number; deshabilitado?: boolean } = {}) => (
    <FormMotivo etiqueta={etiqueta} motivo={motivo} setMotivo={setMotivo} enviando={enviando}
      minLen={opciones.minLen} deshabilitado={opciones.deshabilitado} onCancelar={cancelar}
      onConfirmar={() => ejecutar(() => api.post(`/flito/soat/${soat.id}/${ruta}`, { ...cuerpo, motivo }), queSeIntento, exito)} />
  );

  const selectProveedor = (etiqueta: string) => (
    <FlitField label={etiqueta}>
      <select className={flitInp} value={proveedorSoatId} onChange={(e) => setProveedorSoatId(e.target.value)}>
        <option value="">Selecciona…</option>
        {proveedores.filter((p) => p.activo).map((p) => <option key={p.id} value={p.id}>{p.nombre}</option>)}
      </select>
    </FlitField>
  );

  return (
    <FlitModal title={`SOAT · ${soat.placa ?? soat.vin}`} onClose={onClose} wide restoreFocusRef={restoreFocusRef}>
      <div className="space-y-4 text-sm">
        {/* 1 · estado */}
        <div className="flex flex-wrap items-center gap-2">
          <ChipEstadoSoat estado={soat.estado} />
          {soat.estancado && <ChipSinGestion desde={soat.enviadoEn} />}
        </div>

        {/* 2 · aviso contextual. El motivo es el del GESTOR (`con_novedad`); al Cliente se le dice
            además lo que de verdad ocurre, sin prometer un canal de contacto que no existe. */}
        {soat.motivoRechazo && (
          <div className="rounded-lg border p-3" style={{ background: 'var(--flit-bg-app)', borderColor: 'var(--flit-border-soft)' }}>
            <p className="flex items-center gap-2 font-semibold" style={{ color: 'var(--flit-danger-text)' }}>
              <TriangleAlert size={18} aria-hidden="true" className="shrink-0" />
              Motivo de la novedad
            </p>
            <p className="mt-1" style={{ color: 'var(--flit-text-primary)' }}>{soat.motivoRechazo}</p>
            {esCliente && (
              <p className="mt-1" style={{ color: 'var(--flit-text-secondary)' }}>
                Su solicitud sigue abierta: FLITO está resolviendo esta novedad con el gestor. No tiene que hacer nada por ahora.
              </p>
            )}
          </div>
        )}
        {soloLectura && (
          <div role="status" className="flex items-center gap-2 rounded-lg p-3"
            style={{ background: 'var(--flit-bg-app)', color: 'var(--flit-blue-text)' }}>
            <Lock size={16} aria-hidden="true" className="shrink-0" />
            Solo lectura · Auditoría observa, no ejecuta acciones.
          </div>
        )}
        {error && <p role="alert" style={{ color: 'var(--flit-danger-text)' }}>{error}</p>}

        {/* 3 · la acción del estado: UNA primaria («Cargar factura»). En `con_novedad`, «Reactivar»
            va secundaria: la decisión entre reactivar, devolver o reversar la toma la persona. */}
        {hayAccionDelEstado && accion === 'idle' && (
          <div className="flex flex-wrap gap-2">
            {cargaFactura && (
              // `<label>` con el input `sr-only` y no `hidden`: con `display:none` el input no se
              // podía enfocar y la acción primaria del gestor no se alcanzaba sin ratón (D6).
              <label className={`${flitBtnPrimary} cursor-pointer has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-offset-2 has-[input:focus-visible]:outline-[color:var(--flit-border-focus)]`}
                style={flitBtnPrimaryStyle}>
                <FileUp size={16} aria-hidden="true" className="shrink-0" />
                {enviando ? 'Cargando…' : 'Cargar factura'}
                <input type="file" accept=".pdf,.png,.jpg,.jpeg" className="sr-only" disabled={enviando}
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) subirFactura(f); e.target.value = ''; }} />
              </label>
            )}
            {cargaFactura && (
              <button type="button" className={flitBtnSecondary} onClick={() => setAccion('rechazar')}>Rechazar</button>
            )}
            {rechazado && esOperaciones && (
              <button type="button" className={flitBtnSecondary} onClick={() => setAccion('reactivar')}>Reactivar</button>
            )}
          </div>
        )}
        {accion === 'rechazar' && formMotivo('Motivo del rechazo', 'rechazar', {}, 'registrar el rechazo',
          `Rechazo registrado: ${placa} quedó ${ESTADO_SOAT_LABEL[EstadoSoat.CON_NOVEDAD]}.`)}
        {accion === 'reactivar' && formMotivo('Motivo de la corrección', 'reactivar', {}, 'reactivar el SOAT',
          `${placa} volvió a gestión.`)}

        {/* 4 · comprobante: consultar y bajar la factura van juntos porque son la misma intención. */}
        <Seccion titulo="Comprobante">
          <div className="flex flex-wrap items-start gap-2">
            <button type="button" className={flitBtnSecondary} onClick={() => setVerSoportes(true)}>
              <Eye size={16} aria-hidden="true" className="shrink-0" />
              Ver soporte
            </button>
            {descarga && <BotonComprobanteDetalle soat={soat} descarga={descarga} />}
          </div>
        </Seccion>
        {verSoportes && (
          <VisorSoportes ruta={`/flito/soat/${soat.id}/soportes`} titulo={`SOAT ${soat.placa ?? soat.vin}`}
            vacio="Este SOAT no tiene ninguna factura cargada todavía."
            onClose={() => setVerSoportes(false)} />
        )}

        {/* 5 · datos. Los de la trastienda no se pintan «—» para el Cliente: se omiten, porque el
            backend no se los manda y una fila vacía sugiere un dato que existe y no cargó. Las
            fechas del TRÁMITE en FLIT llegan aquí desde la tabla (P-2). La vigencia (HU #12097) va
            con hora y con «—», nivel de auditoría; el número de póliza del RUNT no se enseña en
            ninguna parte (cuasi-PII, y choca de nombre con `numero_poliza`). */}
        <dl className="grid grid-cols-1 gap-x-4 gap-y-2 border-t pt-4 sm:grid-cols-2" style={{ borderColor: 'var(--flit-border-soft)' }}>
          <Dato k="VIN" v={soat.vin} /><Dato k="Vehículo" v={`${soat.marca ?? ''} ${soat.linea ?? ''}`.trim() || '—'} />
          <Dato k="Compañía" v={soat.companiaNombre} /><Dato k="Organismo" v={soat.organismoNombre ?? '—'} />
          <Dato k="Trámite creado" v={fechaDia(soat.fechaCreacion)} /><Dato k="Trámite aprobado" v={soat.fechaAprobacion ? fechaDia(soat.fechaAprobacion) : 'Sin aprobar'} />
          {!esCliente && (
            <Dato k="Gestiona" v={soat.gestionOperaciones
              ? `Operaciones${soat.proveedorSoatNombre ? ` · retomado de ${soat.proveedorSoatNombre}` : ''}`
              : soat.proveedorSoatNombre ?? '—'} />
          )}
          {!esCliente && <Dato k="Enviado por" v={soat.enviadoPorNombre ?? '—'} />}
          <Dato k="Enviado" v={fecha(soat.enviadoEn)} />
          {!esCliente && <Dato k="Valor pagado" v={pesos(soat.valorPagado)} />}
          {!esCliente && <Dato k="Vigencia" v={textoVigenciaSoat(soat.vigencia)} />}
          {!esCliente && <Dato k="Último dato del RUNT" v={fecha(soat.vigencia?.verificadaEn ?? null)} />}
        </dl>

        {/* 6 · compradores */}
        {soat.compradores.length > 0 && (
          <Seccion titulo="Compradores">
            <ul className="space-y-0.5">
              {soat.compradores.map((c) => (
                <li key={c.orden} className="flex justify-between gap-3">
                  <span>{c.nombreCompleto} · {documentoConTipo(c.tipoDocumento, c.numeroDocumento)}</span>
                  {c.porcentajeParticipacion !== null && <span className="tabular-nums">{c.porcentajeParticipacion}%</span>}
                </li>
              ))}
            </ul>
          </Seccion>
        )}

        {/* 7 · correcciones de Operaciones: acciones de excepción, aparte, para que no compitan con
            la del día. Sin condición de origen (HU #12079/#12080: el estado que la justificaba ya no
            existe). */}
        {esOperaciones && (
          <Seccion titulo="Corregir el caso">
            {accion === 'idle' || accion === 'rechazar' || accion === 'reactivar' ? (
              <div className="flex flex-wrap gap-2">
                <button type="button" className={flitBtnSecondary} onClick={() => setAccion('reversar')}>Reversar</button>
                {!enAdquisicion && (
                  <button type="button" className={flitBtnSecondary} onClick={() => setAccion('proveedor')}>Cambiar proveedor</button>
                )}
                {traspasable && !soat.gestionOperaciones && (
                  <button type="button" className={flitBtnSecondary} onClick={() => setAccion('asumir')}>Asumir en Operaciones</button>
                )}
                {traspasable && soat.gestionOperaciones && (
                  <button type="button" className={flitBtnSecondary} onClick={() => setAccion('devolver')}>Devolver al proveedor</button>
                )}
              </div>
            ) : (
              <div className="rounded-lg border p-3" style={{ borderColor: 'var(--flit-border-soft)' }}>
                {accion === 'reversar' && (
                  <>
                    <FlitField label="Estado destino">
                      <select className={flitInp} value={estadoDestino} onChange={(e) => setEstadoDestino(e.target.value as EstadoSoat)}>
                        {ESTADOS_DESTINO_REVERSA.map((e) => <option key={e} value={e}>{ESTADO_SOAT_LABEL[e]}</option>)}
                      </select>
                    </FlitField>
                    {formMotivo('Motivo de la reversa (mín. 5 caracteres)', 'reversar', { estadoDestino }, 'reversar el SOAT',
                      `${placa} se reversó a ${ESTADO_SOAT_LABEL[estadoDestino]}.`, { minLen: 5 })}
                  </>
                )}
                {accion === 'asumir' && formMotivo('Motivo para asumirlo en Operaciones (mín. 5 caracteres)', 'asumir-operaciones', {},
                  'asumir el SOAT en Operaciones', `Operaciones asumió ${placa}.`, { minLen: 5 })}
                {accion === 'devolver' && (
                  <>
                    {selectProveedor('Proveedor que lo retoma')}
                    {formMotivo('Motivo de la devolución (mín. 5 caracteres)', 'devolver-gestor', { proveedorSoatId },
                      'devolver el SOAT al proveedor', `${placa} volvió al proveedor.`, { minLen: 5, deshabilitado: !proveedorSoatId })}
                  </>
                )}
                {accion === 'proveedor' && (
                  <>
                    {selectProveedor('Nuevo proveedor')}
                    {formMotivo('Motivo del cambio', 'proveedor', { proveedorSoatId }, 'cambiar el proveedor',
                      `Proveedor cambiado para ${placa}.`, { deshabilitado: !proveedorSoatId })}
                  </>
                )}
              </div>
            )}
          </Seccion>
        )}

        {/* 8 · historial: REGISTRO INTERNO de la operación. No se le ofrece al Cliente (HU #11914):
            lo que él necesita es el estado y, si volvió con novedad, el motivo — que van arriba. */}
        {!esCliente && <HistorialEstados concepto="soat" registroId={soat.id} />}
      </div>
    </FlitModal>
  );
}

function Seccion({ titulo, children }: { titulo: string; children: ReactNode }) {
  return (
    <div className="space-y-2 border-t pt-4" style={{ borderColor: 'var(--flit-border-soft)' }}>
      <p className={ROTULO} style={{ color: 'var(--flit-text-muted)' }}>{titulo}</p>
      {children}
    </div>
  );
}

function Dato({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex flex-col">
      <dt className="text-[11px] uppercase" style={{ color: 'var(--flit-text-muted)' }}>{k}</dt>
      <dd className="font-medium">{v}</dd>
    </div>
  );
}

function FormMotivo({ etiqueta, motivo, setMotivo, enviando, minLen = 1, deshabilitado = false, onConfirmar, onCancelar }: {
  etiqueta: string; motivo: string; setMotivo: (v: string) => void; enviando: boolean; minLen?: number;
  deshabilitado?: boolean; onConfirmar: () => void; onCancelar: () => void;
}) {
  return (
    <div className="mt-2 space-y-2">
      <FlitField label={etiqueta}>
        <textarea className={`${flitInp} min-h-[64px]`} value={motivo} onChange={(e) => setMotivo(e.target.value)} />
      </FlitField>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={flitBtnPrimary} style={flitBtnPrimaryStyle}
          disabled={enviando || deshabilitado || motivo.trim().length < minLen} onClick={onConfirmar}>
          {enviando ? 'Enviando…' : 'Confirmar'}
        </button>
        <button type="button" className={flitBtnSecondary} onClick={onCancelar}>Cancelar</button>
      </div>
    </div>
  );
}
