// EPIC TRAM-INNOV · B4 — carga masiva de trámites (CSV de flota).
//
// Sube CSV → preview con semáforo de pre-vuelo (A1) + LAFT por fila → confirma.
// LOTE-PLUS-04:
//  · Tabs «Nuevo lote» | «Historial» (G5): historial paginado + detalle por lote.
//  · El confirm sube el ARCHIVO (POST /lote/confirm) y el servidor re-parsea el
//    CSV (G4): el cliente ya no envía filas[] manipulables.
// Estilos: solo tokens/clases FLIT.

import { useState, useEffect, useRef, useCallback } from 'react';
import { api, errorMessage } from '../../lib/api';
import toast from 'react-hot-toast';

interface LaftFila { status: string; matches: number }
interface FilaPreview {
  fila: number; vin: string; placa: string | null; tipologiaCodigo: string;
  valido: boolean; error?: string;
  compradorDoc?: string; compradorNombre?: string;
  preflight: { overall: string; checks: unknown[]; laftComprador?: LaftFila | null } | null;
}
interface Preview { resumen: { total: number; validas: number; errores: number }; filas: FilaPreview[] }

interface LoteResumen { id: number; nombre: string | null; totalFilas: number; ok: number; errores: number; estado?: string; createdAt: string }
interface LoteEstado { loteId: number; estado: string; totalFilas: number; ok: number; errores: number; procesadas: number; pct: number }
interface ListaLotes { items: LoteResumen[]; total: number; page: number; limit: number }
interface FilaDetalle { fila: number; vin: string; placa: string | null; tipologiaCodigo: string; estado: string; tramiteId: number | null; errorMsg: string | null }
interface LoteDetalle { lote: LoteResumen; filas: FilaDetalle[] }

const SEMAFORO: Record<string, { label: string; color: string; bg: string }> = {
  green: { label: 'Verde', color: 'var(--flit-success)', bg: 'rgba(112,207,58,0.15)' },
  yellow: { label: 'Amarillo', color: 'var(--flit-warning)', bg: 'rgba(240,90,53,0.15)' },
  red: { label: 'Rojo', color: 'var(--flit-danger)', bg: 'rgba(228,61,48,0.15)' },
};

// LOTE-PLUS-02: semáforo LAFT por fila (mismo lenguaje visual que PreflightPanel).
const LAFT_FILA: Record<string, { label: string; color: string; bg: string }> = {
  green: { label: 'Sin coincidencias', color: 'var(--flit-success)', bg: 'rgba(112,207,58,0.15)' },
  yellow: { label: 'A revisar', color: 'var(--flit-warning)', bg: 'rgba(240,90,53,0.15)' },
  red: { label: 'Coincidencia', color: 'var(--flit-danger)', bg: 'rgba(228,61,48,0.15)' },
  unknown: { label: 'No verificado', color: 'var(--flit-text-muted)', bg: 'rgba(125,135,152,0.12)' },
};

interface LoteResultado { loteId: number; ok: number; errores: number }

const fmtFecha = (iso: string) => { try { return new Date(iso).toLocaleString('es-CO', { dateStyle: 'medium', timeStyle: 'short' }); } catch { return iso; } };

type Tab = 'nuevo' | 'historial';

export default function LoteFlota({ onCreado }: { onCreado?: () => void }) {
  const [tab, setTab] = useState<Tab>('nuevo');

  // --- Nuevo lote ---
  const [preview, setPreview] = useState<Preview | null>(null);
  const [csvFile, setCsvFile] = useState<File | null>(null); // G4: fuente confiable que se reenvía al confirmar.
  const [loading, setLoading] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [progreso, setProgreso] = useState<LoteEstado | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [nombre, setNombre] = useState('');
  // LOTE-PLUS-03: resultado del lote creado → reproceso + export.
  const [resultado, setResultado] = useState<LoteResultado | null>(null);
  const [reprocesando, setReprocesando] = useState(false);

  // --- Historial / detalle ---
  const [lista, setLista] = useState<ListaLotes | null>(null);
  const [listaLoading, setListaLoading] = useState(false);
  const [detalle, setDetalle] = useState<LoteDetalle | null>(null);
  const [detalleLoading, setDetalleLoading] = useState(false);

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  const detenerPolling = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }, []);

  const descargarPlantilla = async () => {
    try { await api.download('/tramites/lote/plantilla.csv', 'plantilla_lote_flota.csv'); }
    catch (err) { toast.error(errorMessage(err)); }
  };

  const subirCsv = async (file: File) => {
    setLoading(true); setPreview(null); setResultado(null); setCsvFile(null);
    try {
      const r = await api.upload<Preview>('/tramites/lote/preview', file);
      setPreview(r); setCsvFile(file);
      if (r.resumen.validas === 0) toast.error('Ninguna fila válida en el CSV');
    } catch (err) { toast.error(errorMessage(err)); }
    finally { setLoading(false); }
  };

  // LOTE-PLUS-01: async 202 + polling. G4: servidor re-parsea el CSV.
  const confirmar = async () => {
    if (!csvFile) { toast.error('Vuelve a subir el CSV'); return; }
    setConfirming(true);
    setProgreso(null);
    detenerPolling();
    try {
      const fields = nombre ? { nombre } : undefined;
      const r = await api.upload<{ loteId: number; estado: string; totalFilas: number; idempotente?: boolean }>('/tramites/lote/async', csvFile, 'file', fields);
      if (r.idempotente) toast('Este CSV ya fue procesado — mostrando el lote existente', { icon: 'ℹ️' });
      setProgreso({ loteId: r.loteId, estado: r.estado, totalFilas: r.totalFilas, ok: 0, errores: 0, procesadas: 0, pct: 0 });
      pollRef.current = setInterval(async () => {
        try {
          const st = await api.get<LoteEstado>(`/tramites/lote/${r.loteId}/estado`);
          setProgreso(st);
          if (st.estado === 'listo' || st.estado === 'error') {
            detenerPolling();
            setConfirming(false);
            setProgreso(null);
            setResultado({ loteId: st.loteId, ok: st.ok, errores: st.errores });
            setPreview(null); setCsvFile(null); setNombre('');
            if (st.estado === 'listo') {
              toast.success(`Lote creado: ${st.ok} borrador(es)${st.errores ? `, ${st.errores} error(es)` : ''}`);
            } else {
              toast.error(`Lote #${st.loteId} terminó con error del sistema (${st.ok} ok, ${st.errores} errores)`);
            }
          }
        } catch (err) { detenerPolling(); setConfirming(false); setProgreso(null); toast.error(errorMessage(err)); }
      }, 2000);
      // Primera lectura inmediata (no esperar 2s).
      const st0 = await api.get<LoteEstado>(`/tramites/lote/${r.loteId}/estado`);
      setProgreso(st0);
      if (r.idempotente && (st0.estado === 'listo' || st0.estado === 'error')) {
        setConfirming(false);
        setProgreso(null);
        setResultado({ loteId: st0.loteId, ok: st0.ok, errores: st0.errores });
        setPreview(null); setCsvFile(null); setNombre('');
      }
    } catch (err) { toast.error(errorMessage(err)); setConfirming(false); }
  };

  const reintentarErrores = async (loteId: number, onDone?: () => void) => {
    setReprocesando(true);
    try {
      const r = await api.post<{ recuperadas: number; ok: number; errores: number }>(`/tramites/lote/${loteId}/reprocesar-errores`, {});
      toast.success(`Reproceso: ${r.recuperadas} recuperada(s), ${r.errores} error(es) restante(s)`);
      onDone?.();
    } catch (err) { toast.error(errorMessage(err)); }
    finally { setReprocesando(false); }
  };

  const descargarResultados = async (loteId: number) => {
    try { await api.download(`/tramites/lote/${loteId}/resultados.csv`, `lote_${loteId}_resultados.csv`); }
    catch (err) { toast.error(errorMessage(err)); }
  };

  const cerrar = () => { setResultado(null); onCreado?.(); };

  // --- Historial ---
  const cargarHistorial = async (page = 1) => {
    setListaLoading(true);
    try { setLista(await api.get<ListaLotes>(`/tramites/lote?page=${page}&limit=20`)); }
    catch (err) { toast.error(errorMessage(err)); }
    finally { setListaLoading(false); }
  };

  const irAHistorial = () => { setTab('historial'); setDetalle(null); cargarHistorial(1); };

  const verDetalle = async (id: number) => {
    setDetalleLoading(true);
    try { setDetalle(await api.get<LoteDetalle>(`/tramites/lote/${id}`)); }
    catch (err) { toast.error(errorMessage(err)); }
    finally { setDetalleLoading(false); }
  };

  const inp = 'flit-focus w-full rounded-[10px] border bg-white px-3 py-2 text-sm outline-none';
  const tabBtn = (active: boolean) =>
    `flit-focus inline-flex h-9 items-center rounded-[999px] px-4 text-sm font-semibold ${active ? 'text-white' : ''}`;

  return (
    <div>
      {/* Tabs */}
      <div className="mb-4 flex gap-2">
        <button type="button" onClick={() => setTab('nuevo')} className={tabBtn(tab === 'nuevo')}
          style={tab === 'nuevo'
            ? { background: 'var(--flit-gradient-primary)' }
            : { border: '1px solid var(--flit-border-input)', color: 'var(--flit-text-secondary)', background: 'white' }}>
          Nuevo lote
        </button>
        <button type="button" onClick={irAHistorial} className={tabBtn(tab === 'historial')}
          style={tab === 'historial'
            ? { background: 'var(--flit-gradient-primary)' }
            : { border: '1px solid var(--flit-border-input)', color: 'var(--flit-text-secondary)', background: 'white' }}>
          Historial
        </button>
      </div>

      {tab === 'nuevo' && (
        <div>
          <p className="mb-3 text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
            Sube un CSV con <code>vin</code> (obligatorio) y, opcionales, <code>placa</code>, <code>tipologia_codigo</code>, <code>comprador_doc</code>, <code>comprador_nombre</code>, <code>vendedor_doc</code> y <code>vendedor_nombre</code>. Verás el pre-vuelo y el screening LAFT por fila antes de crear los borradores. Re-subir el mismo archivo reutiliza el lote (idempotencia).
          </p>

          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={descargarPlantilla}
              className="flit-focus inline-flex h-10 items-center rounded-[999px] border bg-white px-4 text-sm font-medium" style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-secondary)' }}>
              Descargar plantilla CSV
            </button>
            <label className="flit-focus inline-flex h-10 cursor-pointer items-center rounded-[999px] px-5 text-sm font-semibold text-white" style={{ background: 'var(--flit-gradient-primary)' }}>
              {loading ? 'Procesando…' : 'Subir CSV'}
              <input type="file" accept=".csv,text/csv" hidden disabled={loading}
                onChange={(e) => { const f = e.target.files?.[0]; if (f) subirCsv(f); e.target.value = ''; }} />
            </label>
          </div>

          {/* LOTE-PLUS-03: resultado del lote con reproceso + export */}
          {resultado && !preview && (
            <div className="mt-4 rounded-[12px] border p-4" style={{ borderColor: 'var(--flit-border-soft)', background: 'var(--flit-bg-app)' }}>
              <div className="mb-2 flex flex-wrap items-center gap-3">
                <span className="text-sm font-bold" style={{ color: 'var(--flit-blue-text)' }}>Lote #{resultado.loteId}</span>
                <span className="text-xs" style={{ color: 'var(--flit-success)' }}>{resultado.ok} creado(s)</span>
                <span className="text-xs" style={{ color: resultado.errores > 0 ? 'var(--flit-danger)' : 'var(--flit-text-muted)' }}>{resultado.errores} error(es)</span>
              </div>
              <div className="flex flex-wrap gap-2">
                {resultado.errores > 0 && (
                  <button type="button" onClick={() => reintentarErrores(resultado.loteId, () => setResultado({ ...resultado, errores: 0 }))} disabled={reprocesando}
                    className="flit-focus inline-flex h-9 items-center rounded-[999px] px-4 text-sm font-semibold text-white disabled:opacity-50" style={{ background: 'var(--flit-gradient-primary)' }}>
                    {reprocesando ? 'Reintentando…' : 'Reintentar errores'}
                  </button>
                )}
                <button type="button" onClick={() => descargarResultados(resultado.loteId)}
                  className="flit-focus inline-flex h-9 items-center rounded-[999px] border bg-white px-4 text-sm font-medium" style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-secondary)' }}>
                  Descargar CSV
                </button>
                <button type="button" onClick={cerrar}
                  className="flit-focus inline-flex h-9 items-center rounded-[999px] border bg-white px-4 text-sm font-medium" style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-secondary)' }}>
                  Listo
                </button>
              </div>
              {resultado.errores > 0 && (
                <p className="mt-2 text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>
                  «Reintentar errores» reprocesa solo las filas que fallaron (con VIN). Las filas sin VIN no son reintentables.
                </p>
              )}
            </div>
          )}

          {preview && (
            <div className="mt-4">
              <div className="mb-2 flex flex-wrap items-center gap-3 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
                <span className="font-semibold">Total: {preview.resumen.total}</span>
                <span style={{ color: 'var(--flit-success)' }}>Válidas: {preview.resumen.validas}</span>
                <span style={{ color: 'var(--flit-danger)' }}>Errores: {preview.resumen.errores}</span>
              </div>

              <div className="max-h-72 overflow-auto rounded-[12px] border" style={{ borderColor: 'var(--flit-border-soft)' }}>
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr style={{ background: 'var(--flit-bg-app)', color: 'var(--flit-text-muted)' }}>
                      <th className="px-3 py-2 font-semibold">#</th>
                      <th className="px-3 py-2 font-semibold">VIN</th>
                      <th className="px-3 py-2 font-semibold">Placa</th>
                      <th className="px-3 py-2 font-semibold">Tipología</th>
                      <th className="px-3 py-2 font-semibold">Pre-vuelo</th>
                      <th className="px-3 py-2 font-semibold">LAFT</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.filas.map((f) => {
                      const sem = f.preflight ? SEMAFORO[f.preflight.overall] : null;
                      return (
                        <tr key={f.fila} className="border-t" style={{ borderColor: 'var(--flit-border-soft)' }}>
                          <td className="px-3 py-2" style={{ color: 'var(--flit-text-muted)' }}>{f.fila}</td>
                          <td className="px-3 py-2 font-mono" style={{ color: 'var(--flit-text-primary)' }}>{f.vin || '—'}</td>
                          <td className="px-3 py-2" style={{ color: 'var(--flit-text-secondary)' }}>{f.placa || '—'}</td>
                          <td className="px-3 py-2" style={{ color: 'var(--flit-text-secondary)' }}>{f.tipologiaCodigo}</td>
                          <td className="px-3 py-2">
                            {!f.valido ? (
                              <span className="rounded-full px-2 py-0.5 text-[10px] font-bold" style={{ background: 'rgba(228,61,48,0.15)', color: 'var(--flit-danger)' }}>{f.error || 'Inválida'}</span>
                            ) : sem ? (
                              <span className="rounded-full px-2 py-0.5 text-[10px] font-bold" style={{ background: sem.bg, color: sem.color }}>{sem.label}</span>
                            ) : (
                              <span className="text-[10px]" style={{ color: 'var(--flit-text-muted)' }}>—</span>
                            )}
                          </td>
                          <td className="px-3 py-2">
                            {(() => {
                              const laft = f.preflight?.laftComprador;
                              if (!laft) return <span className="text-[10px]" style={{ color: 'var(--flit-text-muted)' }}>—</span>;
                              const t = LAFT_FILA[laft.status] ?? LAFT_FILA.unknown;
                              return <span className="rounded-full px-2 py-0.5 text-[10px] font-bold" style={{ background: t.bg, color: t.color }}>{t.label}{laft.matches > 0 ? ` (${laft.matches})` : ''}</span>;
                            })()}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {progreso && (
                <div className="mt-3 rounded-[12px] border p-4" style={{ borderColor: 'var(--flit-border-soft)', background: 'var(--flit-bg-app)' }}>
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
                    <span className="font-semibold">Lote #{progreso.loteId} · procesando en segundo plano</span>
                    <span>{progreso.procesadas} / {progreso.totalFilas} ({progreso.pct}%)</span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full" style={{ background: 'rgba(125,135,152,0.2)' }}>
                    <div className="h-full rounded-full transition-all duration-500" style={{ width: `${progreso.pct}%`, background: 'var(--flit-gradient-primary)' }} />
                  </div>
                  <p className="mt-2 text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>
                    {progreso.ok} creado(s) · {progreso.errores} error(es). Puedes dejar esta pestaña abierta; el progreso se actualiza solo.
                  </p>
                </div>
              )}

              <div className="mt-3 flex flex-wrap items-center gap-2">
                <input value={nombre} onChange={(e) => setNombre(e.target.value)} placeholder="Nombre del lote (opcional)" className={`${inp} max-w-xs`} style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-primary)' }} disabled={confirming} />
                <button type="button" onClick={confirmar} disabled={confirming || preview.resumen.validas === 0}
                  className="flit-focus inline-flex h-10 items-center rounded-[999px] px-5 text-sm font-semibold text-white disabled:opacity-50" style={{ background: 'var(--flit-gradient-success)' }}>
                  {confirming ? 'Procesando…' : `Crear ${preview.resumen.validas} trámite(s)`}
                </button>
              </div>
              <p className="mt-2 text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>
                Al crear, el servidor vuelve a leer el CSV y procesa cada fila en segundo plano (pre-vuelo + borradores).
              </p>
            </div>
          )}
        </div>
      )}

      {tab === 'historial' && (
        <div>
          {detalle ? (
            <LoteDetalleView
              detalle={detalle}
              loading={detalleLoading}
              reprocesando={reprocesando}
              onVolver={() => setDetalle(null)}
              onReprocesar={() => reintentarErrores(detalle.lote.id, () => verDetalle(detalle.lote.id))}
              onDescargar={() => descargarResultados(detalle.lote.id)}
            />
          ) : (
            <div>
              <div className="mb-2 flex items-center justify-between">
                <span className="text-sm font-semibold" style={{ color: 'var(--flit-text-secondary)' }}>
                  {lista ? `${lista.total} lote(s)` : 'Cargando…'}
                </span>
                <button type="button" onClick={() => cargarHistorial(lista?.page ?? 1)} disabled={listaLoading}
                  className="flit-focus inline-flex h-8 items-center rounded-[999px] border bg-white px-3 text-xs font-medium disabled:opacity-50" style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-secondary)' }}>
                  {listaLoading ? 'Actualizando…' : 'Actualizar'}
                </button>
              </div>

              {lista && lista.items.length === 0 ? (
                <p className="mt-6 text-center text-sm" style={{ color: 'var(--flit-text-muted)' }}>Aún no hay lotes creados.</p>
              ) : (
                <div className="max-h-80 overflow-auto rounded-[12px] border" style={{ borderColor: 'var(--flit-border-soft)' }}>
                  <table className="w-full text-left text-xs">
                    <thead>
                      <tr style={{ background: 'var(--flit-bg-app)', color: 'var(--flit-text-muted)' }}>
                        <th className="px-3 py-2 font-semibold">#</th>
                        <th className="px-3 py-2 font-semibold">Nombre</th>
                        <th className="px-3 py-2 font-semibold">Fecha</th>
                        <th className="px-3 py-2 font-semibold">OK / Errores</th>
                        <th className="px-3 py-2 font-semibold"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {lista?.items.map((l) => (
                        <tr key={l.id} className="border-t" style={{ borderColor: 'var(--flit-border-soft)' }}>
                          <td className="px-3 py-2 font-bold" style={{ color: 'var(--flit-blue-text)' }}>#{l.id}</td>
                          <td className="px-3 py-2" style={{ color: 'var(--flit-text-primary)' }}>{l.nombre || <span style={{ color: 'var(--flit-text-muted)' }}>(sin nombre)</span>}</td>
                          <td className="px-3 py-2" style={{ color: 'var(--flit-text-secondary)' }}>{fmtFecha(l.createdAt)}</td>
                          <td className="px-3 py-2">
                            <span style={{ color: 'var(--flit-success)' }}>{l.ok}</span>
                            <span style={{ color: 'var(--flit-text-muted)' }}> / </span>
                            <span style={{ color: l.errores > 0 ? 'var(--flit-danger)' : 'var(--flit-text-muted)' }}>{l.errores}</span>
                            {l.estado && l.estado !== 'listo' && (
                              <span className="ml-2 text-[10px] font-semibold" style={{ color: (ESTADO_LOTE[l.estado] ?? ESTADO_LOTE.procesando).color }}>
                                {(ESTADO_LOTE[l.estado] ?? ESTADO_LOTE.procesando).label}
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-right">
                            <button type="button" onClick={() => verDetalle(l.id)}
                              className="flit-focus inline-flex h-7 items-center rounded-[999px] border bg-white px-3 text-[11px] font-semibold" style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-blue-text)' }}>
                              Ver detalle
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {lista && lista.total > lista.limit && (
                <div className="mt-3 flex items-center justify-center gap-3 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
                  <button type="button" disabled={lista.page <= 1 || listaLoading} onClick={() => cargarHistorial(lista.page - 1)}
                    className="flit-focus inline-flex h-8 items-center rounded-[999px] border bg-white px-3 font-medium disabled:opacity-40" style={{ borderColor: 'var(--flit-border-input)' }}>
                    Anterior
                  </button>
                  <span>Página {lista.page} de {Math.max(1, Math.ceil(lista.total / lista.limit))}</span>
                  <button type="button" disabled={lista.page >= Math.ceil(lista.total / lista.limit) || listaLoading} onClick={() => cargarHistorial(lista.page + 1)}
                    className="flit-focus inline-flex h-8 items-center rounded-[999px] border bg-white px-3 font-medium disabled:opacity-40" style={{ borderColor: 'var(--flit-border-input)' }}>
                    Siguiente
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const ESTADO_FILA: Record<string, { label: string; color: string; bg: string }> = {
  ok: { label: 'Creado', color: 'var(--flit-success)', bg: 'rgba(112,207,58,0.15)' },
  error: { label: 'Error', color: 'var(--flit-danger)', bg: 'rgba(228,61,48,0.15)' },
  pendiente: { label: 'Pendiente', color: 'var(--flit-warning)', bg: 'rgba(240,90,53,0.15)' },
};

const ESTADO_LOTE: Record<string, { label: string; color: string }> = {
  procesando: { label: 'Procesando', color: 'var(--flit-warning)' },
  listo: { label: 'Listo', color: 'var(--flit-success)' },
  error: { label: 'Error', color: 'var(--flit-danger)' },
};

function LoteDetalleView({ detalle, loading, reprocesando, onVolver, onReprocesar, onDescargar }: {
  detalle: LoteDetalle; loading: boolean; reprocesando: boolean;
  onVolver: () => void; onReprocesar: () => void; onDescargar: () => void;
}) {
  const { lote, filas } = detalle;
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <button type="button" onClick={onVolver}
          className="flit-focus inline-flex h-8 items-center rounded-[999px] border bg-white px-3 text-xs font-medium" style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-secondary)' }}>
          ← Volver
        </button>
        <span className="text-sm font-bold" style={{ color: 'var(--flit-blue-text)' }}>Lote #{lote.id}{lote.nombre ? ` · ${lote.nombre}` : ''}</span>
        <span className="text-xs" style={{ color: 'var(--flit-success)' }}>{lote.ok} creado(s)</span>
        <span className="text-xs" style={{ color: lote.errores > 0 ? 'var(--flit-danger)' : 'var(--flit-text-muted)' }}>{lote.errores} error(es)</span>
        {lote.estado && lote.estado !== 'listo' && (
          <span className="text-xs font-semibold" style={{ color: (ESTADO_LOTE[lote.estado] ?? ESTADO_LOTE.procesando).color }}>
            {(ESTADO_LOTE[lote.estado] ?? ESTADO_LOTE.procesando).label}
          </span>
        )}
        <span className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>{fmtFecha(lote.createdAt)}</span>
      </div>

      <div className="mb-3 flex flex-wrap gap-2">
        {lote.errores > 0 && (
          <button type="button" onClick={onReprocesar} disabled={reprocesando}
            className="flit-focus inline-flex h-9 items-center rounded-[999px] px-4 text-sm font-semibold text-white disabled:opacity-50" style={{ background: 'var(--flit-gradient-primary)' }}>
            {reprocesando ? 'Reintentando…' : 'Reintentar errores'}
          </button>
        )}
        <button type="button" onClick={onDescargar}
          className="flit-focus inline-flex h-9 items-center rounded-[999px] border bg-white px-4 text-sm font-medium" style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-secondary)' }}>
          Descargar CSV
        </button>
      </div>

      {loading ? (
        <p className="text-sm" style={{ color: 'var(--flit-text-muted)' }}>Cargando…</p>
      ) : (
        <div className="max-h-80 overflow-auto rounded-[12px] border" style={{ borderColor: 'var(--flit-border-soft)' }}>
          <table className="w-full text-left text-xs">
            <thead>
              <tr style={{ background: 'var(--flit-bg-app)', color: 'var(--flit-text-muted)' }}>
                <th className="px-3 py-2 font-semibold">#</th>
                <th className="px-3 py-2 font-semibold">VIN</th>
                <th className="px-3 py-2 font-semibold">Placa</th>
                <th className="px-3 py-2 font-semibold">Tipología</th>
                <th className="px-3 py-2 font-semibold">Estado</th>
                <th className="px-3 py-2 font-semibold">Trámite / Error</th>
              </tr>
            </thead>
            <tbody>
              {filas.map((f) => {
                const est = ESTADO_FILA[f.estado] ?? { label: f.estado, color: 'var(--flit-text-muted)', bg: 'rgba(125,135,152,0.12)' };
                return (
                  <tr key={f.fila} className="border-t" style={{ borderColor: 'var(--flit-border-soft)' }}>
                    <td className="px-3 py-2" style={{ color: 'var(--flit-text-muted)' }}>{f.fila}</td>
                    <td className="px-3 py-2 font-mono" style={{ color: 'var(--flit-text-primary)' }}>{f.vin || '—'}</td>
                    <td className="px-3 py-2" style={{ color: 'var(--flit-text-secondary)' }}>{f.placa || '—'}</td>
                    <td className="px-3 py-2" style={{ color: 'var(--flit-text-secondary)' }}>{f.tipologiaCodigo}</td>
                    <td className="px-3 py-2">
                      <span className="rounded-full px-2 py-0.5 text-[10px] font-bold" style={{ background: est.bg, color: est.color }}>{est.label}</span>
                    </td>
                    <td className="px-3 py-2" style={{ color: f.estado === 'error' ? 'var(--flit-danger)' : 'var(--flit-text-secondary)' }}>
                      {f.tramiteId ? `#${f.tramiteId}` : (f.errorMsg || '—')}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
