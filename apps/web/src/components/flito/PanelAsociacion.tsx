// FLITO — panel de asociación de un comprobante PENDIENTE (HU #12634, Feature #12606, Épica #12245).
// Las tres decisiones (¿pago o documentación? · trámite · concepto) pre-llenadas con lo que leyó el
// servidor, los campos editables con su chip de confianza, el motivo cuando hay algo que justificar,
// y el pie con UNA primaria (Aplicar / Adjuntar) y Descartar. Lo que no es de aquí (cabecera del
// detalle, visor, Releer) lo pinta `DetalleComprobante` y entra como `children`.
//
// Reglas que se certifican aquí:
//  · La primaria NUNCA se apaga por validación (criterio #11915): se valida al pulsar, con
//    `aria-invalid` + `<p role="alert">` y foco al primer campo con error. Única excepción, por
//    spec (UX slim Bug #12913): en un PAGO de servicios adicionales «Aplicar» espera al tipo de
//    servicio, con la razón escrita bajo el botón.
//  · Bug #12913: ese pago elige su tipo de servicio (`servicioTipoId`) y el valor del comprobante
//    entra a la puente del trámite. El campo solo existe en ese caso; en cualquier otro NO viaja
//    (el API da 400 si llega de más).
//  · Se decide por `codigo` del `ErrorComprobanteDto`, nunca por texto. Un 409 con `puedeAdjuntar`
//    es un CAMINO (bloque sin rojo + «Adjuntar como documentación»), no un error (slim D-8).
//  · Al servidor viaja solo el delta de campos (D-7) y el motivo solo cuando hay algo que justificar
//    (AC2: campo editado, trámite ≠ sugerido, concepto o marca de pago distintos de lo leído).
//  · Nunca se pinta `extraccion` cruda: solo `campos[]` con el nivel que calcula el servidor.

import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  CONCEPTOS_COSTO, CONCEPTO_COSTO_LABEL, CodigoErrorComprobante,
  type AplicarComprobanteBody, type CampoComprobanteDto, type CandidatoTramiteDto, type ComprobanteDetalleDto, type ConceptoCosto,
  type ServicioAdicionalTipo, type ServiciosAdicionalesDeTramite,
} from '@operaciones/shared-types';
import { ApiError, api, errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { hasPage } from '../../lib/permissions';
import { rutaServiciosDeTramite, tipoIdsDe } from '../../lib/serviciosAdicionalesTramite';
import BuscadorTipoServicio from '../finanzas/BuscadorTipoServicio';
import {
  ADMISION_LABEL, AYUDA_MOTIVO, CAMPOS_OCULTOS, MOTIVO_MAX, MOTIVO_MIN, aplicarComprobante, chipConfianza, deltaCampos,
  descartarComprobante, errorComprobante, esCampoEditable, labelCampo, llaveSugerido, pesosComprobante,
} from '../../lib/comprobantes';
import StatusChip from '../flit/StatusChip';
import { flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle, flitInp } from '../flit/flitPageKit';
import ComboboxTramite, { type Sugerido } from './ComboboxTramite';

// Copy exacto de la ficha UX §7.6 / slim §5 (AC3, AC4, AC5, AC7).
export const MSG_ES_PAGO = 'Di si es un comprobante de pago o documentación.';
export const MSG_TRAMITE = 'Elige el trámite al que pertenece.';
export const MSG_CONCEPTO = 'Elige el concepto.';
export const MSG_VALOR = 'Escribe el valor pagado: sin valor no se puede aplicar un pago.';
export const MSG_MOTIVO = 'Escribe por qué cambias lo leído (mínimo 5 caracteres).';
export const MSG_TIPO_SERVICIO = 'Elige el tipo de servicio para aplicar este pago.';
export const RAZON_SIN_TIPO = 'Elige el tipo de servicio para aplicar.';
const COPY_TIPO_DE_BAJA = 'Ese tipo de servicio ya no está activo. Elige otro.';
const COPY_SA_LIQUIDADO = 'El trámite ya está liquidado: no se le pueden asignar servicios. Reversa la liquidación y vuelve a aplicar.';
export const MSG_MOTIVO_DESCARTE = 'Escribe el motivo del descarte (mínimo 5 caracteres).';
const COPY_403 = 'Tu usuario no puede aplicar comprobantes. Vuelve a entrar para actualizar tus permisos.';
const COPY_YA_RESUELTO = 'Alguien resolvió este comprobante mientras lo tenías abierto.';
const COPY_NO_APLICAR = 'Tu usuario puede ver este comprobante pero no aplicarlo.';
const COPY_SIN_BUSCAR_NI_SUGERIDOS = 'No hay trámites sugeridos para este documento y tu usuario no puede buscar trámites. Pídele a un administrador la función “Buscar trámites para un comprobante”, o descarta el comprobante.';
const COPY_NOTA_DESCARTE = 'El documento queda como descartado y su archivo deja de contar como duplicado: se podrá volver a cargar.';
const COPY_FALLO = 'No se pudo aplicar. Vuelve a intentarlo.';
const AYUDA_VALOR = 'Pesos, sin puntos ni signo';
const PELIGRO = { color: 'var(--flit-danger-ink)' } as const;
const SECUNDARIO = { color: 'var(--flit-text-secondary)' } as const;

/** «Ese {SOAT | impuesto | derecho de tránsito} ya está pagado.» (AC4, aviso anticipado D6). */
const COSA_PAGADA: Partial<Record<ConceptoCosto, string>> = { soat: 'SOAT', impuesto: 'impuesto', derecho: 'derecho de tránsito' };
const cosaPagada = (c: ConceptoCosto) => COSA_PAGADA[c] ?? CONCEPTO_COSTO_LABEL[c].toLowerCase();

type Respuesta =
  | { tipo: 'error'; texto: string }
  | { tipo: 'actualizar'; texto: string }
  | { tipo: 'camino'; texto: string; puedeAdjuntar: boolean }
  | { tipo: 'liquidado'; texto: string }
  | { tipo: 'documentado'; texto: string; anteriorId: string | null };

type Clave = 'esPago' | 'tramite' | 'concepto' | 'servicioTipo' | 'valorTotal' | 'motivo';

const esPagoSa = (esPago: boolean | null, concepto: ConceptoCosto | '') => esPago === true && concepto === 'servicios_adicionales';
/** «95000» / «95.000» → 95000; lo escrito en el campo Valor, para el toast. */
const valorEscrito = (v: string | undefined) => Number((v ?? '').replace(/\D/g, '')) || 0;

const CAMPO_VALOR_VACIO: CampoComprobanteDto = { campo: 'valorTotal', valor: null, confianza: 0, confiable: false, nivel: null, confirmadoPor: null };

function candidatoDe(detalle: ComprobanteDetalleDto): CandidatoTramiteDto | null {
  const fijado = detalle.tramite;
  if (!fijado) return null;
  return detalle.candidatos.find((c) => c.tramiteId === fijado.id)
    ?? { tramiteId: fijado.id, idFlit: fijado.idFlit, placa: fijado.placa, vin: null, tipoTramite: null, empresa: null, flitEstado: null, liquidado: false, admite: {} as CandidatoTramiteDto['admite'] };
}

/** El servicio elegido en un pago SA: si ya estaba asignado, el toast dice que su valor se actualizó. */
interface ServicioAplicado { nombre: string; valor: number; yaAsignado: boolean }

function toastAplicado(c: ComprobanteDetalleDto, esPago: boolean, idFlit: string, concepto: ConceptoCosto, servicio?: ServicioAplicado): string {
  const id = c.tramite?.idFlit ?? idFlit;
  if (!esPago) return `Documentación adjuntada a ${id}.`;
  if (servicio) {
    const valor = pesosComprobante(servicio.valor);
    return servicio.yaAsignado
      ? `Pago aplicado. «${servicio.nombre}» de ${id} se actualizó a ${valor}.`
      : `Pago aplicado. «${servicio.nombre}» quedó asignado a ${id} por ${valor}.`;
  }
  let texto = `Comprobante aplicado a ${id} · ${CONCEPTO_COSTO_LABEL[c.concepto ?? concepto]}.`;
  if (c.marcadoPorDiferencia && c.diferenciaTarifa !== null && c.diferenciaTarifa !== 0) {
    const signo = c.diferenciaTarifa > 0 ? '+' : '−';
    texto += ` El valor difiere de la tarifa (${signo}${pesosComprobante(Math.abs(c.diferenciaTarifa))}): acéptala desde el reporte de costos.`;
  }
  return texto;
}

export default function PanelAsociacion({ detalle, children, onResuelto, onActualizarCola }: {
  detalle: ComprobanteDetalleDto;
  /** La cabecera del detalle (estado, carga, «Leído») y, si toca, el bloque de Releer: van dentro del área que desplaza. */
  children: ReactNode;
  /** 200 de aplicar o descartar: el texto del toast; el detalle cierra y la página refresca. */
  onResuelto: (toast: string) => void;
  /** `ya_resuelto` / 404: cierra y refresca la cola. */
  onActualizarCola: () => void;
}) {
  const { hasFuncion, user } = useAuth();
  const puedeAplicar = hasFuncion('comprobantes.comprobante.aplicar');
  const puedeDescartar = hasFuncion('comprobantes.comprobante.descartar');
  const puedeBuscar = hasFuncion('comprobantes.tramites.buscar');
  const veReporteCostos = hasPage(user, 'finanzas_reporte_costos');
  const id = useId();

  const [esPago, setEsPago] = useState<boolean | null>(detalle.esPago);
  const [tramite, setTramite] = useState<CandidatoTramiteDto | null>(() => candidatoDe(detalle));
  const [concepto, setConcepto] = useState<ConceptoCosto | ''>(detalle.concepto ?? '');
  const [valores, setValores] = useState<Record<string, string>>(() => Object.fromEntries(detalle.campos.map((c) => [c.campo, c.valor ?? ''])));
  const [motivo, setMotivo] = useState('');
  const [errores, setErrores] = useState<Partial<Record<Clave, string>>>({});
  const [enviando, setEnviando] = useState(false);
  const [respuesta, setRespuesta] = useState<Respuesta | null>(null);
  const [reemplazo, setReemplazo] = useState<{ motivo: string; error: string | null } | null>(null);
  const [descarte, setDescarte] = useState<{ motivo: string; error: string | null; enviando: boolean } | null>(null);
  const [servicioTipo, setServicioTipo] = useState<ServicioAdicionalTipo | null>(null);
  const [recargaCatalogo, setRecargaCatalogo] = useState(0);
  const [asignadosTramite, setAsignadosTramite] = useState<string[]>([]);

  const refs = {
    esPago: useRef<HTMLInputElement>(null), tramite: useRef<HTMLInputElement>(null), concepto: useRef<HTMLSelectElement>(null),
    servicioTipo: useRef<HTMLInputElement>(null), valorTotal: useRef<HTMLInputElement>(null), motivo: useRef<HTMLTextAreaElement>(null),
  };
  const botonDescartarRef = useRef<HTMLButtonElement>(null);

  const sugeridos: Sugerido[] = detalle.candidatos.map((c) => ({ candidato: c, llave: llaveSugerido(c, detalle) }));
  const sinCombobox = sugeridos.length === 0 && !puedeBuscar; // estado (g) del slim

  // Foco al abrir (slim §6): al input del combobox, después de que la trampa de foco del modal
  // haya puesto el suyo en el diálogo (el efecto del hijo corre antes que el del padre).
  useEffect(() => {
    const t = setTimeout(() => refs.tramite.current?.focus(), 0);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const camposTodos = detalle.campos.some((c) => c.campo === 'valorTotal') ? detalle.campos : [...detalle.campos, CAMPO_VALOR_VACIO];
  const camposVisibles = camposTodos.filter((c) => !CAMPOS_OCULTOS.has(c.campo) && !(c.campo === 'valorTotal' && esPago === false));
  const delta = deltaCampos(camposTodos, valores);

  // AC2: hay algo que justificar si se editó un campo, se eligió un trámite distinto del fijado, o
  // se cambió el concepto o la marca de pago respecto a lo LEÍDO (elegir donde no había lectura no cambia nada).
  const tramiteCambiado = tramite !== null && tramite.tramiteId !== detalle.tramite?.id;
  const conceptoCambiado = detalle.concepto !== null && concepto !== '' && concepto !== detalle.concepto;
  const pagoCambiado = detalle.esPago !== null && esPago !== null && esPago !== detalle.esPago;
  const motivoMontado = tramiteCambiado || delta !== undefined || conceptoCambiado || pagoCambiado;

  const admision = tramite && concepto ? tramite.admite?.[concepto] : undefined;
  const avisoYaPagado = esPago === true && concepto !== '' && admision === 'ya_pagado';
  const idFlitElegido = tramite?.idFlit ?? '';
  const pideTipo = esPagoSa(esPago, concepto);
  const faltaTipo = pideTipo && !servicioTipo;
  const tramiteIdElegido = tramite?.tramiteId ?? null;

  // Qué tipos lleva ya el trámite, solo para marcarlos en la lista («se actualizará el valor»). Es
  // una ayuda, no una condición: sin permiso de lectura del panel, la lista va sin marcas.
  useEffect(() => {
    if (!pideTipo || !tramiteIdElegido) { setAsignadosTramite([]); return; }
    let vivo = true;
    api.get<ServiciosAdicionalesDeTramite>(rutaServiciosDeTramite(tramiteIdElegido))
      .then((r) => { if (vivo) setAsignadosTramite(tipoIdsDe(r.items)); })
      .catch(() => { if (vivo) setAsignadosTramite([]); });
    return () => { vivo = false; };
  }, [pideTipo, tramiteIdElegido]);

  const validar = (): Partial<Record<Clave, string>> => {
    const e: Partial<Record<Clave, string>> = {};
    if (esPago === null) e.esPago = MSG_ES_PAGO;
    if (!tramite) e.tramite = MSG_TRAMITE;
    if (!concepto) e.concepto = MSG_CONCEPTO;
    if (faltaTipo) e.servicioTipo = MSG_TIPO_SERVICIO;
    if (esPago === true && !(valores.valorTotal ?? '').trim()) e.valorTotal = MSG_VALOR;
    if (motivoMontado && motivo.trim().length < MOTIVO_MIN) e.motivo = MSG_MOTIVO;
    return e;
  };
  const enfocar = (e: Partial<Record<Clave, string>>) => {
    const primera = (['esPago', 'tramite', 'concepto', 'servicioTipo', 'valorTotal', 'motivo'] as Clave[]).find((k) => e[k]);
    if (primera) refs[primera].current?.focus();
  };

  const adjuntarComoDocumentacion = () => { setEsPago(false); setRespuesta(null); void enviar(false); };

  const manejarError = (e: unknown) => {
    const err = errorComprobante(e);
    const status = e instanceof ApiError ? e.status : 0;
    if (status === 403) { setRespuesta({ tipo: 'error', texto: COPY_403 }); return; }
    if (status === 404) { setRespuesta({ tipo: 'actualizar', texto: err?.error ?? 'Este comprobante ya no existe.' }); return; }
    const nombreConcepto = concepto ? CONCEPTO_COSTO_LABEL[concepto] : 'este concepto';
    const sa = esPagoSa(esPago, concepto);
    switch (err?.codigo) {
      case CodigoErrorComprobante.YA_RESUELTO:
        setRespuesta({ tipo: 'actualizar', texto: COPY_YA_RESUELTO }); return;
      case CodigoErrorComprobante.YA_PAGADO:
      case CodigoErrorComprobante.DESTINO_NO_ADMITE:
        setRespuesta({ tipo: 'camino', texto: `${idFlitElegido} no admite ${nombreConcepto} como pago: ${err.detalle ?? err.error}.`, puedeAdjuntar: err.puedeAdjuntar === true }); return;
      case CodigoErrorComprobante.TRAMITE_LIQUIDADO:
        if (sa) { setRespuesta({ tipo: 'liquidado', texto: COPY_SA_LIQUIDADO }); return; }
        setRespuesta({ tipo: 'liquidado', texto: `La liquidación de ${idFlitElegido} está sellada. Reversa la liquidación en el reporte de costos y vuelve a aplicar.` }); return;
      case CodigoErrorComprobante.VALOR_YA_DOCUMENTADO:
        if (sa) {
          const nombre = servicioTipo ? `«${servicioTipo.nombre}»` : 'Ese servicio';
          setRespuesta({ tipo: 'documentado', texto: `${nombre} ya tiene un comprobante de pago aplicado en ${idFlitElegido}. Para usar este, descarta el anterior.`, anteriorId: err.comprobanteAnteriorId ?? null });
          return;
        }
        setRespuesta({ tipo: 'documentado', texto: `${idFlitElegido} ya tiene un valor de ${nombreConcepto} documentado con otro comprobante. Para usar este, descarta el anterior.`, anteriorId: err.comprobanteAnteriorId ?? null }); return;
      case CodigoErrorComprobante.VALOR_REQUERIDO:
        setErrores({ valorTotal: MSG_VALOR }); requestAnimationFrame(() => refs.valorTotal.current?.focus()); return;
      case CodigoErrorComprobante.DATOS_INVALIDOS:
        // Los dos 400 del tipo de servicio (Bug #12913) se distinguen por el texto del API, que es
        // contrato del addendum de ADR-0018; ninguno de los dos se pinta crudo.
        if (sa && /ya no está disponible/i.test(err.error ?? '')) {
          setServicioTipo(null); setRecargaCatalogo((n) => n + 1);
          setRespuesta({ tipo: 'error', texto: COPY_TIPO_DE_BAJA });
          return;
        }
        if (sa && /exige elegir el servicio/i.test(err.error ?? '')) {
          setServicioTipo(null);
          setErrores({ servicioTipo: MSG_TIPO_SERVICIO }); requestAnimationFrame(() => refs.servicioTipo.current?.focus());
          return;
        }
        setRespuesta({ tipo: 'error', texto: `Revisa los datos marcados. ${err.error}` });
        if (motivoMontado) requestAnimationFrame(() => refs.motivo.current?.focus());
        return;
      default:
        setRespuesta({ tipo: 'error', texto: `${COPY_FALLO} ${err?.error ?? errorMessage(e)}` });
    }
  };

  /** `pagoForzado === false` es el camino «Adjuntar como documentación»: reenvía con lo escrito, sin volver a pedir motivo. */
  const enviar = async (pagoForzado?: false) => {
    if (!tramite || !concepto || (pagoForzado === undefined && esPago === null)) return;
    const ep = pagoForzado ?? esPago!;
    const body: AplicarComprobanteBody = { tramiteId: tramite.tramiteId, concepto, esPago: ep };
    // Solo en un pago SA; «Adjuntar como documentación» (ep = false) no lo lleva nunca.
    const tipo = esPagoSa(ep, concepto) ? servicioTipo : null;
    if (tipo) body.servicioTipoId = tipo.id;
    if (delta) body.campos = delta;
    if (motivo.trim()) body.motivo = motivo.trim().slice(0, MOTIVO_MAX);
    setEnviando(true); setErrores({});
    try {
      const r = await aplicarComprobante(detalle.id, body);
      const servicio = tipo ? { nombre: tipo.nombre, valor: valorEscrito(valores.valorTotal), yaAsignado: asignadosTramite.includes(tipo.id) } : undefined;
      onResuelto(toastAplicado(r.comprobante, ep, tramite.idFlit, concepto, servicio));
    } catch (e) {
      manejarError(e);
    } finally {
      setEnviando(false);
    }
  };

  const onSubmit = (ev: FormEvent) => {
    ev.preventDefault();
    if (enviando) return;
    const e = validar();
    setErrores(e); setRespuesta(null);
    if (Object.keys(e).length) { enfocar(e); return; }
    void enviar();
  };

  const descartarAnteriorYAplicar = async () => {
    if (!reemplazo || respuesta?.tipo !== 'documentado' || !respuesta.anteriorId) return;
    if (reemplazo.motivo.trim().length < MOTIVO_MIN) { setReemplazo({ ...reemplazo, error: MSG_MOTIVO_DESCARTE }); return; }
    setEnviando(true);
    try {
      await descartarComprobante(respuesta.anteriorId, reemplazo.motivo.trim());
    } catch (e) {
      setReemplazo({ ...reemplazo, error: `No se pudo descartar el anterior. ${errorMessage(e)}` }); setEnviando(false); return;
    }
    setReemplazo(null); setRespuesta(null);
    await enviar();
  };

  const confirmarDescarte = async () => {
    if (!descarte) return;
    if (descarte.motivo.trim().length < MOTIVO_MIN) { setDescarte({ ...descarte, error: MSG_MOTIVO_DESCARTE }); return; }
    setDescarte({ ...descarte, error: null, enviando: true });
    try {
      await descartarComprobante(detalle.id, descarte.motivo.trim());
      onResuelto('Comprobante descartado.');
    } catch (e) {
      const err = errorComprobante(e);
      const status = e instanceof ApiError ? e.status : 0;
      if (status === 404) { setDescarte(null); setRespuesta({ tipo: 'actualizar', texto: err?.error ?? 'Este comprobante ya no existe.' }); return; }
      if (err?.codigo === CodigoErrorComprobante.YA_RESUELTO) { setDescarte(null); setRespuesta({ tipo: 'actualizar', texto: COPY_YA_RESUELTO }); return; }
      setDescarte({ ...descarte, enviando: false, error: `No se pudo descartar. ${err?.error ?? errorMessage(e)}` });
    }
  };
  const cerrarDescarte = () => { setDescarte(null); requestAnimationFrame(() => botonDescartarRef.current?.focus()); };

  const rotuloPrimaria = esPago === false ? 'Adjuntar' : 'Aplicar';
  const errorId = (k: Clave) => `${id}-err-${k}`;
  const alerta = (k: Clave) => errores[k] && <p id={errorId(k)} role="alert" className="text-xs" style={PELIGRO}>{errores[k]}</p>;

  return (
    <form className="flex min-h-0 flex-1 flex-col" noValidate onSubmit={onSubmit} aria-label="Asociar comprobante">
      <div className="min-h-0 flex-1 space-y-4 overflow-auto pr-1">
        {children}

        {/* (1) ¿Pago o documentación? — preseleccionado solo si `detalle.esPago` es confiable (D-6). */}
        <fieldset className="space-y-1">
          <legend className="flex items-center gap-2 text-xs font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
            ¿Qué es este documento? <ChipCampo campos={detalle.campos} campo="esComprobantePago" />
          </legend>
          <div className="flex flex-wrap gap-4">
            {([['pago', true, 'Comprobante de pago'], ['doc', false, 'Documentación del trámite']] as const).map(([k, v, rotulo], i) => (
              <label key={k} className="flex items-center gap-2 text-sm" style={{ color: 'var(--flit-text-primary)' }}>
                <input ref={i === 0 ? refs.esPago : undefined} type="radio" name={`${id}-esPago`} value={k} checked={esPago === v}
                  aria-invalid={errores.esPago ? true : undefined} aria-describedby={errores.esPago ? errorId('esPago') : undefined}
                  onChange={() => { setEsPago(v); setRespuesta(null); if (!v) setServicioTipo(null); }} className="flit-focus" />
                {rotulo}
              </label>
            ))}
          </div>
          {alerta('esPago')}
        </fieldset>

        {/* (2) Trámite */}
        <div className="space-y-1">
          <label htmlFor={`${id}-tramite`} className="text-xs font-semibold" style={{ color: 'var(--flit-text-primary)' }}>Trámite <span aria-hidden="true">*</span></label>
          {sinCombobox
            ? <p className="text-xs" style={SECUNDARIO}>{COPY_SIN_BUSCAR_NI_SUGERIDOS}</p>
            : <ComboboxTramite inputId={`${id}-tramite`} sugeridos={sugeridos} elegido={tramite} onElegir={(c) => { setTramite(c); setRespuesta(null); }} concepto={concepto || null}
                puedeBuscar={puedeBuscar} abrirAlMontar={!detalle.tramite && sugeridos.length > 0} inputRef={refs.tramite} invalido={!!errores.tramite} errorId={errorId('tramite')} />}
          {alerta('tramite')}
        </div>

        {/* (3) Concepto — sufijo « · {admisión}» según el trámite elegido, SIN apagar opciones (D6). */}
        <div className="space-y-1">
          <label htmlFor={`${id}-concepto`} className="flex items-center gap-2 text-xs font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
            Concepto <span aria-hidden="true">*</span> <ChipCampo campos={detalle.campos} campo="concepto" />
          </label>
          <select id={`${id}-concepto`} ref={refs.concepto} className={flitInp} value={concepto} aria-required="true"
            aria-invalid={errores.concepto ? true : undefined} aria-describedby={errores.concepto ? errorId('concepto') : undefined}
            onChange={(e) => { setConcepto(e.target.value as ConceptoCosto | ''); setRespuesta(null); setServicioTipo(null); setErrores((x) => ({ ...x, servicioTipo: undefined })); }}>
            <option value="">Elige el concepto…</option>
            {CONCEPTOS_COSTO.map((c) => {
              const a = tramite?.admite?.[c];
              return <option key={c} value={c}>{CONCEPTO_COSTO_LABEL[c]}{a && a !== 'admite' ? ` · ${ADMISION_LABEL[a]}` : ''}</option>;
            })}
          </select>
          {alerta('concepto')}
        </div>

        {/* (3b) Tipo de servicio — solo en un PAGO de servicios adicionales (Bug #12913). */}
        {pideTipo && (
          <div className="space-y-1">
            <BuscadorTipoServicio modo="elegir" inputId={`${id}-servicio-tipo`} asignados={asignadosTramite} elegido={servicioTipo}
              onElegir={(t) => { setServicioTipo(t); setRespuesta(null); if (t) setErrores((x) => ({ ...x, servicioTipo: undefined })); }}
              recarga={recargaCatalogo} inputRef={refs.servicioTipo} invalido={!!errores.servicioTipo} errorId={errorId('servicioTipo')} />
            {alerta('servicioTipo')}
          </div>
        )}

        {avisoYaPagado && (
          <div role="status" aria-live="polite" className="space-y-2 rounded-lg border p-3 text-sm" style={{ borderColor: 'var(--flit-border-input)', ...SECUNDARIO }}>
            <p>Ese {cosaPagada(concepto as ConceptoCosto)} ya está pagado.</p>
            <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={() => { setEsPago(false); setRespuesta(null); }}>Adjuntar como documentación</button>
          </div>
        )}

        {/* Campos de §7.5: solo los `campos[]` que trae el servidor (D-5), cada uno con su chip. */}
        <p className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--flit-text-muted)' }}>Datos leídos</p>
        <div className="space-y-2">
          {camposVisibles.map((c) => {
            const chip = chipConfianza(c);
            const esValor = c.campo === 'valorTotal';
            const editable = esCampoEditable(c.campo);
            const inputId = `${id}-campo-${c.campo}`;
            const ayudaId = esValor ? `${id}-ayuda-valor` : undefined;
            const describedBy = [ayudaId, errores.valorTotal && esValor ? errorId('valorTotal') : undefined].filter(Boolean).join(' ') || undefined;
            return (
              <div key={c.campo} className="space-y-0.5 border-b pb-2" style={{ borderColor: 'var(--flit-border-soft)' }}>
                <div className="flex items-center justify-between gap-2">
                  {editable
                    ? <label htmlFor={inputId} className="text-xs font-semibold" style={{ color: 'var(--flit-text-primary)' }}>{esValor ? 'Valor' : labelCampo(c.campo)}</label>
                    : <span className="text-xs font-semibold" style={{ color: 'var(--flit-text-primary)' }}>{labelCampo(c.campo)}</span>}
                  <StatusChip tone={chip.tono}>{chip.texto}</StatusChip>
                </div>
                {editable ? (
                  <>
                    <input id={inputId} ref={esValor ? refs.valorTotal : undefined} className={flitInp} value={valores[c.campo] ?? ''}
                      inputMode={esValor ? 'numeric' : undefined} aria-describedby={describedBy} aria-invalid={esValor && errores.valorTotal ? true : undefined}
                      onChange={(e) => { setValores((v) => ({ ...v, [c.campo]: e.target.value })); setRespuesta(null); }} />
                    {esValor && <p id={ayudaId} className="text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>{AYUDA_VALOR}</p>}
                    {esValor && alerta('valorTotal')}
                  </>
                ) : (
                  <p className="min-h-[1.25rem] break-words text-sm" style={{ color: 'var(--flit-text-primary)' }}>{c.valor ?? ''}</p>
                )}
              </div>
            );
          })}
        </div>

        {motivoMontado && (
          <div className="space-y-1">
            <label htmlFor={`${id}-motivo`} className="text-xs font-semibold" style={{ color: 'var(--flit-text-primary)' }}>Por qué cambias lo leído</label>
            <textarea id={`${id}-motivo`} ref={refs.motivo} className={`${flitInp} min-h-[64px]`} value={motivo} maxLength={MOTIVO_MAX}
              aria-describedby={`${id}-ayuda-motivo${errores.motivo ? ` ${errorId('motivo')}` : ''}`} aria-invalid={errores.motivo ? true : undefined}
              onChange={(e) => setMotivo(e.target.value)} />
            <p id={`${id}-ayuda-motivo`} className="text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>{AYUDA_MOTIVO}</p>
            {alerta('motivo')}
          </div>
        )}

        {respuesta && (
          <div role="alert" className="space-y-2 rounded-lg border p-3 text-sm"
            style={respuesta.tipo === 'camino' ? { borderColor: 'var(--flit-border-input)', ...SECUNDARIO } : { borderColor: 'var(--flit-border-input)', color: 'var(--flit-danger-ink)' }}>
            <p>{respuesta.texto}{respuesta.tipo === 'camino' && respuesta.puedeAdjuntar ? ' Puedes adjuntar este documento como documentación del trámite.' : ''}</p>
            {respuesta.tipo === 'camino' && respuesta.puedeAdjuntar && (
              <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} disabled={enviando} onClick={adjuntarComoDocumentacion}>Adjuntar como documentación</button>
            )}
            {respuesta.tipo === 'actualizar' && (
              <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={onActualizarCola}>Actualizar la cola</button>
            )}
            {respuesta.tipo === 'liquidado' && veReporteCostos && (
              <Link to="/finanzas/reporte-costos" className="flit-focus inline-block text-sm underline" style={{ color: 'var(--flit-blue-text)' }}>Ir al reporte de costos</Link>
            )}
            {respuesta.tipo === 'documentado' && respuesta.anteriorId && !reemplazo && (
              <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={() => setReemplazo({ motivo: '', error: null })}>Reemplazar</button>
            )}
            {respuesta.tipo === 'documentado' && reemplazo && (
              <div className="space-y-1">
                <label htmlFor={`${id}-motivo-anterior`} className="text-xs font-semibold" style={{ color: 'var(--flit-text-primary)' }}>Motivo para descartar el anterior</label>
                <textarea id={`${id}-motivo-anterior`} className={`${flitInp} min-h-[64px]`} value={reemplazo.motivo} maxLength={MOTIVO_MAX}
                  aria-describedby={`${id}-ayuda-anterior${reemplazo.error ? ` ${id}-err-anterior` : ''}`} aria-invalid={reemplazo.error ? true : undefined}
                  onChange={(e) => setReemplazo({ motivo: e.target.value, error: null })} />
                <p id={`${id}-ayuda-anterior`} className="text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>{AYUDA_MOTIVO}</p>
                {reemplazo.error && <p id={`${id}-err-anterior`} role="alert" className="text-xs" style={PELIGRO}>{reemplazo.error}</p>}
                <button type="button" className={flitBtnSecondary} style={{ ...flitBtnSecondaryStyle, ...PELIGRO }} disabled={enviando} onClick={descartarAnteriorYAplicar}>
                  {enviando ? 'Aplicando…' : 'Descartar el anterior y aplicar'}
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Pie fijo (slim §6). Con el bloque de descarte abierto, el bloque ES el pie. */}
      <div className="shrink-0 border-t pt-3" style={{ borderColor: 'var(--flit-border-soft)' }}>
        {descarte ? (
          <div className="space-y-2" onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cerrarDescarte(); } }}>
            <label htmlFor={`${id}-motivo-descarte`} className="text-xs font-semibold" style={{ color: 'var(--flit-text-primary)' }}>Motivo del descarte (mínimo 5 caracteres)</label>
            <textarea id={`${id}-motivo-descarte`} autoFocus className={`${flitInp} min-h-[64px]`} value={descarte.motivo} maxLength={MOTIVO_MAX}
              aria-describedby={`${id}-ayuda-descarte${descarte.error ? ` ${id}-err-descarte` : ''}`} aria-invalid={descarte.error ? true : undefined}
              onChange={(e) => setDescarte({ ...descarte, motivo: e.target.value, error: null })} />
            <p id={`${id}-ayuda-descarte`} className="text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>{AYUDA_MOTIVO}</p>
            <p className="text-xs" style={SECUNDARIO}>{COPY_NOTA_DESCARTE}</p>
            {descarte.error && <p id={`${id}-err-descarte`} role="alert" className="text-xs" style={PELIGRO}>{descarte.error}</p>}
            <div className="flex flex-wrap items-center justify-end gap-3">
              <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={cerrarDescarte}>Cancelar</button>
              <button type="button" className={flitBtnSecondary} style={{ ...flitBtnSecondaryStyle, ...PELIGRO }} disabled={descarte.enviando} onClick={confirmarDescarte}>
                {descarte.enviando ? 'Descartando…' : 'Descartar'}
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-end gap-3">
            {!puedeAplicar && <p className="mr-auto text-xs" style={SECUNDARIO}>{COPY_NO_APLICAR}</p>}
            {puedeAplicar && !sinCombobox && faltaTipo && (
              <p id={`${id}-razon-aplicar`} className="mr-auto text-xs" style={{ color: 'var(--flit-text-muted)' }}>{RAZON_SIN_TIPO}</p>
            )}
            {puedeDescartar && (
              <button ref={botonDescartarRef} type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} disabled={enviando}
                onClick={() => setDescarte({ motivo: '', error: null, enviando: false })}>Descartar</button>
            )}
            {puedeAplicar && !sinCombobox && (
              <button type="submit" className={flitBtnPrimary} style={flitBtnPrimaryStyle} disabled={enviando || faltaTipo}
                aria-describedby={faltaTipo ? `${id}-razon-aplicar` : undefined}>
                {enviando ? `${rotuloPrimaria === 'Adjuntar' ? 'Adjuntando' : 'Aplicando'}…` : rotuloPrimaria}
              </button>
            )}
          </div>
        )}
      </div>
    </form>
  );
}

/** Chip de confianza de un campo que NO se lista (esComprobantePago, concepto): va junto al legend / label de su decisión. */
function ChipCampo({ campos, campo }: { campos: readonly CampoComprobanteDto[]; campo: string }) {
  const c = campos.find((x) => x.campo === campo);
  const chip = c ? chipConfianza(c) : { texto: 'Sin lectura', tono: 'neutral' as const };
  return <StatusChip tone={chip.tono}>{chip.texto}</StatusChip>;
}
