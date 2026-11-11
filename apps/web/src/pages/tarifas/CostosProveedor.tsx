// FLITO — Tarifas › Proveedores · los conceptos del proveedor elegido (Épica #13763, ADR-0041 §6).
// Diseño: `docs/ux/flito-tarifas-proveedores.md` (slim). Maqueta: `docs/ux/mockups/flito-tarifas-proveedores.html`.
//
// ≥ lg tabla del kit; < lg tarjetas por concepto (md: 2 columnas), sin scroll horizontal. Se pinta UNA
// sola de las dos (no ambas ocultas por CSS): así hay un único `<input>` en edición y un único botón por
// acción en el árbol accesible. Edición en sitio y de un concepto a la vez; «Guardar» es la única primaria.
//
// SIN ROJO (decisión del humano): ni «Dejar de cobrar», ni sus modales, ni los avisos, ni la validación
// usan `--flit-danger-*`. La gravedad la dice el copy. El modo Clientes (`MatrizTarifas`) no se toca.

import { useEffect, useId, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import type { ConceptoCostoProveedor, FilaCostoProveedor, VistaCostosProveedor } from '@operaciones/shared-types';
import {
  CODIGO_TARIFA_PROVEEDOR_CAMBIADA, MENSAJE_TARIFA_PROVEEDOR_CAMBIADA_POR_OTRO,
} from '@operaciones/shared-types';
import { fechaCorta, nombreUsuario, pesosTarifa } from '../../lib/tarifas';
import {
  MENSAJE_VALOR_INVALIDO, agruparFilas, codigoError, estadoError, etiquetaConcepto, leerValorPesos, tarifasProveedorApi,
} from '../../lib/tarifas-proveedor';
import FlitModal from '../../components/flit/FlitModal';
import { toastError, toastOk } from '../../components/flit/ToastFlito';
import {
  flitInp, FlitTable, FlitTh, FlitTr, flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle,
  flitBtnSecondarySm,
} from '../../components/flit/flitPageKit';

const NOTA_PIE = 'Un valor rige desde su fecha. Lo ya registrado no cambia.';
const SIN_CONFIGURAR = 'Sin configurar';
const MSG_FALLO = 'No se pudo guardar. El valor que escribiste sigue aquí; vuelve a intentarlo.';
const MSG_INACTIVO_CARRERA = 'Este proveedor está inactivo; no se le pueden fijar ni cambiar valores.';
const MSG_SIN_SERVICIO = 'Este proveedor ya no presta ese servicio; la vista se actualizó.';
const MSG_CONFLICTO = `${MENSAJE_TARIFA_PROVEEDOR_CAMBIADA_POR_OTRO}.`;

/** ≥ lg (1024 px): tabla. Debajo, tarjetas. */
const MQ_LG = '(min-width: 1024px)';
function suscribirLg(cb: () => void): () => void {
  const m = window.matchMedia(MQ_LG);
  m.addEventListener('change', cb);
  return () => m.removeEventListener('change', cb);
}
export function useEsEscritorio(): boolean {
  return useSyncExternalStore(suscribirLg, () => window.matchMedia(MQ_LG).matches, () => true);
}

/**
 * Aviso de página con los pares tonales de `AvisoProcesando`, sin spinner (no es «procesando»).
 * `activo` = error de carga o conflicto; `neutro` = proveedor inactivo.
 */
export function AvisoTonal({ tono, rol, icono, children, accion }: {
  tono: 'activo' | 'neutro'; rol: 'alert' | 'status'; icono: string; children: ReactNode; accion?: ReactNode;
}) {
  const t = tono === 'activo'
    ? { bg: 'var(--flit-chip-active-bg)', ink: 'var(--flit-blue-ink)' }
    : { bg: 'var(--flit-chip-draft-bg)', ink: 'var(--flit-chip-draft-ink)' };
  return (
    <div role={rol} className="flex flex-wrap items-start gap-3 rounded-2xl border px-4 py-3 text-sm"
      style={{ background: t.bg, color: t.ink, borderColor: `color-mix(in srgb, ${t.ink} 45%, transparent)` }}>
      <span aria-hidden="true" className="mt-0.5 shrink-0 font-bold">{icono}</span>
      <div className="min-w-0 flex-1 break-words">{children}</div>
      {accion && <div className="shrink-0">{accion}</div>}
    </div>
  );
}

interface Edicion {
  concepto: ConceptoCostoProveedor;
  texto: string;
  tocado: boolean;
  fallo: string | null;
  guardando: boolean;
}

interface Props {
  vista: VistaCostosProveedor;
  refrescando: boolean;
  /** Repide la vista (y el historial) tras una escritura. */
  onGuardado: () => void;
  onHistorial: (c: ConceptoCostoProveedor) => void;
  /** Para el `confirm` al cambiar de proveedor o de modo con un concepto abierto. */
  onEdicionCambia: (c: ConceptoCostoProveedor | null) => void;
}

export default function CostosProveedor({ vista, refrescando, onGuardado, onHistorial, onEdicionCambia }: Props) {
  const escritorio = useEsEscritorio();
  const nombre = vista.proveedor.nombre;
  const editar = vista.capacidades.editar && vista.proveedor.activo;
  const verHistorial = vista.capacidades.verHistorial;
  const [edicion, setEdicion] = useState<Edicion | null>(null);
  const [modalCero, setModalCero] = useState<FilaCostoProveedor | null>(null);
  const [cerrarDe, setCerrarDe] = useState<FilaCostoProveedor | null>(null);
  const [conflicto, setConflicto] = useState(false);
  const [avisoFila, setAvisoFila] = useState<{ concepto: ConceptoCostoProveedor; texto: string } | null>(null);
  const botones = useRef(new Map<ConceptoCostoProveedor, HTMLButtonElement>());
  const titulos = useRef(new Map<ConceptoCostoProveedor, HTMLElement>());
  const input = useRef<HTMLInputElement>(null);
  const [focoPendiente, setFocoPendiente] = useState<ConceptoCostoProveedor | null>(null);

  useEffect(() => { onEdicionCambia(edicion?.concepto ?? null); }, [edicion?.concepto, onEdicionCambia]);
  useEffect(() => { setEdicion(null); setConflicto(false); setAvisoFila(null); }, [vista.proveedor.id]);
  useEffect(() => {
    if (focoPendiente === null || refrescando) return;
    botones.current.get(focoPendiente)?.focus();
    setFocoPendiente(null);
  }, [focoPendiente, refrescando, vista]);

  const sujeto = (f: FilaCostoProveedor) => `${etiquetaConcepto(f.concepto)} de ${nombre}`;

  const abrir = (f: FilaCostoProveedor) => {
    setAvisoFila(null);
    setEdicion({ concepto: f.concepto, texto: f.vigencia ? String(f.vigencia.valor) : '', tocado: false, fallo: null, guardando: false });
    requestAnimationFrame(() => { input.current?.focus(); input.current?.select(); });
  };
  const cancelar = () => {
    if (!edicion) return;
    const c = edicion.concepto;
    setEdicion(null); setFocoPendiente(c);
  };

  /** Rechazos que no son del valor: conflicto (aviso de página), inactivo/servicio retirado (en la fila). */
  const rechazoDeNegocio = (f: FilaCostoProveedor, e: unknown): boolean => {
    const status = estadoError(e);
    const code = codigoError(e);
    if (code === CODIGO_TARIFA_PROVEEDOR_CAMBIADA || (status === 404 && f.vigencia)) {
      setEdicion(null); setConflicto(true); return true;
    }
    if (status === 409 || status === 422) {
      setEdicion(null);
      setAvisoFila({ concepto: f.concepto, texto: status === 409 ? MSG_INACTIVO_CARRERA : MSG_SIN_SERVICIO });
      onGuardado();
      return true;
    }
    return false;
  };

  const guardar = async (f: FilaCostoProveedor, valor: number) => {
    setEdicion((x) => (x ? { ...x, guardando: true, fallo: null } : x));
    try {
      if (f.vigencia) {
        const r = await tarifasProveedorApi.cambiar(f.vigencia.id, { valor });
        if (r.accion === 'sin_cambio') toastOk('Ese ya era el valor vigente. No hay nada que guardar.', { id: 'tarifa-proveedor' });
        else toastOk('Valor guardado.', { id: 'tarifa-proveedor' });
      } else {
        await tarifasProveedorApi.fijar(vista.proveedor.id, { concepto: f.concepto, valor });
        toastOk('Valor guardado.', { id: 'tarifa-proveedor' });
      }
      setEdicion(null); setFocoPendiente(f.concepto); onGuardado();
    } catch (e) {
      if (rechazoDeNegocio(f, e)) return;
      const invalido = estadoError(e) === 400 && codigoError(e) === 'VALOR_INVALIDO';
      setEdicion((x) => (x ? { ...x, guardando: false, tocado: true, fallo: invalido ? MENSAJE_VALOR_INVALIDO : MSG_FALLO } : x));
      requestAnimationFrame(() => input.current?.focus());
    }
  };

  const intentarGuardar = (f: FilaCostoProveedor) => {
    if (!edicion || edicion.guardando) return;
    const v = leerValorPesos(edicion.texto);
    if (!v.ok) { setEdicion({ ...edicion, tocado: true }); input.current?.focus(); return; }
    if (v.valor === 0) { setModalCero(f); return; }
    void guardar(f, v.valor);
  };

  const dejarDeCobrar = async (f: FilaCostoProveedor) => {
    if (!f.vigencia) return;
    try {
      await tarifasProveedorApi.cambiar(f.vigencia.id, { cerrar: true });
      setCerrarDe(null);
      toastOk(`Valor quitado. ${etiquetaConcepto(f.concepto)} queda sin configurar.`, { id: 'tarifa-proveedor' });
      onGuardado();
    } catch (e) {
      setCerrarDe(null);
      if (rechazoDeNegocio(f, e)) return;
      toastError('No se pudo dejar de cobrar. Vuelve a intentarlo en un momento.', undefined, { id: 'tarifa-proveedor' });
    }
  };

  const recargar = () => { setConflicto(false); onGuardado(); };

  const bloqueado = refrescando || edicion !== null;
  const grupos = agruparFilas(vista.filas);
  const propsDe = (f: FilaCostoProveedor): ConceptoProps => {
    const abierta = edicion?.concepto === f.concepto ? edicion : null;
    const leido = abierta ? leerValorPesos(abierta.texto) : null;
    return {
      fila: f, sujeto: sujeto(f), editar, verHistorial, bloqueado, inputRef: input,
      edicion: abierta,
      mensaje: abierta ? (abierta.fallo ?? (abierta.tocado && leido && !leido.ok ? leido.mensaje : null)) : null,
      guardable: !!abierta && !abierta.guardando && !!leido?.ok,
      aviso: avisoFila?.concepto === f.concepto ? avisoFila.texto : null,
      registrarBoton: (el) => { if (el) botones.current.set(f.concepto, el); else botones.current.delete(f.concepto); },
      registrarTitulo: (el) => { if (el) titulos.current.set(f.concepto, el); else titulos.current.delete(f.concepto); },
      onTexto: (texto) => setEdicion((x) => (x ? { ...x, texto, fallo: null } : x)),
      onTocado: () => setEdicion((x) => (x ? { ...x, tocado: true } : x)),
      onGuardar: () => intentarGuardar(f),
      onCancelar: cancelar,
      onAbrir: () => abrir(f),
      onHistorial: () => onHistorial(f.concepto),
      onDejarDeCobrar: () => setCerrarDe(f),
    };
  };

  return (
    <>
      {conflicto && (
        <div className="mb-4">
          <AvisoTonal tono="activo" rol="alert" icono="!"
            accion={<button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={recargar}>Recargar</button>}>
            <p className="font-semibold">{MSG_CONFLICTO}</p>
          </AvisoTonal>
        </div>
      )}

      {escritorio ? (
        <FlitTable label={`Valores de ${nombre}`}>
          <thead>
            <FlitTr>
              <FlitTh>Servicio</FlitTh>
              <FlitTh>Valor vigente</FlitTh>
              <FlitTh>Desde</FlitTh>
              <FlitTh>Quién</FlitTh>
              <FlitTh />
            </FlitTr>
          </thead>
          <tbody>
            {grupos.map((g) => g.filas.map((f, i) => (
              <FilaConcepto key={f.concepto} grupo={i === 0 ? g.titulo : null} {...propsDe(f)} />
            )))}
          </tbody>
        </FlitTable>
      ) : (
        <div role="group" aria-label={`Valores de ${nombre}`} className="space-y-5">
          {grupos.map((g) => (
            <div key={g.titulo} className="space-y-2">
              <h3 className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--flit-text-muted)' }}>{g.titulo}</h3>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                {g.filas.map((f) => <TarjetaConcepto key={f.concepto} {...propsDe(f)} />)}
              </div>
            </div>
          ))}
        </div>
      )}
      <p className="mt-3 text-xs" style={{ color: 'var(--flit-text-muted)' }}>{NOTA_PIE}</p>

      {modalCero && (
        <FlitModal title={`Cobrar $0 por ${etiquetaConcepto(modalCero.concepto)}`}
          onClose={() => { setModalCero(null); requestAnimationFrame(() => input.current?.focus()); }}>
          <div className="space-y-3 text-sm" style={{ color: 'var(--flit-text-primary)' }}>
            <p>Se cobrará $0: {nombre} no le cobrará nada a FLITO por «{etiquetaConcepto(modalCero.concepto)}» desde ahora.</p>
            <p style={{ color: 'var(--flit-text-secondary)' }}>
              Cero no es lo mismo que «Sin configurar». Si lo que quieres es quitar el valor, usa «Dejar de cobrar».
            </p>
            <div className="flex flex-wrap justify-end gap-2 pt-1">
              <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle}
                onClick={() => { setModalCero(null); requestAnimationFrame(() => input.current?.focus()); }}>
                Cancelar
              </button>
              <button type="button" className={flitBtnPrimary} style={flitBtnPrimaryStyle}
                onClick={() => { const f = modalCero; setModalCero(null); void guardar(f, 0); }}>
                Guardar $0
              </button>
            </div>
          </div>
        </FlitModal>
      )}

      {cerrarDe && (
        <ModalDejarDeCobrar
          fila={cerrarDe}
          nombre={nombre}
          restoreFocusRef={{ current: titulos.current.get(cerrarDe.concepto) ?? null }}
          onClose={() => setCerrarDe(null)}
          onConfirmar={() => void dejarDeCobrar(cerrarDe)}
        />
      )}
    </>
  );
}

interface ConceptoProps {
  fila: FilaCostoProveedor;
  sujeto: string;
  editar: boolean;
  verHistorial: boolean;
  bloqueado: boolean;
  inputRef: RefObject<HTMLInputElement>;
  edicion: Edicion | null;
  mensaje: string | null;
  guardable: boolean;
  aviso: string | null;
  registrarBoton: (el: HTMLButtonElement | null) => void;
  registrarTitulo: (el: HTMLElement | null) => void;
  onTexto: (t: string) => void;
  onTocado: () => void;
  onGuardar: () => void;
  onCancelar: () => void;
  onAbrir: () => void;
  onHistorial: () => void;
  onDejarDeCobrar: () => void;
}

/** ⚠ + texto en tinta primaria seminegrita: no depende del color (sin rojo). */
function MensajeCampo({ id, texto }: { id: string; texto: string }) {
  return (
    <p id={id} role="alert" className="flex items-start gap-1.5 text-xs font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
      <span aria-hidden="true">⚠</span><span className="min-w-0 break-words">{texto}</span>
    </p>
  );
}

function CampoValor({ p, id, visible, className }: { p: ConceptoProps; id: string; visible: boolean; className: string }) {
  const ed = p.edicion as Edicion;
  const teclas = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') { e.preventDefault(); if (p.guardable) p.onGuardar(); else p.onTocado(); }
    if (e.key === 'Escape') { e.preventDefault(); p.onCancelar(); }
  };
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={`${id}-valor`} className={visible ? 'text-xs font-semibold' : 'sr-only'} style={{ color: 'var(--flit-text-secondary)' }}>
        {visible ? 'Valor en pesos, sin IVA' : `Valor de ${p.sujeto}`}
      </label>
      <div className="flex min-w-0 items-center gap-1">
        <span aria-hidden="true" style={{ color: 'var(--flit-text-primary)' }}>$</span>
        <input
          id={`${id}-valor`} ref={p.inputRef} type="text" inputMode="numeric" autoComplete="off"
          className={`${flitInp} ${className}`}
          style={p.mensaje ? { borderWidth: 2, borderColor: 'var(--flit-text-secondary)' } : undefined}
          value={ed.texto}
          aria-invalid={p.mensaje ? true : undefined}
          aria-describedby={p.mensaje ? id : undefined}
          disabled={ed.guardando}
          onChange={(e) => p.onTexto(e.target.value)}
          onBlur={p.onTocado}
          onKeyDown={teclas}
        />
      </div>
      {p.mensaje && <MensajeCampo id={id} texto={p.mensaje} />}
      {p.fila.vigencia && (
        <span className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>Antes: {pesosTarifa(p.fila.vigencia.valor)}</span>
      )}
    </div>
  );
}

/** Botones de escritura y consulta. `grande` = tarjeta (h-10, a ancho completo); si no, el `Sm` de la tabla. */
function Acciones({ p, grande }: { p: ConceptoProps; grande: boolean }) {
  const sec = grande ? `${flitBtnSecondary} flex-1 justify-center` : flitBtnSecondarySm;
  const pri = grande ? `${flitBtnPrimary} flex-1 justify-center` : flitBtnPrimary;
  const ed = p.edicion;
  const tieneValor = p.fila.vigencia !== null;
  if (ed) {
    return (
      <>
        <button type="button" className={pri} style={flitBtnPrimaryStyle} disabled={!p.guardable}
          aria-label={`Guardar · ${p.sujeto}`} onClick={p.onGuardar}>
          {ed.guardando ? 'Guardando…' : 'Guardar'}
        </button>
        <button type="button" className={grande ? `${flitBtnSecondary} flex-1 justify-center` : flitBtnSecondary} style={flitBtnSecondaryStyle}
          disabled={ed.guardando} aria-label={`Cancelar · ${p.sujeto}`} onClick={p.onCancelar}>
          Cancelar
        </button>
      </>
    );
  }
  return (
    <>
      {p.editar && (
        <button type="button" ref={p.registrarBoton} className={sec} style={flitBtnSecondaryStyle} disabled={p.bloqueado}
          aria-label={`${tieneValor ? 'Cambiar' : 'Fijar valor'} · ${p.sujeto}`} onClick={p.onAbrir}>
          {tieneValor ? 'Cambiar' : 'Fijar valor'}
        </button>
      )}
      {p.verHistorial && (
        <button type="button" className={sec} style={flitBtnSecondaryStyle} disabled={p.bloqueado}
          aria-label={`Historial · ${p.sujeto}`} onClick={p.onHistorial}>
          Historial
        </button>
      )}
      {p.editar && tieneValor && (
        <button type="button" className={sec} style={flitBtnSecondaryStyle} disabled={p.bloqueado}
          aria-label={`Dejar de cobrar · ${p.sujeto}`} onClick={p.onDejarDeCobrar}>
          Dejar de cobrar
        </button>
      )}
    </>
  );
}

const celda = 'px-4 py-3 text-sm align-top';

function FilaConcepto(p: ConceptoProps & { grupo: string | null }) {
  const id = useId();
  const v = p.fila.vigencia;
  return (
    <>
      {p.grupo && (
        <tr className="border-t" style={{ borderColor: 'var(--flit-border-soft)' }}>
          <td colSpan={5} className="px-4 pb-1 pt-3">
            <h3 className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--flit-text-muted)' }}>{p.grupo}</h3>
          </td>
        </tr>
      )}
      <FlitTr>
        <th scope="row" tabIndex={-1} ref={p.registrarTitulo} data-vigencia={v?.id}
          className={`${celda} flit-focus text-left font-medium`} style={{ color: 'var(--flit-text-primary)' }}>
          {etiquetaConcepto(p.fila.concepto)}
        </th>
        <td className={`${celda} tabular-nums`} style={{ color: v ? 'var(--flit-text-primary)' : 'var(--flit-text-muted)' }}>
          {p.edicion ? <CampoValor p={p} id={id} visible={false} className="w-40" /> : v ? pesosTarifa(v.valor) : SIN_CONFIGURAR}
          {p.aviso && <div className="mt-1"><MensajeCampo id={`${id}-aviso`} texto={p.aviso} /></div>}
        </td>
        <td className={`${celda} whitespace-nowrap`} style={{ color: 'var(--flit-text-secondary)' }}>{v ? fechaCorta(v.vigenteDesde) : '—'}</td>
        <td className={celda} style={{ color: 'var(--flit-text-secondary)' }}>{v ? nombreUsuario(v.fijadoPor) : '—'}</td>
        <td className={celda}>
          <div className="flex flex-wrap justify-end gap-2"><Acciones p={p} grande={false} /></div>
        </td>
      </FlitTr>
    </>
  );
}

function TarjetaConcepto(p: ConceptoProps) {
  const id = useId();
  const v = p.fila.vigencia;
  return (
    <article aria-labelledby={`${id}-titulo`} className="min-w-0 rounded-xl border p-4"
      style={{ borderColor: 'var(--flit-border-soft)', background: 'var(--flit-bg-card)' }} data-vigencia={v?.id}>
      <h4 id={`${id}-titulo`} ref={p.registrarTitulo} tabIndex={-1} className="flit-focus break-words text-sm font-semibold"
        style={{ color: 'var(--flit-text-primary)' }}>
        {etiquetaConcepto(p.fila.concepto)}
      </h4>
      {p.edicion ? (
        <div className="mt-2"><CampoValor p={p} id={id} visible className="w-full min-w-0" /></div>
      ) : v ? (
        <>
          <p className="mt-1 text-2xl font-bold tabular-nums" style={{ color: 'var(--flit-text-primary)' }}>{pesosTarifa(v.valor)}</p>
          <p className="mt-0.5 break-words text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
            Desde {fechaCorta(v.vigenteDesde)} · {nombreUsuario(v.fijadoPor)}
          </p>
        </>
      ) : (
        <>
          <p className="mt-1 text-2xl font-bold" style={{ color: 'var(--flit-text-muted)' }}>{SIN_CONFIGURAR}</p>
          <p className="mt-0.5 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>Todavía no tiene valor.</p>
        </>
      )}
      {p.aviso && <div className="mt-2"><MensajeCampo id={`${id}-aviso`} texto={p.aviso} /></div>}
      <div className="mt-3 flex flex-wrap gap-2"><Acciones p={p} grande /></div>
    </article>
  );
}

function ModalDejarDeCobrar({ fila, nombre, restoreFocusRef, onClose, onConfirmar }: {
  fila: FilaCostoProveedor; nombre: string; restoreFocusRef: RefObject<HTMLElement | null>;
  onClose: () => void; onConfirmar: () => void;
}) {
  const [enviando, setEnviando] = useState(false);
  const etiqueta = etiquetaConcepto(fila.concepto);
  return (
    <FlitModal title={`Dejar de cobrar ${etiqueta}`} onClose={onClose} restoreFocusRef={restoreFocusRef}>
      <div className="space-y-3 text-sm" style={{ color: 'var(--flit-text-primary)' }}>
        <p>
          {etiqueta} de {nombre} <strong>queda sin valor desde ahora</strong> y la fila vuelve a «{SIN_CONFIGURAR}».
        </p>
        <p style={{ color: 'var(--flit-text-secondary)' }}>
          La vigencia de {pesosTarifa(fila.vigencia?.valor ?? 0)} queda cerrada en el historial, con tu nombre y la hora. No se
          puede deshacer: para volver a cobrar, tendrás que fijar un valor nuevo.
        </p>
        <div className="flex flex-wrap justify-end gap-2 pt-1">
          <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={onClose} disabled={enviando}>Cancelar</button>
          {/* Primaria del kit (degradado + texto blanco), sin rojo: decisión del humano. */}
          <button type="button" className={flitBtnPrimary} style={flitBtnPrimaryStyle} disabled={enviando}
            onClick={() => { setEnviando(true); onConfirmar(); }}>
            Dejar de cobrar
          </button>
        </div>
      </div>
    </FlitModal>
  );
}
