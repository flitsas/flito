// Pestaña «Viajes adicionales» de la consola de Logística (HU #14128, Feature #14095, Épica 13758).
// Diseño aprobado: `docs/ux/viajes-adicionales-masivo-14128-slim.md`.
//
// Las placas se pegan o se escriben (no hay listado de LT). Cada fila lleva su valor; un valor común se
// aplica a las seleccionadas y cada fila sigue editable. El envío es UNA solicitud con `Idempotency-Key`:
// «Reintentar» tras un fallo de red reutiliza la llave (no duplica); cualquier edición la renueva.
// La placa vive solo en el estado y en el body: nunca en URL, localStorage ni consola.

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { MotivoViajeLogistica } from '@operaciones/shared-types';
import { api, ApiError } from '../../../lib/api';
import {
  MAX_DETALLE, OPCIONES_MOTIVO,
} from '../../../lib/viajesLogistica';
import {
  MAX_PLACAS_MASIVO, RUTA_VIAJES_MASIVO, errorDeValor, falloDeSolicitud, limpiarValor, parsearPlacas, plural,
  repartirPegado, textoDeRechazo, textoDeSobrantes, CODIGOS_CORREGIBLES,
  type FalloSolicitud, type RespuestaMasivo,
} from '../../../lib/viajesMasivo';
import { toastOk } from '../../flit/ToastFlito';
import {
  FlitCard, FlitEmpty, FlitField, flitBtnIconoSm, flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary,
  flitBtnSecondaryStyle, flitInp,
} from '../../flit/flitPageKit';
import ResumenViajesMasivo from './ResumenViajesMasivo';

const MUTED = { color: 'var(--flit-text-muted)' } as const;
const PELIGRO = { color: 'var(--flit-danger-ink)' } as const;
const CHECK = { accentColor: 'var(--flit-blue-text)' } as const;

interface Fila { id: number; placa: string; valor: string; sel: boolean; aviso?: string }
type Foco = 'lista' | 'primaria' | 'texto' | 'titulo';

export default function ViajesMasivo() {
  const idTexto = useId();
  const idComun = useId();
  const idMotivo = useId();
  const [texto, setTexto] = useState('');
  const [filas, setFilas] = useState<Fila[]>([]);
  const [comun, setComun] = useState('');
  const [motivo, setMotivo] = useState<MotivoViajeLogistica | ''>('');
  const [detalle, setDetalle] = useState('');
  const [aviso, setAviso] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [fallo, setFallo] = useState<FalloSolicitud | null>(null);
  const [resultado, setResultado] = useState<RespuestaMasivo | null>(null);

  const sigId = useRef(1);
  const llave = useRef<string | null>(null);
  const nuevoId = useRef(0);
  const foco = useRef<Foco | null>(null);
  const enviadas = useRef<Map<string, string>>(new Map());
  const textoRef = useRef<HTMLTextAreaElement>(null);
  const primariaRef = useRef<HTMLButtonElement>(null);
  const tituloRef = useRef<HTMLHeadingElement>(null);
  const listaRef = useRef<HTMLUListElement>(null);
  const todasRef = useRef<HTMLInputElement>(null);

  const seleccionadas = filas.filter((f) => f.sel);
  const listas = seleccionadas.filter((f) => errorDeValor(f.valor) === null);
  const sinValor = seleccionadas.length - listas.length;
  const detalleFalta = motivo === 'otro' && detalle.trim() === '';
  const puedeEnviar = !enviando && listas.length > 0 && sinValor === 0 && motivo !== '' && !detalleFalta;
  const llena = filas.length >= MAX_PLACAS_MASIVO;

  // Cualquier cambio de la lista o del motivo es otra operación: llave nueva.
  const editar = () => { llave.current = null; setFallo(null); };
  const cambiarFilas = (fn: (f: Fila[]) => Fila[]) => { editar(); setFilas(fn); };

  useEffect(() => {
    if (todasRef.current) todasRef.current.indeterminate = seleccionadas.length > 0 && seleccionadas.length < filas.length;
  }, [seleccionadas.length, filas.length]);

  useEffect(() => {
    const destino = foco.current;
    if (!destino) return;
    foco.current = null;
    if (destino === 'texto') textoRef.current?.focus();
    else if (destino === 'titulo') tituloRef.current?.focus();
    else if (destino === 'primaria') primariaRef.current?.focus();
    else listaRef.current?.querySelector<HTMLInputElement>('input[data-nueva="1"]')?.focus();
  });

  const agregar = () => {
    const r = repartirPegado(parsearPlacas(texto), filas.map((f) => f.placa));
    if (r.nuevas.length === 0 && r.repetidas === 0 && r.sobrantes.length === 0) return;
    editar();
    nuevoId.current = sigId.current;
    setFilas((prev) => [
      ...prev,
      ...r.nuevas.map((p) => ({ id: sigId.current++, placa: p.placa, valor: p.valor, sel: true })),
    ]);
    setTexto(textoDeSobrantes(r.sobrantes));
    const partes: string[] = [];
    if (r.repetidas > 0) partes.push(`${r.repetidas === 1 ? 'Se omitió' : 'Se omitieron'} ${plural(r.repetidas, 'placa repetida', 'placas repetidas')}.`);
    if (r.sobrantes.length > 0) {
      partes.push(`Se agregaron ${plural(r.nuevas.length, 'placa', 'placas')}. Quedan ${r.sobrantes.length} por fuera: regístralas en otra tanda cuando termines esta.`);
    }
    setAviso(partes.length ? partes.join(' ') : null);
    if (r.nuevas.length > 0) foco.current = 'lista';
  };

  const aplicarComun = () => {
    const v = limpiarValor(comun);
    cambiarFilas((fs) => fs.map((f) => (f.sel ? { ...f, valor: v, aviso: undefined } : f)));
    toastOk(`Valor aplicado a ${plural(seleccionadas.length, 'placa', 'placas')}.`, { id: 'viajes-masivo-valor' });
  };

  const quitar = (ids: Set<number>) => {
    const quedan = filas.length - ids.size;
    cambiarFilas((fs) => fs.filter((f) => !ids.has(f.id)));
    foco.current = quedan === 0 ? 'texto' : 'primaria';
  };

  const siguienteValor = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const inputs = Array.from(listaRef.current?.querySelectorAll<HTMLInputElement>('input[data-valor="1"]') ?? []);
    inputs[inputs.indexOf(e.currentTarget) + 1]?.focus();
  };

  const enviar = async () => {
    if (!puedeEnviar) return;
    llave.current ??= crypto.randomUUID();
    const items = listas.map((f) => ({ placa: f.placa, valor: Number(f.valor) }));
    enviadas.current = new Map(listas.map((f) => [f.placa, f.valor]));
    setEnviando(true);
    setFallo(null);
    setAviso(null);
    try {
      const r = await api.post<RespuestaMasivo>(
        RUTA_VIAJES_MASIVO,
        { items, motivo, ...(motivo === 'otro' ? { motivoDetalle: detalle.trim() } : {}) },
        { 'Idempotency-Key': llave.current },
      );
      // Lo enviado sale de la lista de trabajo: lo registrado ya está hecho y lo rechazado queda en el resumen
      // (las corregibles vuelven con «Corregir y reintentar»). Lo no seleccionado se queda.
      const enviadasAhora = new Set(items.map((i) => i.placa));
      setFilas((fs) => fs.filter((f) => !enviadasAhora.has(f.placa)));
      setResultado(r);
      llave.current = null;
      foco.current = 'titulo';
    } catch (e) {
      setFallo(falloDeSolicitud(e instanceof ApiError ? e.status : 0));
    } finally {
      setEnviando(false);
    }
  };

  const corregir = () => {
    if (!resultado) return;
    const previas = new Set(filas.map((f) => f.placa));
    const volver = resultado.rechazados.filter((r) => CODIGOS_CORREGIBLES.includes(r.codigo) && r.placa && !previas.has(r.placa));
    llave.current = null;
    nuevoId.current = sigId.current;
    setFilas((fs) => [
      ...fs,
      ...volver.map((r) => ({
        id: sigId.current++, placa: r.placa, valor: enviadas.current.get(r.placa) ?? '', sel: true, aviso: textoDeRechazo(r),
      })),
    ]);
    setResultado(null);
    foco.current = volver.length ? 'lista' : 'texto';
  };

  const nueva = () => {
    llave.current = null;
    setFilas([]); setTexto(''); setComun(''); setMotivo(''); setDetalle('');
    setAviso(null); setFallo(null); setResultado(null);
    foco.current = 'texto';
  };

  const motivoFalta = useMemo(() => {
    if (sinValor > 0) return `Falta el valor en ${plural(sinValor, 'placa seleccionada', 'placas seleccionadas')}.`;
    if (seleccionadas.length === 0) return 'Selecciona al menos una placa.';
    if (motivo === '') return 'Elige el motivo del viaje.';
    if (detalleFalta) return 'Escribe el detalle del motivo.';
    return null;
  }, [sinValor, seleccionadas.length, motivo, detalleFalta]);

  if (resultado) {
    return <ResumenViajesMasivo ref={tituloRef} resultado={resultado} onCorregir={corregir} onNueva={nueva} />;
  }

  return (
    <div className="space-y-4">
      <FlitCard>
        <p className="mb-3 text-sm" style={MUTED}>Registra el mismo viaje adicional a varias LT, con el valor de cada una.</p>
        <div className="mb-1 flex items-baseline justify-between gap-3">
          <label htmlFor={idTexto} className="text-[11px] font-semibold" style={{ color: 'var(--flit-text-primary)' }}>Placas</label>
          <span className="text-xs tabular-nums" style={llena ? PELIGRO : MUTED} aria-live="polite">{filas.length} / {MAX_PLACAS_MASIVO}</span>
        </div>
        <textarea id={idTexto} ref={textoRef} className={flitInp} rows={filas.length ? 2 : 5} value={texto} disabled={enviando}
          placeholder="Pega una placa por línea. Si copias desde Excel, puedes incluir el valor en la segunda columna."
          onChange={(e) => setTexto(e.target.value)} />
        <div className="mt-3">
          <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle}
            disabled={enviando || texto.trim() === '' || llena} onClick={agregar}>
            Agregar a la lista
          </button>
        </div>
      </FlitCard>

      {aviso && (
        <FlitCard><p role="status" className="text-sm">{aviso}</p></FlitCard>
      )}

      {filas.length === 0 ? (
        <FlitEmpty>Aún no hay placas en la lista. Pega o escribe las placas arriba y pulsa «Agregar a la lista».</FlitEmpty>
      ) : (
        <FlitCard>
          <div aria-busy={enviando} className="space-y-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <FlitField label="Motivo del viaje (obligatorio)">
                <select id={idMotivo} className={flitInp} value={motivo} disabled={enviando}
                  onChange={(e) => { editar(); setMotivo(e.target.value as MotivoViajeLogistica | ''); }}>
                  <option value="">Selecciona…</option>
                  {OPCIONES_MOTIVO.map((o) => <option key={o.valor} value={o.valor}>{o.etiqueta}</option>)}
                </select>
              </FlitField>
              {motivo === 'otro' && (
                <FlitField label={`Detalle (obligatorio, máx. ${MAX_DETALLE})`}>
                  <input className={flitInp} value={detalle} maxLength={MAX_DETALLE} disabled={enviando}
                    onChange={(e) => { editar(); setDetalle(e.target.value); }} />
                </FlitField>
              )}
            </div>

            <div className="flex flex-wrap items-end gap-3">
              <div className="w-full sm:w-56">
                <label htmlFor={idComun} className="mb-1 block text-[11px] font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
                  Valor para todas (COP)
                </label>
                <input id={idComun} className={flitInp} inputMode="numeric" value={comun} disabled={enviando}
                  onChange={(e) => setComun(e.target.value)} placeholder="Ej.: 350000" />
              </div>
              <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle}
                disabled={enviando || errorDeValor(limpiarValor(comun)) !== null || seleccionadas.length === 0} onClick={aplicarComun}>
                Aplicar a las seleccionadas
              </button>
              <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle}
                disabled={enviando || seleccionadas.length === 0} onClick={() => quitar(new Set(seleccionadas.map((f) => f.id)))}>
                Quitar seleccionadas
              </button>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 border-b pb-2 text-xs font-semibold" style={{ borderColor: 'var(--flit-border-soft)' }}>
              <label className="inline-flex items-center gap-2">
                <input ref={todasRef} type="checkbox" className="flit-focus size-4" style={CHECK} disabled={enviando}
                  checked={filas.length > 0 && seleccionadas.length === filas.length}
                  onChange={(e) => cambiarFilas((fs) => fs.map((f) => ({ ...f, sel: e.target.checked })))} />
                Seleccionar todas
              </label>
              <span className="hidden sm:inline" aria-hidden="true">Valor (COP)</span>
              <span className="tabular-nums font-normal" style={MUTED}>{seleccionadas.length} de {filas.length} seleccionadas</span>
            </div>

            <ul ref={listaRef} className="space-y-2 sm:space-y-0">
              {filas.map((f) => {
                const err = f.sel ? errorDeValor(f.valor) : null;
                const idErr = `mx-err-${f.id}`;
                const msg = f.aviso ?? err;
                return (
                  <li key={f.id}
                    className="flex flex-wrap items-start gap-x-3 gap-y-1 rounded-lg border p-3 transition-colors hover:bg-[var(--flit-bg-hover)] sm:border-0 sm:px-2 sm:py-1.5"
                    style={{ borderColor: 'var(--flit-border-soft)' }}>
                    <label className="flex min-w-0 flex-1 items-center gap-2 text-sm font-medium tabular-nums sm:h-10 sm:w-40 sm:flex-none">
                      <input type="checkbox" className="flit-focus size-4" style={CHECK} checked={f.sel} disabled={enviando}
                        data-nueva={f.id === nuevoId.current || undefined}
                        onChange={(e) => cambiarFilas((fs) => fs.map((x) => (x.id === f.id ? { ...x, sel: e.target.checked } : x)))} />
                      <span className="sr-only">Seleccionar </span>{f.placa}
                    </label>
                    <div className="order-last w-full min-w-0 sm:order-none sm:w-auto sm:flex-1 sm:max-w-xs">
                      <label htmlFor={`mx-v-${f.id}`} className="mb-1 block text-xs sm:sr-only" style={MUTED}>Valor (COP) de {f.placa}</label>
                      <input id={`mx-v-${f.id}`} data-valor="1" className={flitInp} inputMode="numeric" value={f.valor} disabled={enviando}
                        aria-invalid={msg ? true : undefined} aria-describedby={msg ? idErr : undefined}
                        onKeyDown={siguienteValor}
                        onChange={(e) => cambiarFilas((fs) => fs.map((x) => (x.id === f.id ? { ...x, valor: e.target.value, aviso: undefined } : x)))}
                        onBlur={(e) => { const v = limpiarValor(e.target.value); if (v !== f.valor) setFilas((fs) => fs.map((x) => (x.id === f.id ? { ...x, valor: v } : x))); }} />
                      {msg && <p id={idErr} className="mt-1 text-xs" style={PELIGRO}>{msg}</p>}
                    </div>
                    <button type="button" className={`${flitBtnIconoSm} ml-auto sm:mt-1.5`} aria-label={`Quitar ${f.placa}`}
                      disabled={enviando} onClick={() => quitar(new Set([f.id]))}>
                      <X size={14} aria-hidden="true" />
                    </button>
                  </li>
                );
              })}
            </ul>

            {fallo && (
              <div role="alert" className="rounded-lg border p-3 text-sm" style={{ borderColor: 'var(--flit-danger-ink)', ...PELIGRO }}>
                <p>{fallo.mensaje}</p>
                {fallo.reintentable && (
                  <button type="button" className={`${flitBtnSecondary} mt-2`} style={flitBtnSecondaryStyle} onClick={() => void enviar()}>
                    Reintentar
                  </button>
                )}
              </div>
            )}
            {enviando && (
              <p role="status" className="text-sm" style={MUTED}>
                Registrando {plural(listas.length, 'viaje', 'viajes')}. No cierres ni recargues esta página.
              </p>
            )}

            <div className="flex flex-col items-stretch gap-2 sm:items-end">
              <button ref={primariaRef} type="button" className={`${flitBtnPrimary} justify-center`} style={flitBtnPrimaryStyle}
                disabled={!puedeEnviar} onClick={() => void enviar()}>
                {enviando ? `Registrando ${plural(listas.length, 'viaje', 'viajes')}…` : `Registrar ${plural(listas.length, 'viaje', 'viajes')}`}
              </button>
              {!puedeEnviar && !enviando && motivoFalta && <p className="text-xs" style={MUTED}>{motivoFalta}</p>}
            </div>
          </div>
        </FlitCard>
      )}
    </div>
  );
}
