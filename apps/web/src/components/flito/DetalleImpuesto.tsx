// FLITO — Detalle de un impuesto de la cola (modal). Sale de `pages/FlitoImpuestos.tsx` en la HU
// #12592: la página rozaba `max-lines` y el detalle gana aquí el chip de documentos, el dato
// «Liquidado el», el botón «Cargar recibo de caja» y su modal. La HU #13209 suma al lado «Cargar
// comprobante» (liquidación o pago por fase, `ModalCargaReciboFase`). La HU #13270 suma la celda
// «Comprobante en FLIT 2» (solo lectura) y «Reemplazar comprobante» (`ModalReemplazoComprobante`); la
// HU #13312 la generaliza a FLIT 1 (`EnvioComprobante`).

import { useRef, useState, type ReactNode } from 'react';
import {
  ESTADO_IMPUESTO_LABEL, EstadoImpuesto, TipoSoporte,
  type DatosDocumentoFacturaImpuesto, type DireccionCompradorImpuesto, type FaseRecibo, type ReprogramacionEnvioComprobante,
} from '@operaciones/shared-types';
import { api, errorMessage } from '../../lib/api';
import FlitModal from '../flit/FlitModal';
import HistorialEstados from '../flit/HistorialEstados';
import StatusChip from '../flit/StatusChip';
import ChipSinGestion from '../flit/ChipSinGestion';
import VisorSoportes from '../flit/VisorSoportes';
import ModalFacturaVenta, { esNombrePlacaOrganismo, nombreFacturaVenta } from '../flit/ModalFacturaVenta';
import { documentoConTipo, fechaCorta } from '../flit/columnasComunes';
import { Fichas } from '../flit/Bloques';
import { Icono } from '../flit/kit/Icono';
import { FlitField, flitInp, flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle } from '../flit/flitPageKit';
import ModalReciboCaja from './ModalReciboCaja';
import ModalCargaReciboFase, { type ResultadoConEscritura } from './ModalCargaReciboFase';
import ModalReemplazoComprobante from './ModalReemplazoComprobante';
import { CeldaEnvioComprobante, textoToastReemplazo } from './EnvioComprobante';
import { toastOk } from '../flit/ToastFlito';
import { ChipDocumentos, TONO_IMPUESTO, fecha, pesos, type ImpuestoItem } from './ImpuestoCola';
import { SeccionValidacion, useDetalleValidacion, type Carga } from './ValidacionRunt';
import { AvisoDireccion, DireccionComprador, EstadoCargaDireccion } from './DireccionComprador';
import { DatosDocumentoFactura, EstadoCargaDocumentoFactura } from './DatosDocumentoFactura';

const ESTADOS_OPERACIONES: EstadoImpuesto[] = [
  EstadoImpuesto.PENDIENTE, EstadoImpuesto.SOLICITADO, EstadoImpuesto.CON_NOVEDAD, EstadoImpuesto.PAGADO,
];

type Accion = 'idle' | 'rechazar' | 'reactivar' | 'reversar' | 'asumir' | 'devolver' | 'corregirFactura' | 'reintentarFactura';

export default function DetalleImpuesto({
  imp, esOperaciones, esGestor, soloLectura, puedeCargarCaja, puedeCargarComprobante = false, puedeCorregirDireccion = false,
  puedeReemplazarComprobante = false, puedeCorregirFactura = false,
  onClose, onCambio, onTraspaso, accionReintento, sinPermisoReintento,
}: {
  imp: ImpuestoItem; esOperaciones: boolean; esGestor: boolean; soloLectura: boolean;
  /** `hasFuncion('impuestos.recibos.cargar_caja')`: sin ella el botón no se pinta (ni en gris). */
  puedeCargarCaja: boolean;
  /** `hasFuncion('impuestos.recibos.cargar')` (HU #13209): sin ella «Cargar comprobante» no se pinta. */
  puedeCargarComprobante?: boolean;
  onClose: () => void; onCambio: () => void; onTraspaso: () => void;
  /** «Reintentar validación» (HU #12832), montado por la página; secundario aquí. */
  accionReintento?: ReactNode; sinPermisoReintento?: boolean;
  /** `hasFuncion('impuestos.tramite.corregir_direccion')` (HU #12834): sin ella, la dirección es texto. */
  puedeCorregirDireccion?: boolean;
  /** `hasFuncion('impuestos.recibos.reemplazar')` (HU #13270): sin ella «Reemplazar comprobante» no se pinta. */
  puedeReemplazarComprobante?: boolean;
  /** `hasFuncion('impuestos.tramite.certificar')` (HU #14664): mismo permiso de «Reintentar validación»; sin ella «Corregir»/«Reintentar lectura» no se pintan. */
  puedeCorregirFactura?: boolean;
}) {
  const [accion, setAccion] = useState<Accion>('idle');
  const [motivo, setMotivo] = useState('');
  const [estadoDestino, setEstadoDestino] = useState<EstadoImpuesto>(EstadoImpuesto.PENDIENTE);
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  // Visor de los recibos de ESTE impuesto, encima del detalle.
  const [verSoportes, setVerSoportes] = useState(false);
  // Visor de la factura de venta (modal): blob url + nombre para descargar.
  const [factura, setFactura] = useState<{ url: string; nombre: string } | null>(null);
  // Recibo de caja puntual (HU #12592), encima del detalle.
  const [reciboCaja, setReciboCaja] = useState(false);
  // Comprobante por fase (HU #13209), encima del detalle.
  const [comprobante, setComprobante] = useState(false);
  // Reemplazo del comprobante de pago (HU #13270), encima del detalle.
  const [reemplazo, setReemplazo] = useState(false);
  // Mismo hueco que `pagadoDesde`, para «Cargar comprobante»: si la carga completa las dos fases el
  // botón se apaga en el commit del cierre y el foco cae en «Ver soporte», no en un botón que se va.
  const [ambosDesdeCarga, setAmbosDesdeCarga] = useState(false);
  // Tras un `pagado` (de cualquiera de las dos cargas) el detalle NO se cierra (AC6): se refresca a Pagado. Pero entre el «Listo» y la
  // fila nueva hay una petición en vuelo, y en ese hueco el impuesto de las props sigue Solicitado:
  // esta marca apaga el botón en el mismo commit en que se cierra el modal, para que el foco no
  // vuelva a un botón que va a desaparecer un tick después, sino a «Ver soporte».
  const [pagadoDesde, setPagadoDesde] = useState(false);
  const verSoporteRef = useRef<HTMLButtonElement>(null);
  // HU #12834: el detalle se pide UNA vez y lo comparten la sección de validación y la dirección.
  // Tras guardar la dirección se parchea aquí, sin volver a pedirlo: el aviso se va y la fila de la
  // tabla comparativa muestra lo guardado en el mismo render.
  const { carga: cargaApi, recargar } = useDetalleValidacion(imp.id, true, imp.analisisEstado);
  const [direccionGuardada, setDireccionGuardada] = useState<DireccionCompradorImpuesto | null>(null);
  // HU #14664: la corrección o el reintento de número/fecha/avalúo se parcha aquí, sin recargar todo
  // el detalle — mismo criterio que `direccionGuardada`.
  const [datosFacturaActualizados, setDatosFacturaActualizados] = useState<DatosDocumentoFacturaImpuesto | null>(null);
  const carga: Carga = cargaApi.fase === 'listo' && (direccionGuardada || datosFacturaActualizados)
    ? {
      fase: 'listo',
      datos: {
        ...cargaApi.datos,
        ...(direccionGuardada ? { direccionComprador: direccionGuardada } : {}),
        ...(datosFacturaActualizados ? { datosDocumentoFactura: datosFacturaActualizados } : {}),
      },
    }
    : cargaApi;
  const direccion = carga.fase === 'listo' ? carga.datos.direccionComprador : null;
  const campoDireccionRef = useRef<HTMLInputElement>(null);
  const analisisTerminado = imp.analisisEstado === 'completado' || imp.analisisEstado === 'error_analisis';
  const revisarDireccion = () => {
    if (campoDireccionRef.current) campoDireccionRef.current.focus();
    else document.getElementById(`direccion-${imp.id}`)?.focus();
  };

  const enGestion = imp.estado === EstadoImpuesto.SOLICITADO;
  const rechazado = imp.estado === EstadoImpuesto.CON_NOVEDAD;
  // El traspaso de gestión solo tiene sentido mientras el impuesto está en gestión y sin pagar:
  // sobre uno Pagado no queda nada que gestionar, y uno Pendiente aún no se ha enviado a nadie.
  const traspasable = enGestion || rechazado;
  // El botón existe solo con la función Y en gestión; sin liquidación sigue en el DOM (alcanzable
  // con Tab) pero `aria-disabled` y con el motivo visible: es «primero haz esto», no «no puedes».
  const ofreceCaja = puedeCargarCaja && enGestion && !pagadoDesde;
  // Calco de `ofreceCaja` (spec #13209): solo con la función, fuera de Auditoría, en gestión o pagado
  // y con alguna fase por cargar. Pendiente/Con novedad no (el API respondería 409).
  const ofreceComprobante = puedeCargarComprobante && !soloLectura && !ambosDesdeCarga
    && (enGestion || imp.estado === EstadoImpuesto.PAGADO) && imp.documentos !== 'ambos';
  const sinLiquidacion = imp.liquidadoEn === null;
  // HU #13270: «hay comprobante de pago vigente». `imp.documentos` NO sirve solo: cuenta el recibo de
  // caja como «pago» (`documentosDe` en el API) y el reemplazo solo toca el `recibo_impuesto`. Con el
  // detalle cargado se mira el tipo de sus soportes no descartados; mientras carga (o si el API no
  // los trae) vale el proxy de `documentos`, y el 409 `sin_comprobante_vigente` ataja el resto.
  const soportesDetalle = carga.fase === 'listo' ? carga.datos.soportes : undefined;
  const tienePagoVigente = soportesDetalle
    ? soportesDetalle.some((s) => s.tipo === TipoSoporte.RECIBO_IMPUESTO)
    : imp.documentos === 'pago' || imp.documentos === 'ambos';
  const ofreceReemplazo = puedeReemplazarComprobante && !soloLectura
    && imp.estado === EstadoImpuesto.PAGADO && tienePagoVigente;

  const ejecutar = async (fn: () => Promise<unknown>) => {
    setEnviando(true); setError(null);
    try { await fn(); onCambio(); }
    catch (e) { setError(errorMessage(e)); }
    finally { setEnviando(false); }
  };

  /**
   * El traspaso de gestión no cierra el detalle: quien lo asume suele querer seguir en el mismo
   * impuesto, y ver ahí mismo que ya lo gestiona Operaciones es la confirmación de que funcionó.
   * Si el traspaso lo saca de la vista filtrada, la fila desaparece y el detalle se cierra solo.
   */
  const traspasar = async (ruta: string) => {
    setEnviando(true); setError(null);
    try {
      await api.post(`/flito/impuestos/${imp.id}/${ruta}`, { motivo });
      setAccion('idle'); setMotivo(''); onTraspaso();
    }
    catch (e) { setError(errorMessage(e)); }
    finally { setEnviando(false); }
  };

  /**
   * Factura de venta: viene de FLIT y la sirve la API. Integración FLIT (Fase 8).
   *
   * Antes se abría con `window.open(URL.createObjectURL(blob))`. Una URL `blob:` no lleva nombre,
   * así que el navegador guardaba el archivo con un identificador interno y SIN extensión: no abría
   * con doble clic y había que renombrarlo a mano. Ahora se muestra en el visor, que descarga con
   * un nombre de verdad y en `.pdf`.
   */
  // El nombre lo pone el SERVIDOR desde la HU #11910 (AC5): `PLACA-ORGANISMO.<ext>`, el mismo con el
  // que sale dentro del ZIP, para que las dos descargas se puedan emparejar en la misma carpeta. El
  // cliente valida la forma y cae al respaldo si no encaja.
  const verFactura = async () => {
    setError(null);
    try {
      const { blob, nombre } = await api.getBlobNamed(
        `/flito/impuestos/${imp.id}/factura-venta`,
        nombreFacturaVenta(imp.idFlit),
        esNombrePlacaOrganismo,
      );
      setFactura({ url: URL.createObjectURL(blob), nombre });
    } catch (e) { setError(errorMessage(e)); }
  };
  const cerrarFactura = () => { if (factura) URL.revokeObjectURL(factura.url); setFactura(null); };

  /**
   * Los dos desenlaces refrescan la cola SIN cerrar el detalle (`onTraspaso`), que se pinta desde
   * la fila nueva: con `pagado` pasa a Pagado y el botón desaparece; con `en_revision` el impuesto
   * sigue Solicitado y el chip de documentos pasa a «Ambos». El foco vuelve al botón que abrió el
   * modal o, cuando ese botón ya no existe, a «Ver soporte» (respaldo del focus trap).
   */
  const listoReciboCaja = (resultado: 'pagado' | 'en_revision') => {
    if (resultado === 'pagado') setPagadoDesde(true);
    setReciboCaja(false);
    onTraspaso();
  };

  /** «Listo» tras una carga por fase con escritura: mismo refresco sin cerrar el detalle. */
  const listoComprobante = (resultado: ResultadoConEscritura, fase: FaseRecibo) => {
    if (resultado === 'pagado') setPagadoDesde(true);
    if (imp.documentos !== null && imp.documentos !== fase) setAmbosDesdeCarga(true);
    setComprobante(false);
    onTraspaso();
  };

  /** 200 `reemplazado`: cierra, un solo toast y dos refrescos sin cerrar el detalle (AC4). */
  const listoReemplazo = (envio: ReprogramacionEnvioComprobante | undefined) => {
    setReemplazo(false);
    const { texto, largo } = textoToastReemplazo(envio);
    toastOk(texto, largo ? { duracionMs: 8_000 } : {});
    recargar();
    onTraspaso();
  };
  const refrescarTodo = () => { recargar(); onTraspaso(); };

  // Los formularios de motivo se pintan en el sitio del grupo que los abrió (zona 3 o 7) y su error va
  // junto a su «Confirmar»; el resto de errores (p. ej. abrir la factura) va en la zona 2.
  const formAbierto = accion === 'rechazar' || accion === 'reactivar' || accion === 'asumir' || accion === 'devolver' || accion === 'reversar';
  const cancelar = () => { setAccion('idle'); setMotivo(''); setError(null); };
  const hayAccionDelEstado = !soloLectura && ((enGestion && (esOperaciones || esGestor)) || (rechazado && esOperaciones));
  const hayCorreccion = !soloLectura && esOperaciones;
  const formCorreccion = accion === 'asumir' || accion === 'devolver' || accion === 'reversar';
  const datos: Array<{ etiqueta: string; valor: ReactNode }> = [
    { etiqueta: 'VIN', valor: imp.vin },
    { etiqueta: 'Trámite FLIT', valor: imp.tipoTramite ? `${imp.idFlit} · ${imp.tipoTramite}` : imp.idFlit },
    { etiqueta: 'Compañía', valor: imp.companiaNombre },
    { etiqueta: 'Organismo', valor: imp.organismoNombre ?? imp.organismoCodigo },
    { etiqueta: 'Gestiona', valor: imp.gestionOperaciones ? 'Operaciones (contingencia)' : 'Gestor del organismo' },
    // Llegan aquí desde la tabla (Épica #14560, §3.3): datos de consulta, no de decisión.
    { etiqueta: 'Trámite creado', valor: fechaCorta(imp.fechaCreacion) },
    { etiqueta: 'Trámite aprobado', valor: imp.fechaAprobacion ? fechaCorta(imp.fechaAprobacion) : 'Sin aprobar' },
    { etiqueta: 'Comprador', valor: imp.compradorNombre ?? '—' },
    { etiqueta: 'Documento', valor: documentoConTipo(imp.compradorTipoDocumento, imp.compradorDocumento) },
    { etiqueta: 'Enviado por', valor: imp.enviadoPorNombre ?? '—' },
    { etiqueta: 'Enviado', valor: fecha(imp.enviadoEn) },
    { etiqueta: 'Valor liquidado', valor: pesos(imp.valorLiquidado) },
    { etiqueta: 'Liquidado el', valor: fecha(imp.liquidadoEn) },
    { etiqueta: 'Valor pagado', valor: pesos(imp.valorPagado) },
    { etiqueta: 'Pagado el', valor: fecha(imp.pagadoEn) },
    {
      etiqueta: 'Factura de venta',
      valor: imp.tieneFacturaVenta
        ? (
          <button type="button" onClick={verFactura}
            className="flit-focus rounded font-semibold underline transition-colors hover:bg-[var(--kit-hover)]"
            style={{ color: 'var(--color-action)' }}>
            En FLIT · Ver / descargar
          </button>
        )
        : <span style={{ color: 'var(--flit-warning)' }}>Sin factura en FLIT</span>,
    },
  ];

  // Orden de arriba abajo (Épica #14560, `docs/ux/flito-soat-impuestos-patron-unificado.md` §4.1), el
  // mismo de `DetalleSoat`: 1 · estado  2 · aviso contextual  3 · acción del estado  4 · comprobante
  // 5 · datos  6 · particularidad (validación RUNT, documento de factura, dirección)  7 · «Corregir el
  // caso» (Operaciones)  8 · historial. Solo cambia el orden y el color de los avisos: qué botón se
  // ofrece, cuándo y con qué permiso sigue igual.
  return (
    <FlitModal title={`Impuesto · ${imp.placa ?? imp.vin}`} onClose={onClose} wide>
      <div className="space-y-4 text-sm">
        {/* 1 · estado */}
        <div className="flex flex-wrap items-center gap-2">
          <StatusChip tone={TONO_IMPUESTO[imp.estado]}>{ESTADO_IMPUESTO_LABEL[imp.estado]}</StatusChip>
          {imp.estancado && <ChipSinGestion desde={imp.enviadoEn} />}
          {imp.marcadoPorDiferencia && <StatusChip tone="warning">Diferencia de valor</StatusChip>}
          <ChipDocumentos imp={imp} />
        </div>

        {/* 2 · aviso contextual: todo lo persistente, arriba. Antes el motivo y el solo lectura iban al
            final con colores sin par oscuro; ahora con los tokens de `DetalleSoat` para el mismo aviso. */}
        {imp.motivoRechazo && (
          <div role="alert" className="rounded-lg border p-3" style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)' }}>
            <p className="flex items-center gap-2 font-semibold" style={{ color: 'var(--kit-rojo-texto)' }}>
              <Icono nombre="alerta" size={18} className="shrink-0" />
              Motivo de rechazo
            </p>
            <p className="mt-1" style={{ color: 'var(--color-text-primary)' }}>{imp.motivoRechazo}</p>
          </div>
        )}
        {soloLectura && (
          <div role="status" className="flex items-center gap-2 rounded-lg p-3"
            style={{ background: 'var(--color-surface)', color: 'var(--color-action)' }}>
            <Icono nombre="candado" size={16} className="shrink-0" />
            Solo lectura · Auditoría observa, no ejecuta acciones.
          </div>
        )}
        {/* HU #12834 (AC1, AC3): aviso persistente de la dirección. */}
        <AvisoDireccion direccion={direccion} puedeCorregir={puedeCorregirDireccion && !soloLectura} onRevisar={revisarDireccion} />
        {error && !formAbierto && <p role="alert" style={{ color: 'var(--kit-rojo-texto)' }}>{error}</p>}

        {/* 3 · la acción del estado: Rechazar (en gestión) / Reactivar (con novedad). */}
        {hayAccionDelEstado && accion === 'idle' && (
          <div className="flex flex-wrap gap-2">
            {enGestion && (esOperaciones || esGestor) && (
              <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={() => setAccion('rechazar')}>Rechazar</button>
            )}
            {rechazado && esOperaciones && (
              <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={() => setAccion('reactivar')}>Reactivar</button>
            )}
          </div>
        )}
        {(accion === 'rechazar' || accion === 'reactivar') && (
          <FormMotivo etiqueta={accion === 'rechazar' ? 'Motivo del rechazo' : 'Motivo de la corrección'}
            motivo={motivo} setMotivo={setMotivo} enviando={enviando} error={error} onCancelar={cancelar}
            onConfirmar={() => ejecutar(() => api.post(`/flito/impuestos/${imp.id}/${accion}`, { motivo }))} />
        )}

        {/* 4 · comprobante: ver y cargar la evidencia del pago, fuera de la ficha de datos. El recibo del
            organismo se carga desde esta pantalla y se mira desde donde se gestiona (el gestor del
            organismo no entra al reporte de costos). */}
        <Seccion titulo="Comprobante">
          <div role="group" aria-label="Acciones del comprobante" className="flex flex-wrap items-center gap-2">
            <button ref={verSoporteRef} type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle}
              onClick={() => setVerSoportes(true)}>
              <Icono nombre="ojo" size={16} className="shrink-0" />
              Ver soporte
            </button>
            {ofreceComprobante && (
              <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle}
                onClick={() => setComprobante(true)}>
                Cargar comprobante
              </button>
            )}
            {ofreceCaja && (
              <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle}
                aria-disabled={sinLiquidacion || undefined}
                aria-describedby={sinLiquidacion ? 'recibo-caja-motivo' : undefined}
                onClick={() => { if (!sinLiquidacion) setReciboCaja(true); }}>
                Cargar recibo de caja
              </button>
            )}
            {ofreceReemplazo && (
              <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle}
                onClick={() => setReemplazo(true)}>
                Reemplazar comprobante
              </button>
            )}
          </div>
          {ofreceCaja && sinLiquidacion && (
            <p id="recibo-caja-motivo" className="text-xs" style={{ color: 'var(--color-text-secondary)' }}>
              {ofreceComprobante
                ? 'Este impuesto no tiene liquidación cargada. Cárgala primero con «Cargar comprobante».'
                : 'Este impuesto no tiene liquidación cargada; el recibo de caja se carga sobre una liquidación'}
            </p>
          )}
          {/* «Comprobante en FLIT 1/2» (HU #13270/#13312): solo lectura, la misma intención. */}
          <dl className="dl">
            <CeldaEnvioComprobante impId={imp.id} carga={carga} recargar={recargar} hayCargarComprobante={ofreceComprobante} />
          </dl>
        </Seccion>

        {/* 5 · datos */}
        <Seccion titulo="Datos">
          <Fichas items={datos} />
        </Seccion>

        {/* 6 · particularidad de Impuestos: validación RUNT (HU #12831), documento de factura (HU #14664)
            y dirección del comprador (HU #12834), al mismo nivel. */}
        <div className="space-y-4 border-t pt-4" style={{ borderColor: 'var(--color-border)' }}>
        <SeccionValidacion imp={imp} accionReintento={accionReintento} sinPermiso={sinPermisoReintento} detalle={{ carga, recargar }} />

        {/* Mismo fetch compartido; cargando/error solo si la validación de arriba todavía no los cubre. */}
        {carga.fase === 'listo'
          ? (
            <DatosDocumentoFactura impId={imp.id} datos={carga.datos.datosDocumentoFactura ?? null}
              puedeCorregir={puedeCorregirFactura && !soloLectura}
              abierta={accion === 'corregirFactura' ? 'corregir' : accion === 'reintentarFactura' ? 'reintentar' : null}
              bloqueada={accion !== 'idle' && accion !== 'corregirFactura' && accion !== 'reintentarFactura'}
              onAbrir={(forma) => setAccion(forma === 'corregir' ? 'corregirFactura' : 'reintentarFactura')}
              onCerrar={() => setAccion('idle')}
              onActualizado={(d) => { setDatosFacturaActualizados(d); setAccion('idle'); }} />
          )
          : !analisisTerminado && <EstadoCargaDocumentoFactura fase={carga.fase} onRecargar={recargar} />}

        {carga.fase === 'listo'
          ? (
            <DireccionComprador impId={imp.id} direccion={direccion} puedeCorregir={puedeCorregirDireccion && !soloLectura}
              bloqueada={accion !== 'idle'} campoRef={campoDireccionRef}
              onGuardada={(d) => { setDireccionGuardada(d); onTraspaso(); }} />
          )
          : !analisisTerminado && <EstadoCargaDireccion fase={carga.fase} onRecargar={recargar} />}
        </div>

        {/* 7 · correcciones de Operaciones: acciones de excepción, aparte de la del estado. */}
        {/* Con un formulario de otra zona abierto (Rechazar/Reactivar, factura) no se pinta: quedaba
            el título sin ningún botón debajo. */}
        {hayCorreccion && (accion === 'idle' || formCorreccion) && (
          <Seccion titulo="Corregir el caso">
            {formCorreccion ? (
              <div className="rounded-lg border p-3" style={{ borderColor: 'var(--color-border)' }}>
                {/* Devolver no pide destinatario: el gestor sale del organismo del trámite, que no cambia. */}
                {(accion === 'asumir' || accion === 'devolver') && (
                  <FormMotivo etiqueta={accion === 'asumir'
                    ? 'Motivo para asumirlo en Operaciones (mín. 5 caracteres)'
                    : 'Motivo de la devolución al gestor (mín. 5 caracteres)'}
                    motivo={motivo} setMotivo={setMotivo} enviando={enviando} error={error} minLen={5} onCancelar={cancelar}
                    onConfirmar={() => traspasar(accion === 'asumir' ? 'asumir-operaciones' : 'devolver-gestor')} />
                )}
                {accion === 'reversar' && (
                  <>
                    <FlitField label="Estado destino">
                      <select className={flitInp} value={estadoDestino} onChange={(e) => setEstadoDestino(e.target.value as EstadoImpuesto)}>
                        {ESTADOS_OPERACIONES.map((e) => <option key={e} value={e}>{ESTADO_IMPUESTO_LABEL[e]}</option>)}
                      </select>
                    </FlitField>
                    <FormMotivo etiqueta="Motivo de la reversa (mín. 5 caracteres)" motivo={motivo} setMotivo={setMotivo}
                      enviando={enviando} error={error} minLen={5} onCancelar={cancelar}
                      onConfirmar={() => ejecutar(() => api.post(`/flito/impuestos/${imp.id}/reversar`, { estadoDestino, motivo }))} />
                  </>
                )}
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                {traspasable && !imp.gestionOperaciones && (
                  <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={() => setAccion('asumir')}>Asumir en Operaciones</button>
                )}
                {traspasable && imp.gestionOperaciones && (
                  <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={() => setAccion('devolver')}>Devolver al gestor</button>
                )}
                <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={() => setAccion('reversar')}>Reversar</button>
              </div>
            )}
          </Seccion>
        )}

        {verSoportes && (
          <VisorSoportes ruta={`/flito/impuestos/${imp.id}/soportes`} titulo={`Impuesto ${imp.placa ?? imp.vin}`}
            vacio="Este impuesto no tiene ningún recibo cargado todavía."
            onClose={() => setVerSoportes(false)} />
        )}

        {factura && <ModalFacturaVenta url={factura.url} nombre={factura.nombre} onCerrar={cerrarFactura} />}

        {reciboCaja && (
          <ModalReciboCaja imp={imp} restoreFocusRef={verSoporteRef}
            onClose={() => setReciboCaja(false)} onListo={listoReciboCaja} onRefrescar={onTraspaso} />
        )}

        {comprobante && (
          <ModalCargaReciboFase imp={imp} restoreFocusRef={verSoporteRef}
            onClose={() => setComprobante(false)} onListo={listoComprobante} onRefrescar={onTraspaso} />
        )}

        {reemplazo && (
          <ModalReemplazoComprobante imp={imp} restoreFocusRef={verSoporteRef}
            envioComprobante={carga.fase === 'listo' ? carga.datos.envioComprobante : undefined}
            onClose={() => setReemplazo(false)} onReemplazado={listoReemplazo} onRefrescar={refrescarTodo} />
        )}

        {/* 8 · historial (sin canal Cliente en Impuestos: siempre visible). */}
        <HistorialEstados concepto="impuesto" registroId={imp.id} />
      </div>
    </FlitModal>
  );
}

function Seccion({ titulo, children }: { titulo: string; children: ReactNode }) {
  return (
    <div className="space-y-2 border-t pt-4" style={{ borderColor: 'var(--color-border)' }}>
      <p className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--color-text-tertiary)' }}>{titulo}</p>
      {children}
    </div>
  );
}

function FormMotivo({ etiqueta, motivo, setMotivo, enviando, error, minLen = 1, onConfirmar, onCancelar }: {
  etiqueta: string; motivo: string; setMotivo: (v: string) => void; enviando: boolean; error: string | null; minLen?: number;
  onConfirmar: () => void; onCancelar: () => void;
}) {
  return (
    <div className="mt-2 space-y-2">
      <FlitField label={etiqueta}>
        <textarea className={`${flitInp} min-h-[64px]`} value={motivo} onChange={(e) => setMotivo(e.target.value)} />
      </FlitField>
      {error && <p role="alert" style={{ color: 'var(--kit-rojo-texto)' }}>{error}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="button" className={flitBtnPrimary} style={flitBtnPrimaryStyle}
          disabled={enviando || motivo.trim().length < minLen} onClick={onConfirmar}>
          {enviando ? 'Enviando…' : 'Confirmar'}
        </button>
        <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={onCancelar}>Cancelar</button>
      </div>
    </div>
  );
}
