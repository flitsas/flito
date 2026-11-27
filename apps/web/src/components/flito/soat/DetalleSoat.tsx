// Detalle del SOAT (modal). HU 12819, §7 de `docs/ux/flito-soat-rediseno-experiencia.md`.
//
// Apaisado desde la Épica #14707, bloque 4 (`FlitModalHorizontal`; UX `docs/ux/flito-tramites-rediseno.md` §10.1):
// título visible «SOAT» con el nombre accesible «SOAT · {placa}» de siempre (lo usan los E2E). Lateral en texto y
// enlaces: aviso (2), comprobante (4: «Ver soporte» / «Descargar comprobante») y documentos adicionales (4b).
// Contenido: bloque «Datos» con la fila de acciones en su encabezado (3, y la carga del comprobante), el vehículo
// con la placa grande y las fichas (5); después compradores (6), «Corregir el caso» en ghost (7) e historial (8).
// Solo se movió JSX: permisos, `accion`, formularios y errores son los de antes.
//
// Orden de arriba abajo, por lo que se viene a hacer y no por cómo llegó el dato:
//   1 · estado  2 · aviso contextual (motivo de la novedad / solo lectura / error de la factura)
//   3 · la acción del estado (una primaria)  4 · comprobante (ver y descargar, la misma intención)
//   5 · datos  6 · compradores  7 · «Corregir el caso» (Operaciones)  8 · historial
// Antes las acciones iban al final, detrás del historial, y el motivo de la novedad —lo más
// importante de un caso `con_novedad`— también. Los formularios de motivo se pintan en el sitio del
// grupo que los abrió: rechazar/reactivar sustituyen la zona 3; los de corrección, la 7.
//
// Notificación (§8): la acción correcta cierra el modal Y deja un toast; la fallida se queda aquí, en
// línea y con `role="alert"` (junto al «Confirmar» de su formulario), nunca con el mensaje crudo del API.

import FlitSelect from '../../flit/FlitSelect';
import { opcionesConEstado } from '../../flit/opcionesConEstado';
import { SOAT_REINTENTO, mensajeSelectorSoat, type CatalogoSelector } from '../../clientes/proveedoresDatos';
import { useId, useState, type ReactNode, type RefObject } from 'react';
import { Icono } from '../../flit/kit/Icono';
import { ESTADO_SOAT_LABEL, EstadoSoat } from '@operaciones/shared-types';
import { api, ApiError } from '../../../lib/api';
import FlitModalHorizontal from '../../flit/FlitModalHorizontal';
import { claseBoton } from '../../flit/GradientButton';
import { Vehiculo, textoServicioVehiculo } from '../../flit/Placa';
import HistorialEstados from '../../flit/HistorialEstados';
import ChipSinGestion from '../../flit/ChipSinGestion';
import { Fichas } from '../../flit/Bloques';
import VisorSoportes from '../../flit/VisorSoportes';
import { documentoConTipo } from '../../flit/columnasComunes';
import { toastOk } from '../../flit/ToastFlito';
import { textoVigenciaSoat } from '../../../lib/vigenciaSoatCola';
import { BotonComprobanteDetalle, type EstadoDescargaComprobante } from '../DescargarComprobanteSoat';
import {
  FlitField, flitInp, flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary,
} from '../../flit/flitPageKit';
import ChipEstadoSoat from './ChipEstadoSoat';
import CampoContrasenaPdf from './CampoContrasenaPdf';
import { AYUDA_NOMBRE_NO_ABRE } from './ReintentoProtegidosSoat';
import { DocumentosAdicionalesSeccion } from './DocumentosAdicionalesLista';
import { ESTADOS_DESTINO_REVERSA, fecha, fechaDia, pesos, type SoatItem } from './tipos';

type Accion = 'idle' | 'rechazar' | 'reactivar' | 'reversar' | 'proveedor' | 'asumir' | 'devolver';

/** Si el servidor contestó un 409/422 con una frase de NEGOCIO, esa; si no, la del botón. */
function textoError(e: unknown, queSeIntento: string): string {
  // 429: el límite de abrir PDF con el nombre del archivo trae su propio copy (BUG #14569).
  if (e instanceof ApiError && (e.status === 409 || e.status === 422 || e.status === 429)) {
    const cuerpo = e.rawDetails as { error?: unknown } | null | undefined;
    const texto = typeof cuerpo?.error === 'string' ? cuerpo.error.trim() : '';
    if (texto) return texto;
  }
  return `No se pudo ${queSeIntento}. Intenta de nuevo.`;
}

/** BUG #14569: los dos `codigo` del API que piden la contraseña del PDF en vez de un error. */
function pideContrasena(e: unknown): 'cifrado' | 'incorrecta' | null {
  if (!(e instanceof ApiError)) return null;
  const codigo = (e.rawDetails as { codigo?: unknown } | null | undefined)?.codigo;
  if (codigo === 'PDF_CIFRADO') return 'cifrado';
  if (codigo === 'PDF_CONTRASENA_INCORRECTA') return 'incorrecta';
  return null;
}

/**
 * HU 12872 (AC4): una entrada por acción del detalle, cada una con la función de SU endpoint. El
 * «modo» de la pantalla (Operaciones, gestor, Cliente) ya no decide acciones: solo copy y datos.
 */
export interface PermisosDetalleSoat {
  cargarFactura: boolean;    // soat.comprobante.cargar (POST /:id/factura)
  rechazar: boolean;         // soat.solicitud.rechazar
  reactivar: boolean;        // soat.solicitud.reactivar
  reversar: boolean;         // soat.solicitud.reversar
  cambiarProveedor: boolean; // soat.proveedor.cambiar
  asumir: boolean;           // soat.solicitud.asumir
  devolver: boolean;         // soat.solicitud.devolver
}

export const FUNCION_ACCION_SOAT: Record<keyof PermisosDetalleSoat, string> = {
  cargarFactura: 'soat.comprobante.cargar',
  rechazar: 'soat.solicitud.rechazar',
  reactivar: 'soat.solicitud.reactivar',
  reversar: 'soat.solicitud.reversar',
  cambiarProveedor: 'soat.proveedor.cambiar',
  asumir: 'soat.solicitud.asumir',
  devolver: 'soat.solicitud.devolver',
};

export default function DetalleSoat({ soat, puede, soloLectura, esCliente, proveedores, restoreFocusRef, descarga, onClose, onCambio }: {
  soat: SoatItem; puede: PermisosDetalleSoat; soloLectura: boolean; esCliente: boolean;
  /** `null` = sin `soat.soportes.descargar`: el botón no existe en el DOM (AC4). */
  descarga: EstadoDescargaComprobante | null;
  proveedores: CatalogoSelector; restoreFocusRef?: RefObject<HTMLElement | null>;
  onClose: () => void; onCambio: () => void;
}) {
  const [accion, setAccion] = useState<Accion>('idle');
  const [motivo, setMotivo] = useState('');
  const [estadoDestino, setEstadoDestino] = useState<EstadoSoat>(EstadoSoat.PENDIENTE);
  const [proveedorSoatId, setProveedorSoatId] = useState(soat.proveedorSoatId ?? '');
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  const idDatos = useId();
  // Visor de los comprobantes de ESTE SOAT (la factura de la aseguradora), encima del detalle.
  const [verSoportes, setVerSoportes] = useState(false);
  // BUG #14569: el PDF que el API devolvió por cifrado, a la espera de su contraseña. La clave solo
  // vive aquí y en el cuerpo del reenvío; se limpia al cargar, al cancelar y tras cada intento.
  // `incorrecta`: la clave escrita no lo abrió; `nombreNoAbre`: el nombre del archivo tampoco.
  const [protegido, setProtegido] = useState<{ archivo: File; incorrecta: boolean; nombreNoAbre: boolean } | null>(null);
  const [contrasena, setContrasena] = useState('');
  // BUG #14569: como en la masiva, la casilla del nombre solo existe cuando el API ya dijo que el PDF
  // está protegido; ahí nace marcada y el campo de clave se esconde mientras lo esté.
  const [usarNombre, setUsarNombre] = useState(true);

  const placa = soat.placa ?? 'el SOAT';
  const enAdquisicion = soat.estado === EstadoSoat.SOLICITADO;
  const rechazado = soat.estado === EstadoSoat.CON_NOVEDAD;
  // Una solicitud del canal es, desde que se radica, un SOAT en gestión como cualquier otro (HU
  // 12079). El traspaso de gestión solo tiene sentido mientras está en gestión y sin pagar: en
  // Pendiente el destino se elige al enviarlo, y en Pagado el dinero ya salió.
  const traspasable = enAdquisicion || rechazado;
  const cargaFactura = enAdquisicion && puede.cargarFactura;
  const rechazable = enAdquisicion && puede.rechazar;
  const reactivable = rechazado && puede.reactivar;
  const hayAccionDelEstado = cargaFactura || rechazable || reactivable;
  // «Corregir el caso» se pinta si al menos una de sus acciones aplica (estado + función).
  const corrReversar = puede.reversar;
  const corrProveedor = !enAdquisicion && puede.cambiarProveedor;
  const corrAsumir = traspasable && !soat.gestionOperaciones && puede.asumir;
  const corrDevolver = traspasable && !!soat.gestionOperaciones && puede.devolver;
  const hayCorreccion = corrReversar || corrProveedor || corrAsumir || corrDevolver;

  // El asignado que ya no se ofrece no queda elegido en silencio: el selector diría «Selecciona…» y el API lo rechazaría con 409.
  const proveedorElegido = proveedores.data?.some((p) => p.id === proveedorSoatId) ? proveedorSoatId : '';

  const cancelar = () => { setAccion('idle'); setMotivo(''); setError(null); };
  const ejecutar = async (fn: () => Promise<unknown>, queSeIntento: string, exito: string) => {
    setEnviando(true); setError(null);
    try { await fn(); toastOk(exito); onCambio(); }
    catch (e) { setError(textoError(e, queSeIntento)); }
    finally { setEnviando(false); }
  };

  /**
   * Primera subida: sin clave ni nombre (un PDF sin contraseña entra directo). El reintento manda la
   * clave escrita o `usarNombreComoClave=true`. Si el nombre no lo abre, el API vuelve a contestar
   * `PDF_CIFRADO` (no `…_INCORRECTA`): eso desmarca la casilla y pide la clave.
   */
  const subirFactura = async (file: File, modo: { clave?: string; porNombre?: boolean } = {}) => {
    setEnviando(true); setError(null);
    try {
      const form = new FormData(); form.append('archivo', file);
      if (modo.clave) form.append('contrasena', modo.clave);
      form.append('usarNombreComoClave', modo.porNombre ? 'true' : 'false');
      await api.post(`/flito/soat/${soat.id}/factura`, form);
      setProtegido(null); setContrasena('');
      toastOk(`Comprobante de SOAT cargado para ${placa}.`); onCambio();
    } catch (e) {
      const motivoClave = pideContrasena(e);
      if (motivoClave) {
        const reintento = !!modo.clave || !!modo.porNombre;
        setProtegido({ archivo: file, incorrecta: motivoClave === 'incorrecta', nombreNoAbre: !!modo.porNombre });
        setContrasena('');
        setUsarNombre(!reintento);
      } else {
        setError(textoError(e, 'cargar el comprobante de SOAT'));
      }
    } finally { setEnviando(false); }
  };
  const reintentarProtegido = () => {
    if (!protegido) return;
    if (usarNombre) void subirFactura(protegido.archivo, { porNombre: true });
    else if (contrasena) void subirFactura(protegido.archivo, { clave: contrasena });
  };
  const cancelarProtegido = () => { setProtegido(null); setContrasena(''); setError(null); };

  const formMotivo = (etiqueta: string, ruta: string, cuerpo: Record<string, unknown>, queSeIntento: string, exito: string,
    opciones: { minLen?: number; deshabilitado?: boolean } = {}) => (
    <FormMotivo etiqueta={etiqueta} motivo={motivo} setMotivo={setMotivo} enviando={enviando} error={error}
      minLen={opciones.minLen} deshabilitado={opciones.deshabilitado} onCancelar={cancelar}
      onConfirmar={() => ejecutar(() => api.post(`/flito/soat/${soat.id}/${ruta}`, { ...cuerpo, motivo }), queSeIntento, exito)} />
  );

  const selectProveedor = (etiqueta: string) => (
    <FlitSelect label={etiqueta} value={proveedorElegido} onChange={setProveedorSoatId}
      opciones={opcionesConEstado(proveedores.data ?? [], '', { placeholder: 'Selecciona…' })}
      mensaje={mensajeSelectorSoat(proveedores)} fallo={proveedores.error} disabled={!proveedores.data?.length}
      onReintentar={proveedores.error ? proveedores.recargar : undefined} textoReintento={SOAT_REINTENTO} />
  );

  const nombreVehiculo = `${soat.marca ?? ''} ${soat.linea ?? ''}`.trim();
  const metaVehiculo = [textoServicioVehiculo(soat.tipoServicio), soat.vin ? `VIN ${soat.vin}` : null].filter(Boolean).join(' · ');
  const btnSm = (v: 'secondary' | 'ghost') => claseBoton(v, 'sm');

  // 2 · aviso contextual. El motivo es el del GESTOR (`con_novedad`); al Cliente se le dice además lo que de verdad
  // ocurre, sin prometer un canal de contacto que no existe.
  const lateral = (
    <>
      {(soat.motivoRechazo || soloLectura) && (
        <div className="lateral-bloque space-y-3">
          {soat.motivoRechazo && (
            <div className="aviso-motivo">
              <p><Icono nombre="alerta" size={18} className="shrink-0" />Motivo de la novedad</p>
              <p style={{ color: 'var(--color-text-primary)' }}>{soat.motivoRechazo}</p>
              {esCliente && (
                <p style={{ color: 'var(--color-text-secondary)' }}>
                  Su solicitud sigue abierta: FLITO está resolviendo esta novedad con el gestor. No tiene que hacer nada por ahora.
                </p>
              )}
            </div>
          )}
          {soloLectura && (
            <div role="status" className="flex items-center gap-2 rounded-lg p-3 text-xs"
              style={{ background: 'var(--color-surface)', color: 'var(--color-text-primary)' }}>
              <Icono nombre="candado" size={16} className="shrink-0" />
              Solo lectura · Auditoría observa, no ejecuta acciones.
            </div>
          )}
        </div>
      )}
      {/* 4 · comprobante: consultar y bajar la factura van juntos porque son la misma intención (consulta = enlaces). */}
      <div className="lateral-bloque">
        <h3 className="lateral-titulo">Comprobante</h3>
        <ul className="lista-simple">
          <li>
            <span>Factura de la aseguradora</span>
            <button type="button" className="enlace-btn" onClick={() => setVerSoportes(true)}>
              <Icono nombre="ojo" size={14} className="shrink-0" />Ver soporte
            </button>
          </li>
          {descarga && <li><BotonComprobanteDetalle soat={soat} descarga={descarga} enlace /></li>}
        </ul>
      </div>
      {/* 4b · documentos adicionales (HU 13363): solo con `soat.documentos_adicionales.ver` (si no, el bloque se oculta). */}
      {/* El filete lo pone `.lateral-bloque`: la sección trae el suyo propio y quedaban dos líneas seguidas. */}
      <div className="lateral-bloque [&>section]:border-t-0 [&>section]:pt-0"><DocumentosAdicionalesSeccion soatId={soat.id} /></div>
    </>
  );

  return (
    <FlitModalHorizontal nombreAccesible={`SOAT · ${soat.placa ?? soat.vin}`} titulo="SOAT"
      chips={<><ChipEstadoSoat estado={soat.estado} />{soat.estancado && <ChipSinGestion desde={soat.enviadoEn} />}</>}
      lateral={lateral} etiquetaLateral="Estado del SOAT"
      etiquetaContenido={`Datos del SOAT ${soat.placa ?? soat.vin}`}
      onClose={onClose} restoreFocusRef={restoreFocusRef}>
      <div className="text-sm">
        {/* Bloque principal «Datos»: 3 · la acción del estado en el encabezado (UNA primaria, «Cargar comprobante de
            SOAT»; en `con_novedad` «Reactivar» va secundaria), y debajo el vehículo y 5 · las fichas. */}
        <section className="card" aria-labelledby={idDatos}>
          <div className="bloque-cabeza">
            <h3 id={idDatos} className="seccion__titulo">Datos</h3>
            {hayAccionDelEstado && accion === 'idle' && !protegido && (
              <div className="acciones-fila">
                {cargaFactura && (
                  // `<label>` con el input `sr-only` y no `hidden`: con `display:none` el input no se
                  // podía enfocar y la acción primaria del gestor no se alcanzaba sin ratón (D6).
                  <label className={`${claseBoton('primary', 'sm')} acciones-fila__primaria cursor-pointer has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-offset-2 has-[input:focus-visible]:outline-[color:var(--kit-azul)]`}>
                    <Icono nombre="archivo-subir" size={16} className="shrink-0" />
                    {enviando ? 'Cargando…' : 'Cargar comprobante de SOAT'}
                    <input type="file" accept=".pdf,.png,.jpg,.jpeg" className="sr-only" disabled={enviando}
                      onChange={(e) => { const f = e.target.files?.[0]; if (f) void subirFactura(f); e.target.value = ''; }} />
                  </label>
                )}
                {rechazable && <button type="button" className={btnSm('secondary')} onClick={() => setAccion('rechazar')}>Rechazar</button>}
                {reactivable && <button type="button" className={btnSm('secondary')} onClick={() => setAccion('reactivar')}>Reactivar</button>}
              </div>
            )}
          </div>
          {/* Con un formulario abierto el error va junto a su «Confirmar» (ver `FormMotivo`). */}
          {error && accion === 'idle' && <p role="alert" className="mb-3" style={{ color: 'var(--kit-rojo-texto)' }}>{error}</p>}
          {cargaFactura && accion === 'idle' && protegido && (
            <div className="mb-4 space-y-3 rounded-[9px] border p-3" style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface)' }}>
              <p className="flex items-start gap-2" style={{ color: 'var(--color-text-primary)' }}>
                <Icono nombre="candado" size={16} className="mt-0.5 shrink-0" />
                <span>Este PDF está protegido con contraseña.</span>
              </p>
              <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); reintentarProtegido(); }}>
                <label className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-[9px] px-1 text-sm transition-colors hover:bg-[color:var(--kit-hover)] lg:min-h-10"
                  style={{ color: 'var(--color-text-primary)' }}>
                  <input type="checkbox" className="flit-focus size-4 shrink-0 cursor-pointer accent-[var(--kit-azul)]" checked={usarNombre}
                    disabled={enviando} autoFocus={!protegido.nombreNoAbre && !protegido.incorrecta}
                    onChange={(e) => { setUsarNombre(e.target.checked); setContrasena(''); }} />
                  Usar el nombre del archivo como contraseña
                </label>
                {!usarNombre && (
                  <CampoContrasenaPdf label={`Contraseña de ${protegido.archivo.name}`} valor={contrasena} onCambio={setContrasena}
                    disabled={enviando} autoFocus
                    ayuda={protegido.nombreNoAbre ? AYUDA_NOMBRE_NO_ABRE : protegido.incorrecta ? 'La contraseña no abre este PDF.' : null} />
                )}
                <div className="flex flex-wrap gap-2">
                  <button type="submit" className={flitBtnPrimary} style={flitBtnPrimaryStyle} disabled={enviando || (!usarNombre && !contrasena)}>
                    <Icono nombre="archivo-subir" size={16} className="shrink-0" />
                    {enviando ? 'Cargando…' : 'Cargar con contraseña'}
                  </button>
                  <button type="button" className={flitBtnSecondary} disabled={enviando} onClick={cancelarProtegido}>Cancelar</button>
                </div>
              </form>
            </div>
          )}
          {accion === 'rechazar' && formMotivo('Motivo del rechazo', 'rechazar', {}, 'registrar el rechazo',
            `Rechazo registrado: ${placa} quedó ${ESTADO_SOAT_LABEL[EstadoSoat.CON_NOVEDAD]}.`)}
          {accion === 'reactivar' && formMotivo('Motivo de la corrección', 'reactivar', {}, 'reactivar el SOAT',
            `${placa} volvió a gestión.`)}

          {soat.placa
            ? <Vehiculo icono={null} placa={soat.placa} tipoServicio={soat.tipoServicio} anunciarServicio={false}
              nombre={nombreVehiculo || '—'} meta={metaVehiculo || undefined} />
            : <p className="vehiculo__nombre m-0 font-semibold">{nombreVehiculo || '—'} <span className="font-normal">{metaVehiculo}</span></p>}

          {/* 5 · datos. Los de la trastienda no se pintan «—» para el Cliente: se omiten, porque el
              backend no se los manda y una fila vacía sugiere un dato que existe y no cargó. Las
              fechas del TRÁMITE en FLIT llegan aquí desde la tabla (P-2). La vigencia (HU 12097) va
              con hora y con «—», nivel de auditoría; el número de póliza del RUNT no se enseña en
              ninguna parte (cuasi-PII, y choca de nombre con `numero_poliza`). VIN y vehículo van arriba. */}
          <div className="mt-4">
            <Fichas items={[
              { etiqueta: 'Compañía', valor: soat.companiaNombre },
              { etiqueta: 'Organismo', valor: soat.organismoNombre ?? '—' },
              { etiqueta: 'Trámite creado', valor: fechaDia(soat.fechaCreacion) },
              { etiqueta: 'Trámite aprobado', valor: soat.fechaAprobacion ? fechaDia(soat.fechaAprobacion) : 'Sin aprobar' },
              ...(!esCliente ? [{
                etiqueta: 'Gestiona',
                valor: soat.gestionOperaciones
                  ? `Operaciones${soat.proveedorSoatNombre ? ` · retomado de ${soat.proveedorSoatNombre}` : ''}`
                  : soat.proveedorSoatNombre ?? '—',
              }, { etiqueta: 'Enviado por', valor: soat.enviadoPorNombre ?? '—' }] : []),
              { etiqueta: 'Enviado', valor: fecha(soat.enviadoEn) },
              ...(!esCliente ? [
                { etiqueta: 'Valor pagado', valor: pesos(soat.valorPagado) },
                { etiqueta: 'Vigencia', valor: textoVigenciaSoat(soat.vigencia) },
                { etiqueta: 'Último dato del RUNT', valor: fecha(soat.vigencia?.verificadaEn ?? null) },
              ] : []),
            ]} />
          </div>
        </section>
        {verSoportes && (
          <VisorSoportes ruta={`/flito/soat/${soat.id}/soportes`} titulo={`SOAT ${soat.placa ?? soat.vin}`}
            vacio="Este SOAT no tiene ninguna factura cargada todavía."
            onClose={() => setVerSoportes(false)} />
        )}

        {/* 6 · compradores */}
        {soat.compradores.length > 0 && (
          <Seccion titulo="Compradores">
            <ul className="lista-simple">
              {soat.compradores.map((c) => (
                <li key={c.orden}>
                  <span>{c.nombreCompleto} · {documentoConTipo(c.tipoDocumento, c.numeroDocumento)}</span>
                  {c.porcentajeParticipacion !== null && <span className="tabular-nums">{c.porcentajeParticipacion}%</span>}
                </li>
              ))}
            </ul>
          </Seccion>
        )}

        {/* 7 · correcciones de Operaciones: acciones de excepción, aparte y en ghost, para que no compitan con
            la del día. Sin condición de origen (HU 12079/12080: el estado que la justificaba ya no existe). */}
        {hayCorreccion && (
          <Seccion titulo="Corregir el caso">
            {accion === 'idle' || accion === 'rechazar' || accion === 'reactivar' ? (
              <div className="flex flex-wrap gap-2">
                {corrReversar && <button type="button" className={btnSm('ghost')} onClick={() => setAccion('reversar')}>Reversar</button>}
                {corrProveedor && <button type="button" className={btnSm('ghost')} onClick={() => setAccion('proveedor')}>Cambiar proveedor</button>}
                {corrAsumir && <button type="button" className={btnSm('ghost')} onClick={() => setAccion('asumir')}>Asumir en Operaciones</button>}
                {corrDevolver && <button type="button" className={btnSm('ghost')} onClick={() => setAccion('devolver')}>Devolver al proveedor</button>}
              </div>
            ) : (
              <div className="rounded-lg border p-3" style={{ borderColor: 'var(--color-border)' }}>
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
                    {formMotivo('Motivo de la devolución (mín. 5 caracteres)', 'devolver-gestor', { proveedorSoatId: proveedorElegido },
                      'devolver el SOAT al proveedor', `${placa} volvió al proveedor.`, { minLen: 5, deshabilitado: !proveedorElegido })}
                  </>
                )}
                {accion === 'proveedor' && (
                  <>
                    {selectProveedor('Nuevo proveedor')}
                    {formMotivo('Motivo del cambio', 'proveedor', { proveedorSoatId: proveedorElegido }, 'cambiar el proveedor',
                      `Proveedor cambiado para ${placa}.`, { deshabilitado: !proveedorElegido })}
                  </>
                )}
              </div>
            )}
          </Seccion>
        )}

        {/* 8 · historial: REGISTRO INTERNO de la operación. No se le ofrece al Cliente (HU 11914):
            lo que él necesita es el estado y, si volvió con novedad, el motivo — que van al lateral. */}
        {!esCliente && <div className="mt-4"><HistorialEstados concepto="soat" registroId={soat.id} /></div>}
      </div>
    </FlitModalHorizontal>
  );
}

/** Sección de consulta tras el bloque principal (`zona` del kit apaisado). */
function Seccion({ titulo, children }: { titulo: string; children: ReactNode }) {
  return (
    <div className="mt-4 border-t pt-4" style={{ borderColor: 'var(--color-divider)' }}>
      <h3 className="seccion__titulo">{titulo}</h3>
      {children}
    </div>
  );
}

function FormMotivo({ etiqueta, motivo, setMotivo, enviando, error, minLen = 1, deshabilitado = false, onConfirmar, onCancelar }: {
  etiqueta: string; motivo: string; setMotivo: (v: string) => void; enviando: boolean; error: string | null; minLen?: number;
  deshabilitado?: boolean; onConfirmar: () => void; onCancelar: () => void;
}) {
  return (
    <div className="mt-2 space-y-2">
      <FlitField label={etiqueta}>
        <textarea className={`${flitInp} min-h-[64px]`} value={motivo} onChange={(e) => setMotivo(e.target.value)} />
      </FlitField>
      {error && <p role="alert" style={{ color: 'var(--kit-rojo-texto)' }}>{error}</p>}
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
