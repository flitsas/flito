// FLITO — corregir un comprobante APLICADO desde su ficha (HU #13904, Feature #13886; UX
// `docs/ux/flito-comprobantes-desaplicar-reemplazar-13904-slim.md`). Envuelve la ficha de solo
// lectura (`children`) y le pone un pie con «Desaplicar» y «Reemplazar», cada uno guardado por su
// función (sin la función el botón NO existe; sin ninguna, no hay pie).
//
// - Desaplicar SE VUELVE el pie (destino + motivo), como «Descartar» en `PanelAsociacion`.
// - Reemplazar TOMA LA COLUMNA: la lista de pendientes ocupa el área que desplaza y el motivo y los
//   botones quedan en el pie. La lista tiene sus 4 estados (AC3).
// - Los errores se deciden por `codigo`, nunca por `err.error` crudo (AC4/AC5). Los persistentes van
//   como aviso en la ficha; validación y red en línea, conservando lo escrito (AC7).

import { useCallback, useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Link } from 'react-router-dom';
import {
  CONCEPTO_COSTO_LABEL, CodigoErrorComprobante, type ComprobanteDetalleDto, type ComprobanteListaDto,
  type DestinoDesaplicacion, type ListaComprobantesDto,
} from '@operaciones/shared-types';
import { ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import {
  AYUDA_MOTIVO, MOTIVO_MAX, MOTIVO_MIN, alertasSaldo, coincideConTramite, desaplicarComprobante, errorComprobante, fechaCarga,
  listarPendientesReemplazo, nombreBolsa, ordenarPendientesReemplazo, pesosComprobante, reemplazarComprobante, textoPeriodo,
  type AlertaSaldoBolsa,
} from '../../lib/comprobantes';
import { hasPage } from '../../lib/permissions';
import StatusChip from '../flit/StatusChip';
import { flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle, flitInp } from '../flit/flitPageKit';

const PELIGRO = { color: 'var(--flit-danger-ink)' } as const;
const PRIMARIO = { color: 'var(--flit-text-primary)' } as const;
const SECUNDARIO = { color: 'var(--flit-text-secondary)' } as const;
const TENUE = { color: 'var(--flit-text-muted)' } as const;

const MSG_DESTINO = 'Elige si el comprobante vuelve a la cola o se descarta.';
const MSG_MOTIVO_DESAPLICAR = 'Escribe el motivo para desaplicar (mínimo 5 caracteres).';
const MSG_ELEGIR = 'Elige el comprobante que va en su lugar.';
const MSG_MOTIVO_REEMPLAZO = 'Escribe el motivo del reemplazo (mínimo 5 caracteres).';
const MSG_403 = 'Tu usuario ya no puede corregir comprobantes. Vuelve a entrar para actualizar tus permisos.';
const MSG_RED: Record<Vista, string> = {
  desaplicar: 'No se pudo desaplicar. Revisa tu conexión y vuelve a intentarlo.',
  reemplazar: 'No se pudo reemplazar. Revisa tu conexión y vuelve a intentarlo.',
};
const COPY_ERROR_LISTA = 'No se pudieron cargar los comprobantes pendientes.';
const COPY_VACIO_LISTA = 'No hay comprobantes pendientes para usar en su lugar. Carga el comprobante correcto y vuelve aquí; si solo quieres quitar este, usa Desaplicar.';

const DESTINOS: { valor: DestinoDesaplicacion; rotulo: string; nota: string }[] = [
  { valor: 'pendiente', rotulo: 'Volver a la cola', nota: 'Queda pendiente para asociarlo otra vez.' },
  { valor: 'descartado', rotulo: 'Descartar', nota: 'Queda descartado y su archivo se podrá volver a cargar.' },
];

type Vista = 'desaplicar' | 'reemplazar';
/** Aviso persistente en la ficha (tabla §3): sigue siendo cierto mientras la ficha esté abierta. */
type Aviso = { texto: string; accion?: 'actualizar' | 'actualizarCola' | 'reporte' };
type Lista = { estado: 'cargando' } | { estado: 'error' } | { estado: 'lleno'; data: ListaComprobantesDto };

export interface Correccion { detalle: ComprobanteDetalleDto; toast: string; alertas: AlertaSaldoBolsa[] }

export default function CorregirAplicado({ detalle, children, onCorregido, onActualizar, onActualizarCola }: {
  detalle: ComprobanteDetalleDto;
  /** La ficha en solo lectura (cabecera, valor, motivo, datos leídos). */
  children: ReactNode;
  /** 200 de desaplicar o reemplazar: el detalle se repinta con lo devuelto, sin cerrar. */
  onCorregido: (c: Correccion) => void;
  /** `no_aplicado`: recarga el detalle y la cola. */
  onActualizar: () => void;
  /** 404: refresca la cola y cierra. */
  onActualizarCola: () => void;
}) {
  const { hasFuncion, user } = useAuth();
  const puedeDesaplicar = hasFuncion('comprobantes.comprobante.desaplicar');
  const puedeReemplazar = hasFuncion('comprobantes.comprobante.reemplazar');
  const id = useId();

  const [vista, setVista] = useState<Vista | null>(null);
  const [destino, setDestino] = useState<DestinoDesaplicacion | null>(null);
  const [motivo, setMotivo] = useState('');
  const [elegido, setElegido] = useState<string | null>(null);
  const [errores, setErrores] = useState<{ destino?: string; motivo?: string; elegido?: string }>({});
  const [errorEnvio, setErrorEnvio] = useState<{ texto: string; reintentar: boolean } | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [aviso, setAviso] = useState<Aviso | null>(null);
  const [lista, setLista] = useState<Lista>({ estado: 'cargando' });
  const [nonceLista, setNonceLista] = useState(0);

  const botonDesaplicarRef = useRef<HTMLButtonElement>(null);
  const botonReemplazarRef = useRef<HTMLButtonElement>(null);
  const primerDestinoRef = useRef<HTMLInputElement>(null);
  const primerPendienteRef = useRef<HTMLInputElement>(null);
  const motivoRef = useRef<HTMLTextAreaElement>(null);
  const enfocarPrimerPendiente = useRef(false);

  const idFlit = detalle.tramite?.idFlit ?? '—';
  const concepto = detalle.concepto ? CONCEPTO_COSTO_LABEL[detalle.concepto] : 'su concepto';
  const destinoTexto = `${idFlit} · ${concepto}`;

  // La lista del selector: la misma lectura de la cola, filtrada a pendientes (sin endpoint nuevo).
  useEffect(() => {
    if (vista !== 'reemplazar') return undefined;
    let vivo = true;
    setLista({ estado: 'cargando' });
    listarPendientesReemplazo()
      .then((data) => { if (vivo) setLista({ estado: 'lleno', data }); })
      .catch(() => { if (vivo) setLista({ estado: 'error' }); });
    return () => { vivo = false; };
  }, [vista, nonceLista]);

  const pendientes = lista.estado === 'lleno' ? ordenarPendientesReemplazo(lista.data.items.filter((c) => c.id !== detalle.id), detalle.tramite) : [];
  const listaVacia = lista.estado === 'lleno' && pendientes.length === 0;

  useEffect(() => {
    if (lista.estado === 'lleno' && enfocarPrimerPendiente.current && pendientes.length) {
      enfocarPrimerPendiente.current = false;
      primerPendienteRef.current?.focus();
    }
  }, [lista, pendientes.length]);

  const abrir = (v: Vista) => {
    setVista(v); setDestino(null); setMotivo(''); setElegido(null); setErrores({}); setErrorEnvio(null); setAviso(null);
    if (v === 'desaplicar') requestAnimationFrame(() => primerDestinoRef.current?.focus());
    else enfocarPrimerPendiente.current = true;
  };
  const cerrar = useCallback(() => {
    const v = vista;
    setVista(null); setErrores({}); setErrorEnvio(null);
    requestAnimationFrame(() => (v === 'reemplazar' ? botonReemplazarRef : botonDesaplicarRef).current?.focus());
  }, [vista]);
  // Esc con un bloque abierto lo cierra a él, no al detalle. Captura en `window` para ganarle al
  // `useEscape` de FlitModal aunque el foco aún no haya entrado al bloque; si hay otro modal encima
  // (el visor de soportes), Esc es suyo.
  useEffect(() => {
    if (!vista) return undefined;
    const alEscape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || enviando || document.querySelectorAll('[data-flit-modal]').length > 1) return;
      e.preventDefault(); e.stopPropagation(); cerrar();
    };
    window.addEventListener('keydown', alEscape, true);
    return () => window.removeEventListener('keydown', alEscape, true);
  }, [vista, enviando, cerrar]);

  /** Lo que no es validación: aviso en la ficha (cierra el bloque) o error en línea (lo deja abierto con todo intacto). */
  const manejarError = (e: unknown, v: Vista) => {
    const err = errorComprobante(e);
    const status = e instanceof ApiError ? e.status : err?.status;
    const enFicha = (a: Aviso) => { setVista(null); setAviso(a); };
    if (status === 403) { setErrorEnvio({ texto: MSG_403, reintentar: false }); return; }
    if (status === 404 || err?.codigo === CodigoErrorComprobante.NO_ENCONTRADO) {
      enFicha({ texto: 'Este comprobante ya no existe.', accion: 'actualizarCola' }); return;
    }
    switch (err?.codigo) {
      case CodigoErrorComprobante.PERIODO_CERRADO:
        enFicha({ texto: `No se puede corregir este comprobante: su descuento cae en ${textoPeriodo(err.periodo)} de ${nombreBolsa(err.bolsaNombre)}, y ese periodo ya está cerrado.` });
        return;
      case CodigoErrorComprobante.DUENO_NO_REVERSIBLE:
        enFicha({ texto: `Este pago no se deshace desde Comprobantes. Corrige el pago en su módulo (${concepto}).` }); return;
      case CodigoErrorComprobante.SERVICIO_NO_REVERSIBLE:
        enFicha({ texto: 'Este pago se aplicó antes de que FLITO guardara el valor anterior del servicio, así que no se puede deshacer aquí. Corrige el valor en Servicios adicionales.' });
        return;
      case CodigoErrorComprobante.TRAMITE_LIQUIDADO:
        enFicha({ texto: `La liquidación de ${idFlit} está sellada. Reversa la liquidación en el reporte de costos y vuelve a intentarlo.`, accion: 'reporte' });
        return;
      case CodigoErrorComprobante.NO_APLICADO:
        enFicha({ texto: 'Este comprobante ya no está aplicado: otro usuario lo desaplicó o lo reemplazó mientras lo tenías abierto.', accion: 'actualizar' });
        return;
      default:
        break;
    }
    if (v === 'reemplazar') {
      if (err?.codigo === CodigoErrorComprobante.YA_RESUELTO) {
        setElegido(null); setNonceLista((n) => n + 1);
        setErrorEnvio({ texto: 'El comprobante que elegiste ya no está pendiente. Elige otro.', reintentar: false }); return;
      }
      if (err?.codigo === CodigoErrorComprobante.VALOR_REQUERIDO) {
        setErrorEnvio({ texto: 'El comprobante que elegiste no tiene valor leído. Asócialo desde la cola para escribir el valor, o elige otro.', reintentar: false }); return;
      }
      if (err?.codigo === CodigoErrorComprobante.DESTINO_NO_ADMITE || err?.codigo === CodigoErrorComprobante.YA_PAGADO
        || err?.codigo === CodigoErrorComprobante.VALOR_YA_DOCUMENTADO) {
        setErrorEnvio({ texto: `${idFlit} no admite este comprobante como pago de ${concepto}. Elige otro.`, reintentar: false }); return;
      }
    }
    // Red, 5xx o cualquier otro código (AC7): el bloque sigue abierto con lo escrito y el botón dice Reintentar.
    setErrorEnvio({ texto: MSG_RED[v], reintentar: true });
  };

  const confirmarDesaplicar = async () => {
    if (enviando) return;
    const e: typeof errores = {};
    if (!destino) e.destino = MSG_DESTINO;
    if (motivo.trim().length < MOTIVO_MIN) e.motivo = MSG_MOTIVO_DESAPLICAR;
    setErrores(e); setErrorEnvio(null);
    if (e.destino) { primerDestinoRef.current?.focus(); return; }
    if (e.motivo) { motivoRef.current?.focus(); return; }
    setEnviando(true);
    try {
      const r = await desaplicarComprobante(detalle.id, { destino: destino!, motivo: motivo.trim().slice(0, MOTIVO_MAX) });
      onCorregido({
        detalle: r.comprobante, alertas: [],
        toast: destino === 'pendiente' ? `Comprobante desaplicado de ${idFlit}: volvió a la cola.` : `Comprobante desaplicado de ${idFlit} y descartado.`,
      });
    } catch (err) {
      manejarError(err, 'desaplicar');
    } finally {
      setEnviando(false);
    }
  };

  const confirmarReemplazo = async () => {
    if (enviando) return;
    const e: typeof errores = {};
    if (!elegido) e.elegido = MSG_ELEGIR;
    if (motivo.trim().length < MOTIVO_MIN) e.motivo = MSG_MOTIVO_REEMPLAZO;
    setErrores(e); setErrorEnvio(null);
    if (e.elegido) { (primerPendienteRef.current ?? motivoRef.current)?.focus(); return; }
    if (e.motivo) { motivoRef.current?.focus(); return; }
    const reemplazo = pendientes.find((p) => p.id === elegido);
    setEnviando(true);
    try {
      const r = await reemplazarComprobante(detalle.id, { reemplazoId: elegido!, motivo: motivo.trim().slice(0, MOTIVO_MAX) });
      const nombre = r.comprobante.archivo.nombre || reemplazo?.archivo.nombre || 'el comprobante elegido';
      onCorregido({
        detalle: r.original, alertas: alertasSaldo(r.comprobante),
        toast: `Comprobante reemplazado: ${nombre} quedó aplicado a ${destinoTexto}.`,
      });
    } catch (err) {
      manejarError(err, 'reemplazar');
    } finally {
      setEnviando(false);
    }
  };

  const hayPie = puedeDesaplicar || puedeReemplazar;
  const errorId = (k: string) => `${id}-err-${k}`;
  const describedMotivo = `${id}-ayuda-motivo${errores.motivo ? ` ${errorId('motivo')}` : ''}`;

  const campoMotivo = (rotulo: string) => (
    <div className="space-y-1">
      <label htmlFor={`${id}-motivo`} className="block text-xs font-semibold" style={PRIMARIO}>{rotulo} (mínimo 5 caracteres)</label>
      <textarea id={`${id}-motivo`} ref={motivoRef} className={`${flitInp} min-h-[64px]`} value={motivo} maxLength={MOTIVO_MAX}
        aria-describedby={describedMotivo} aria-invalid={errores.motivo ? true : undefined}
        onChange={(ev) => { setMotivo(ev.target.value); setErrores((x) => ({ ...x, motivo: undefined })); }} />
      <p id={`${id}-ayuda-motivo`} className="text-[11px]" style={TENUE}>{AYUDA_MOTIVO}</p>
      {errores.motivo && <p id={errorId('motivo')} role="alert" className="text-xs" style={PELIGRO}>{errores.motivo}</p>}
    </div>
  );

  const errorDeEnvio = errorEnvio && <p role="alert" className="text-xs" style={PELIGRO}>{errorEnvio.texto}</p>;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="min-h-0 flex-1 space-y-4 overflow-auto">
        {vista === 'reemplazar' ? (
          <SelectorReemplazo idBase={id} destinoTexto={destinoTexto} lista={lista} pendientes={pendientes} elegido={elegido}
            tramite={detalle.tramite} error={errores.elegido} primerRef={primerPendienteRef}
            onElegir={(v) => { setElegido(v); setErrores((x) => ({ ...x, elegido: undefined })); setErrorEnvio(null); }}
            onReintentar={() => setNonceLista((n) => n + 1)} />
        ) : children}
      </div>

      {aviso && (
        <div role="alert" className="space-y-2 rounded-lg border p-3 text-sm" style={{ borderColor: 'var(--flit-border-input)', background: 'var(--flit-bg-card)', ...PRIMARIO }}>
          <p>{aviso.texto}</p>
          {aviso.accion === 'actualizar' && <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={onActualizar}>Actualizar</button>}
          {aviso.accion === 'actualizarCola' && <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={onActualizarCola}>Actualizar la cola</button>}
          {aviso.accion === 'reporte' && hasPage(user, 'finanzas_reporte_costos') && (
            <Link to="/finanzas/reporte-costos" className="flit-focus inline-block text-sm underline" style={{ color: 'var(--flit-blue-text)' }}>Ir al reporte de costos</Link>
          )}
        </div>
      )}

      {hayPie && (
        <div className="shrink-0 border-t pt-3" style={{ borderColor: 'var(--flit-border-soft)' }}>
          {vista === 'desaplicar' ? (
            <div className="space-y-3">
              <fieldset className="space-y-1" aria-describedby={errores.destino ? errorId('destino') : undefined}>
                <legend className="text-xs font-semibold" style={PRIMARIO}>¿A dónde va este comprobante? <span aria-hidden="true">*</span></legend>
                <div className="flex flex-col gap-2">
                  {DESTINOS.map((d, i) => (
                    <label key={d.valor} className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1 text-sm transition-colors hover:bg-[var(--flit-bg-hover)]" style={PRIMARIO}>
                      <input ref={i === 0 ? primerDestinoRef : undefined} type="radio" name={`${id}-destino`} value={d.valor} checked={destino === d.valor}
                        aria-invalid={errores.destino ? true : undefined} className="flit-focus mt-1"
                        onChange={() => { setDestino(d.valor); setErrores((x) => ({ ...x, destino: undefined })); }} />
                      <span><span className="font-medium">{d.rotulo}</span><span style={SECUNDARIO}> — {d.nota}</span></span>
                    </label>
                  ))}
                </div>
                {errores.destino && <p id={errorId('destino')} role="alert" className="text-xs" style={PELIGRO}>{errores.destino}</p>}
              </fieldset>
              {campoMotivo('Motivo')}
              <p className="text-xs" style={SECUNDARIO}>Se deshace lo que este comprobante registró en {destinoTexto}.</p>
              {errorDeEnvio}
              <div className="flex flex-wrap items-center justify-end gap-3">
                <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} disabled={enviando} onClick={cerrar}>Cancelar</button>
                <button type="button" className={flitBtnSecondary} style={{ ...flitBtnSecondaryStyle, ...PELIGRO }} disabled={enviando} onClick={confirmarDesaplicar}>
                  {enviando ? 'Desaplicando…' : errorEnvio?.reintentar ? 'Reintentar' : 'Desaplicar'}
                </button>
              </div>
            </div>
          ) : vista === 'reemplazar' ? (
            <div className="space-y-3">
              {!listaVacia && campoMotivo('Motivo del reemplazo')}
              {errorDeEnvio}
              <div className="flex flex-wrap items-center justify-end gap-3">
                <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} disabled={enviando} onClick={cerrar}>Cancelar</button>
                {!listaVacia && (
                  <button type="button" className={flitBtnPrimary} style={flitBtnPrimaryStyle} disabled={enviando} onClick={confirmarReemplazo}>
                    {enviando ? 'Reemplazando…' : errorEnvio?.reintentar ? 'Reintentar' : 'Reemplazar'}
                  </button>
                )}
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center justify-end gap-3">
              {puedeDesaplicar && (
                <button ref={botonDesaplicarRef} type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={() => abrir('desaplicar')}>Desaplicar</button>
              )}
              {puedeReemplazar && (
                <button ref={botonReemplazarRef} type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={() => abrir('reemplazar')}>Reemplazar</button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** La vista Reemplazar (slim §2.2): encabezado, explicación y la lista radio con sus 4 estados. */
function SelectorReemplazo({ idBase, destinoTexto, lista, pendientes, elegido, tramite, error, primerRef, onElegir, onReintentar }: {
  idBase: string;
  destinoTexto: string;
  lista: Lista;
  pendientes: ComprobanteListaDto[];
  elegido: string | null;
  tramite: ComprobanteDetalleDto['tramite'];
  error?: string;
  primerRef: RefObject<HTMLInputElement>;
  onElegir: (id: string) => void;
  onReintentar: () => void;
}) {
  const errId = `${idBase}-err-elegido`;
  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <p className="text-sm font-semibold" style={PRIMARIO}>Reemplazar el comprobante de {destinoTexto}</p>
        <p className="text-xs" style={SECUNDARIO}>
          Elige el comprobante pendiente que va en su lugar. Este quedará descartado y el que elijas se aplicará a {destinoTexto}.
        </p>
      </div>
      <fieldset className="space-y-2" aria-busy={lista.estado === 'cargando'} aria-describedby={error ? errId : undefined}>
        <legend className="text-xs font-semibold" style={PRIMARIO}>Comprobante que va en su lugar <span aria-hidden="true">*</span></legend>
        {lista.estado === 'cargando' ? (
          <div className="animate-pulse space-y-2 motion-reduce:animate-none" aria-hidden="true">
            {[0, 1, 2].map((i) => (
              <div key={i} className="space-y-1.5 rounded-md border p-2" style={{ borderColor: 'var(--flit-border-soft)' }}>
                <div className="h-4 w-3/5 rounded" style={{ background: 'var(--flit-border-soft)' }} />
                <div className="h-3 w-4/5 rounded" style={{ background: 'var(--flit-border-soft)' }} />
              </div>
            ))}
          </div>
        ) : lista.estado === 'error' ? (
          <div role="alert" className="flex flex-wrap items-center gap-3 text-sm">
            <span style={PELIGRO}>{COPY_ERROR_LISTA}</span>
            <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={onReintentar}>Reintentar</button>
          </div>
        ) : pendientes.length === 0 ? (
          <p className="text-sm" style={SECUNDARIO}>{COPY_VACIO_LISTA}</p>
        ) : (
          <div role="radiogroup" aria-label="Comprobante que va en su lugar" className="space-y-2">
            {pendientes.map((c, i) => {
              const sel = elegido === c.id;
              return (
                <label key={c.id} className="flex cursor-pointer items-start gap-2 rounded-md border p-2 text-sm transition-colors hover:bg-[var(--flit-bg-hover)]"
                  style={{ borderColor: sel ? 'var(--flit-border-input)' : 'var(--flit-border-soft)', background: sel ? 'var(--flit-bg-app)' : undefined }}>
                  <input ref={i === 0 ? primerRef : undefined} type="radio" name={`${idBase}-reemplazo`} value={c.id} checked={sel}
                    aria-invalid={error ? true : undefined} className="flit-focus mt-1" onChange={() => onElegir(c.id)} />
                  <span className="min-w-0 flex-1 space-y-0.5">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="break-words font-medium" style={PRIMARIO}>{c.archivo.nombre}</span>
                      {coincideConTramite(c, tramite) && tramite && <StatusChip tone="neutral">Coincide con {tramite.idFlit}</StatusChip>}
                    </span>
                    <span className="block text-xs" style={SECUNDARIO}>
                      Cargado el {fechaCarga(c.createdAt)} · {c.concepto ? CONCEPTO_COSTO_LABEL[c.concepto] : 'Sin concepto leído'} · {c.valor ? pesosComprobante(c.valor) : 'Sin valor leído'}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
        )}
        {error && <p id={errId} role="alert" className="text-xs" style={PELIGRO}>{error}</p>}
      </fieldset>
      {lista.estado === 'lleno' && lista.data.total > lista.data.items.length && (
        <p className="text-xs" style={TENUE}>Se muestran los {lista.data.items.length} pendientes más recientes. Si no ves el que buscas, revisa la cola.</p>
      )}
    </div>
  );
}
