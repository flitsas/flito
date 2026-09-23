// Detalle del SOAT (modal), movido tal cual desde `pages/FlitoSoat.tsx` (HU #12819, fase 0).

import { useState, type RefObject } from 'react';
import { ESTADO_SOAT_LABEL, EstadoSoat } from '@operaciones/shared-types';
import { api, errorMessage } from '../../../lib/api';
import FlitModal from '../../flit/FlitModal';
import HistorialEstados from '../../flit/HistorialEstados';
import ChipSinGestion from '../../flit/ChipSinGestion';
import VisorSoportes from '../../flit/VisorSoportes';
import { documentoConTipo } from '../../flit/columnasComunes';
import { textoVigenciaSoat } from '../../../lib/vigenciaSoatCola';
import { BotonComprobanteDetalle, type EstadoDescargaComprobante } from '../DescargarComprobanteSoat';
import {
  FlitField, flitInp, flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle,
} from '../../flit/flitPageKit';
import ChipEstadoSoat from './ChipEstadoSoat';
import { ESTADOS_DESTINO_REVERSA, fecha, pesos, type Proveedor, type SoatItem } from './tipos';

type Accion = 'idle' | 'rechazar' | 'reactivar' | 'reversar' | 'proveedor' | 'factura' | 'asumir' | 'devolver';

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

  const enAdquisicion = soat.estado === EstadoSoat.SOLICITADO;
  const rechazado = soat.estado === EstadoSoat.CON_NOVEDAD;
  // Ni `esFilaDelCanal` ni el bloque de revisión (HU #12079). Una solicitud del canal es, desde que
  // se radica, **un SOAT en gestión como cualquier otro**: el detalle le ofrece las acciones que ya
  // existían para `solicitado` y recupera «Reversar» y «Cambiar proveedor», que la #11915 le había
  // quitado justamente por estar en un estado que ya no existe.
  // El traspaso de gestión solo tiene sentido mientras el SOAT está en gestión y sin pagar: en
  // Pendiente el destino se elige al enviarlo, y en Pagado el dinero ya salió.
  const traspasable = enAdquisicion || rechazado;

  const ejecutar = async (fn: () => Promise<unknown>) => {
    setEnviando(true); setError(null);
    try { await fn(); onCambio(); }
    catch (e) { setError(errorMessage(e)); }
    finally { setEnviando(false); }
  };

  const subirFactura = (file: File) => ejecutar(() => {
    const form = new FormData(); form.append('archivo', file);
    return api.post(`/flito/soat/${soat.id}/factura`, form);
  });

  return (
    <FlitModal title={`SOAT · ${soat.placa ?? soat.vin}`} onClose={onClose} wide restoreFocusRef={restoreFocusRef}>
      <div className="space-y-3 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <ChipEstadoSoat estado={soat.estado} />
          {soat.estancado && <ChipSinGestion desde={soat.enviadoEn} />}
        </div>

        <dl className="grid grid-cols-1 gap-x-4 gap-y-1.5 sm:grid-cols-2">
          <Dato k="VIN" v={soat.vin} /><Dato k="Vehículo" v={`${soat.marca ?? ''} ${soat.linea ?? ''}`.trim() || '—'} />
          <Dato k="Compañía" v={soat.companiaNombre} /><Dato k="Organismo" v={soat.organismoNombre ?? '—'} />
          {/* Los tres datos de la trastienda. No se pintan «—» para el cliente: se omiten, porque el
              backend no se los manda y una fila vacía sugiere un dato que existe y no cargó. */}
          {!esCliente && (
            <Dato k="Gestiona" v={soat.gestionOperaciones
              ? `Operaciones${soat.proveedorSoatNombre ? ` · retomado de ${soat.proveedorSoatNombre}` : ''}`
              : soat.proveedorSoatNombre ?? '—'} />
          )}
          {!esCliente && <Dato k="Enviado por" v={soat.enviadoPorNombre ?? '—'} />}
          <Dato k="Enviado" v={fecha(soat.enviadoEn)} />
          {!esCliente && <Dato k="Valor pagado" v={pesos(soat.valorPagado)} />}
          {/* Los dos de la vigencia (HU #12097), de SOLO LECTURA como el resto de la ficha. El
              rótulo es «Último dato del RUNT» en los cuatro estados —siempre es la misma cosa,
              cuándo contestó por última vez— y uno que cambiara con el estado obligaría a leer dos
              veces. Aquí sí va la hora y aquí sí se pinta «—»: es el nivel de auditoría, y el modal
              ya lo hace en todos sus `<Dato>`. El número de póliza del RUNT no está ni aquí ni en
              ninguna parte: no lo pide ningún AC, es cuasi-PII y colisiona de nombre con
              `numero_poliza`, que es otro número. */}
          {!esCliente && <Dato k="Vigencia" v={textoVigenciaSoat(soat.vigencia)} />}
          {!esCliente && <Dato k="Último dato del RUNT" v={fecha(soat.vigencia?.verificadaEn ?? null)} />}
          {/* El soporte del SOAT se carga desde aquí y hasta ahora solo se podía consultar desde el
              reporte de costos, en el que el gestor del proveedor ni siquiera entra: quien abre un
              SOAT pagado quiere ver la factura que lo pagó sin salir del detalle. */}
          <div>
            <dt className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--flit-text-muted)' }}>Soporte</dt>
            <dd className="text-sm">
              <button type="button" className="font-semibold underline" style={{ color: 'var(--flit-blue-text)' }}
                onClick={() => setVerSoportes(true)}>Ver soporte</button>
            </dd>
          </div>
        </dl>

        {verSoportes && (
          <VisorSoportes ruta={`/flito/soat/${soat.id}/soportes`} titulo={`SOAT ${soat.placa ?? soat.vin}`}
            vacio="Este SOAT no tiene ninguna factura cargada todavía."
            onClose={() => setVerSoportes(false)} />
        )}

        {/* El historial es el REGISTRO INTERNO de la operación —quién movió qué y cuándo— y hasta la
            HU #11914 se pintaba para todo el mundo, incluido el Cliente. El backend ya se lo recorta
            (la #11913 le quitó el actor y el motivo), pero la pantalla tampoco debe ofrecérselo: lo
            que él necesita no es la línea de tiempo de la operación sino el estado de su SOAT y,
            si volvió con novedad, el motivo con su siguiente paso — que van más abajo. */}
        {!esCliente && <HistorialEstados concepto="soat" registroId={soat.id} />}

        {soat.compradores.length > 0 && (
          <div>
            <p className="mb-1 text-[11px] font-semibold uppercase" style={{ color: 'var(--flit-text-muted)' }}>Compradores</p>
            <ul className="space-y-0.5">
              {soat.compradores.map((c) => (
                <li key={c.orden} className="flex justify-between gap-3">
                  <span>{c.nombreCompleto} · {documentoConTipo(c.tipoDocumento, c.numeroDocumento)}</span>
                  {c.porcentajeParticipacion !== null && <span className="tabular-nums">{c.porcentajeParticipacion}%</span>}
                </li>
              ))}
            </ul>
          </div>
        )}

        {soat.motivoRechazo && (
          <div className="rounded-md p-2" style={{ background: 'var(--flit-bg-app)', color: 'var(--color-danger)' }}>
            <p>Motivo de rechazo: {soat.motivoRechazo}</p>
            {/* Lo ÚNICO que se añade al retirar el circuito de revisión (HU #12079). «Corregir y
                reenviar» se fue con el estado `rechazada` —que la #12080 borra del enum—, y la vía
                por la que al Cliente le vuelve algo es esta: una caja roja con el motivo del GESTOR
                (`flito_soat.motivo_rechazo`, `con_novedad`) y ningún siguiente paso. La frase
                dice lo que de verdad ocurre —Operaciones puede **Reactivar** o **Devolver al
                proveedor**— y no promete un canal de contacto que el producto no tiene. */}
            {esCliente && (
              <p className="mt-1 text-sm">
                Su solicitud sigue abierta: FLITO está resolviendo esta novedad con el gestor. No tiene que hacer nada por ahora.
              </p>
            )}
          </div>
        )}
        {soloLectura && <div role="status" className="rounded-md p-2" style={{ background: 'var(--flit-bg-app)', color: 'var(--flit-blue-text)' }}>
          Solo lectura · Auditoría observa, no ejecuta acciones.</div>}
        {error && <p className="text-sm" style={{ color: 'var(--color-danger)' }}>{error}</p>}

        {/* La fila de acciones también existe para quien SOLO descarga (Cliente, auditor con la
            función): «Descargar comprobante» va al final, secundaria — descargar es consultar. */}
        {accion === 'idle' && (!soloLectura || descarga) && (
          <div className="flex flex-wrap gap-2 pt-1">
            {enAdquisicion && (esOperaciones || esGestor) && (
              <label className={`${flitBtnPrimary} cursor-pointer`} style={flitBtnPrimaryStyle}>
                {enviando ? 'Cargando…' : 'Cargar factura'}
                <input type="file" accept=".pdf,.png,.jpg,.jpeg" className="hidden"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) subirFactura(f); e.target.value = ''; }} />
              </label>
            )}
            {enAdquisicion && (esOperaciones || esGestor) && (
              <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={() => setAccion('rechazar')}>Rechazar</button>
            )}
            {rechazado && esOperaciones && (
              <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={() => setAccion('reactivar')}>Reactivar</button>
            )}
            {/* Las dos acciones heredadas se ofrecen sin condición de origen (HU #12079): la #11915
                se las quitaba a las filas del canal porque «Reversar» una `pendiente_revision` a
                `pendiente` la metía en el alcance de `POST /enviar` sin que nadie la hubiera
                validado.
                Desde la HU #12080 no queda ni el estado ni la fila legada: la migración 0176 recrea
                `flito_soat_estado` sin los dos valores del canal y ABORTA si alguna fila sigue en
                ellos, así que el riesgo que la condición cubría no tiene ya dónde ocurrir. Por eso
                `reversar()` también perdió sus dos guardas: no se relajó una regla, se retiró con lo
                que protegía. */}
            {esOperaciones && (
              <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={() => setAccion('reversar')}>Reversar</button>
            )}
            {esOperaciones && !enAdquisicion && (
              <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={() => setAccion('proveedor')}>Cambiar proveedor</button>
            )}
            {esOperaciones && traspasable && !soat.gestionOperaciones && (
              <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={() => setAccion('asumir')}>Asumir en Operaciones</button>
            )}
            {esOperaciones && traspasable && soat.gestionOperaciones && (
              <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={() => setAccion('devolver')}>Devolver al proveedor</button>
            )}
            {descarga && <BotonComprobanteDetalle soat={soat} descarga={descarga} />}
          </div>
        )}

        {(accion === 'rechazar' || accion === 'reactivar') && (
          <FormMotivo etiqueta={accion === 'rechazar' ? 'Motivo del rechazo' : 'Motivo de la corrección'}
            motivo={motivo} setMotivo={setMotivo} enviando={enviando} onCancelar={() => { setAccion('idle'); setMotivo(''); }}
            onConfirmar={() => ejecutar(() => api.post(`/flito/soat/${soat.id}/${accion}`, { motivo }))} />
        )}

        {accion === 'reversar' && (
          <div className="rounded-lg border p-3" style={{ borderColor: 'var(--flit-border-soft)' }}>
            <FlitField label="Estado destino">
              <select className={flitInp} value={estadoDestino} onChange={(e) => setEstadoDestino(e.target.value as EstadoSoat)}>
                {ESTADOS_DESTINO_REVERSA.map((e) => <option key={e} value={e}>{ESTADO_SOAT_LABEL[e]}</option>)}
              </select>
            </FlitField>
            <FormMotivo etiqueta="Motivo de la reversa (mín. 5 caracteres)" motivo={motivo} setMotivo={setMotivo}
              enviando={enviando} minLen={5} onCancelar={() => { setAccion('idle'); setMotivo(''); }}
              onConfirmar={() => ejecutar(() => api.post(`/flito/soat/${soat.id}/reversar`, { estadoDestino, motivo }))} />
          </div>
        )}

        {accion === 'asumir' && (
          <FormMotivo etiqueta="Motivo para asumirlo en Operaciones (mín. 5 caracteres)"
            motivo={motivo} setMotivo={setMotivo} enviando={enviando} minLen={5}
            onCancelar={() => { setAccion('idle'); setMotivo(''); }}
            onConfirmar={() => ejecutar(() => api.post(`/flito/soat/${soat.id}/asumir-operaciones`, { motivo }))} />
        )}

        {accion === 'devolver' && (
          <div className="rounded-lg border p-3" style={{ borderColor: 'var(--flit-border-soft)' }}>
            <FlitField label="Proveedor que lo retoma">
              <select className={flitInp} value={proveedorSoatId} onChange={(e) => setProveedorSoatId(e.target.value)}>
                <option value="">Selecciona…</option>
                {proveedores.filter((p) => p.activo).map((p) => <option key={p.id} value={p.id}>{p.nombre}</option>)}
              </select>
            </FlitField>
            <FormMotivo etiqueta="Motivo de la devolución (mín. 5 caracteres)" motivo={motivo} setMotivo={setMotivo}
              enviando={enviando} minLen={5} deshabilitado={!proveedorSoatId}
              onCancelar={() => { setAccion('idle'); setMotivo(''); }}
              onConfirmar={() => ejecutar(() => api.post(`/flito/soat/${soat.id}/devolver-gestor`, { proveedorSoatId, motivo }))} />
          </div>
        )}

        {accion === 'proveedor' && (
          <div className="rounded-lg border p-3" style={{ borderColor: 'var(--flit-border-soft)' }}>
            <FlitField label="Nuevo proveedor">
              <select className={flitInp} value={proveedorSoatId} onChange={(e) => setProveedorSoatId(e.target.value)}>
                <option value="">Selecciona…</option>
                {proveedores.filter((p) => p.activo).map((p) => <option key={p.id} value={p.id}>{p.nombre}</option>)}
              </select>
            </FlitField>
            <FormMotivo etiqueta="Motivo del cambio" motivo={motivo} setMotivo={setMotivo} enviando={enviando}
              deshabilitado={!proveedorSoatId} onCancelar={() => { setAccion('idle'); setMotivo(''); }}
              onConfirmar={() => ejecutar(() => api.post(`/flito/soat/${soat.id}/proveedor`, { proveedorSoatId, motivo }))} />
          </div>
        )}
      </div>
    </FlitModal>
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
      <div className="flex gap-2">
        <button className={flitBtnPrimary} style={flitBtnPrimaryStyle}
          disabled={enviando || deshabilitado || motivo.trim().length < minLen} onClick={onConfirmar}>
          {enviando ? 'Enviando…' : 'Confirmar'}
        </button>
        <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={onCancelar}>Cancelar</button>
      </div>
    </div>
  );
}
