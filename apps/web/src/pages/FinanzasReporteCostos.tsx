// Finanzas — Reporte de costos. Cada fila muestra los valores SELLADOS si el trámite está
// liquidado, o un ESTIMADO en vivo si no. La distinción se pinta, porque un estimado puede cambiar
// mañana y un sellado no. Rol `financiera` (+ admin/auditor, este último en solo lectura).

import { useEffect, useState } from 'react';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import FlitModal from '../components/flit/FlitModal';
import StatusChip from '../components/flit/StatusChip';
import {
  FlitCard, FlitTable, FlitTh, FlitTr, FlitEmpty, flitInp, FlitPillGroup, FlitPillButton,
  flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle,
} from '../components/flit/flitPageKit';

interface Fila {
  tramiteId: string; idFlit: string; placa: string | null; estado: string | null; empresa: string | null;
  tipoTramite: string | null;
  soat: number | null; impuesto: number | null; derechoTramite: number | null;
  logistica: number | null; tramiteDigital: number | null; gmf: number | null; total: number | null;
  sellada: boolean;
  estadoLiquidacion: 'liquidado' | 'facturado' | null;
  noConfigurados: string[];
}
interface Totales {
  soat: number; impuesto: number; derechoTramite: number; logistica: number; tramiteDigital: number;
  gmf: number; total: number; filasIncompletas: number;
}
interface Reporte { items: Fila[]; total: number; page: number; pageSize: number; totales: Totales }
interface Facetas { estados: string[]; empresas: { nit: string; nombre: string | null }[]; tipos: string[] }
interface Soporte { id: string; origen: string; tipo: string; nombreArchivo: string; url: string; subidoEn: string }

const pesos = (n: number) => n.toLocaleString('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 });

/**
 * Etiquetas de los conceptos que el backend puede reportar como no configurados. Se usan para el
 * encabezado Y para cruzar con `noConfigurados`, para que ambos no puedan divergir.
 */
const CONCEPTO = {
  soat: 'SOAT', impuesto: 'Impuesto', derecho: 'Derecho de tránsito',
  digital: 'Trámite digital', logistica: 'Logística',
} as const;

/**
 * Un concepto sin valor no siempre significa lo mismo, y decir lo que no es hace daño:
 *   falta = true  → el dato DEBERÍA estar y no está: falta la tarifa o el recibo. Hay que actuar.
 *   falta = false → no aplica a este trámite (exento, o la compañía lo autogestiona). No hay nada
 *                   que hacer, así que se pinta un guion en vez de acusar una configuración ausente.
 * En ningún caso se pinta «$ 0»: un cero se suma en la cabeza de quien lee.
 */
function Monto({ v, falta, negrita }: { v: number | null; falta?: boolean; negrita?: boolean }) {
  if (v === null) {
    return (
      <span className="text-xs italic" style={{ color: 'var(--flit-text-muted)' }}>
        {falta ? 'No configurado' : '—'}
      </span>
    );
  }
  return <span className={negrita ? 'font-semibold' : undefined}>{pesos(v)}</span>;
}

export default function FinanzasReporteCostos() {
  const { user } = useAuth();
  // Auditoría observa la conciliación; no la ejecuta.
  const puedeLiquidar = user?.role === 'admin' || user?.role === 'financiera';
  const puedeReversar = user?.role === 'admin';

  const [data, setData] = useState<Reporte | null>(null);
  const [facetas, setFacetas] = useState<Facetas | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [recarga, setRecarga] = useState(0);
  const [enProceso, setEnProceso] = useState(false);
  const [soportesDe, setSoportesDe] = useState<Fila | null>(null);
  const [seleccion, setSeleccion] = useState<Set<string>>(new Set());

  const [buscar, setBuscar] = useState('');
  const [empresa, setEmpresa] = useState('');
  const [tipo, setTipo] = useState('');
  const [liquidado, setLiquidado] = useState<'' | 'si' | 'no'>('');
  const [facturado, setFacturado] = useState<'' | 'si' | 'no'>('');
  const [desde, setDesde] = useState('');
  const [hasta, setHasta] = useState('');
  const [estados, setEstados] = useState<string[]>([]);
  const [page, setPage] = useState(1);

  const estadosKey = estados.join(',');

  const params = () => {
    const p = new URLSearchParams();
    if (buscar.trim()) p.set('buscar', buscar.trim());
    if (empresa) p.set('empresas', empresa);
    if (tipo) p.set('tipos', tipo);
    if (liquidado) p.set('liquidado', liquidado);
    if (facturado) p.set('facturado', facturado);
    if (desde) p.set('desde', desde);
    if (hasta) p.set('hasta', hasta);
    if (estados.length) p.set('estados', estados.join(','));
    return p;
  };

  useEffect(() => { setPage(1); setSeleccion(new Set()); }, [buscar, empresa, tipo, liquidado, facturado, desde, hasta, estadosKey]);

  useEffect(() => {
    setError(null);
    const p = params();
    p.set('page', String(page));
    api.get<Reporte>(`/finanzas/reporte-costos?${p.toString()}`).then(setData).catch((e) => setError(errorMessage(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buscar, empresa, tipo, liquidado, facturado, desde, hasta, estadosKey, page, recarga]);

  useEffect(() => { api.get<Facetas>('/finanzas/reporte-costos/facetas').then(setFacetas).catch(() => setFacetas(null)); }, []);

  const toggleEstado = (e: string) => setEstados((p) => (p.includes(e) ? p.filter((x) => x !== e) : [...p, e]));
  const filas = data?.items ?? [];
  const totalPaginas = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const refrescar = () => setRecarga((n) => n + 1);

  /** Solo se puede liquidar lo que no está liquidado y tiene todos sus conceptos resueltos. */
  const liquidable = (f: Fila) => !f.sellada && f.noConfigurados.length === 0;
  const liquidables = filas.filter(liquidable);

  const ejecutar = async (fn: () => Promise<string>) => {
    setEnProceso(true); setError(null); setAviso(null);
    try { setAviso(await fn()); refrescar(); setSeleccion(new Set()); }
    catch (e) { setError(errorMessage(e)); }
    finally { setEnProceso(false); }
  };

  const liquidarUno = (f: Fila) => ejecutar(async () => {
    await api.post(`/flito/liquidacion/${f.tramiteId}/liquidar`, {});
    return `${f.idFlit} liquidado.`;
  });

  const liquidarLote = () => ejecutar(async () => {
    const r = await api.post<{ liquidados: string[]; fallidos: { motivo: string }[] }>(
      '/flito/liquidacion/lote/liquidar', { tramiteIds: [...seleccion] });
    return `${r.liquidados.length} liquidados, ${r.fallidos.length} sin liquidar.`;
  });

  const facturarUno = (f: Fila) => ejecutar(async () => {
    await api.post(`/flito/liquidacion/${f.tramiteId}/facturar`, {});
    return `${f.idFlit} marcado como facturado.`;
  });

  const reversarUno = (f: Fila, motivo: string) => ejecutar(async () => {
    await api.post(`/flito/liquidacion/${f.tramiteId}/reversar`, { motivo });
    return `Liquidación de ${f.idFlit} reversada.`;
  });

  const exportar = () => {
    // La exportación cubre TODO el filtro, no la página: se abre en una pestaña para que el
    // navegador gestione la descarga con su propio indicador de progreso.
    window.open(`/api/finanzas/reporte-costos/export?${params().toString()}`, '_blank');
  };

  return (
    <div className="space-y-4">
      <PageHeaderCard title="Reporte de costos"
        subtitle="Costos reales por trámite. Las filas liquidadas muestran valores sellados; el resto, un estimado con las tarifas vigentes."
        actions={<button className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={exportar}>Exportar CSV</button>} />

      <FlitCard>
        <div className="flex flex-wrap items-center gap-3">
          <input className={flitInp + ' max-w-xs'} placeholder="Buscar placa, VIN o trámite FLIT…" value={buscar} onChange={(e) => setBuscar(e.target.value)} />
          <select className={flitInp + ' max-w-xs'} value={empresa} onChange={(e) => setEmpresa(e.target.value)}>
            <option value="">Todas las empresas</option>
            {facetas?.empresas.map((e) => <option key={e.nit} value={e.nit}>{e.nombre ?? e.nit}</option>)}
          </select>
          <select className={flitInp} value={tipo} onChange={(e) => setTipo(e.target.value)}>
            <option value="">Todos los tipos</option>
            {facetas?.tipos.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <select className={flitInp} aria-label="Liquidación" value={liquidado} onChange={(e) => setLiquidado(e.target.value as '' | 'si' | 'no')}>
            <option value="">Liquidados y sin liquidar</option>
            <option value="si">Solo liquidados</option>
            <option value="no">Solo sin liquidar</option>
          </select>
          <select className={flitInp} aria-label="Facturación" value={facturado} onChange={(e) => setFacturado(e.target.value as '' | 'si' | 'no')}>
            <option value="">Facturados y no facturados</option>
            <option value="si">Solo facturados</option>
            <option value="no">Solo no facturados</option>
          </select>
          <label className="flex items-center gap-2 text-xs font-semibold" style={{ color: 'var(--flit-text-secondary)' }}>
            Desde <input type="date" className={flitInp} value={desde} onChange={(e) => setDesde(e.target.value)} />
          </label>
          <label className="flex items-center gap-2 text-xs font-semibold" style={{ color: 'var(--flit-text-secondary)' }}>
            Hasta <input type="date" className={flitInp} value={hasta} onChange={(e) => setHasta(e.target.value)} />
          </label>
        </div>
        {facetas && facetas.estados.length > 0 && (
          <div className="mt-3">
            <FlitPillGroup>
              {facetas.estados.map((e) => <FlitPillButton key={e} active={estados.includes(e)} onClick={() => toggleEstado(e)}>{e}</FlitPillButton>)}
            </FlitPillGroup>
          </div>
        )}
      </FlitCard>

      {error && <FlitCard><p className="text-sm text-red-600">{error}</p></FlitCard>}
      {aviso && <FlitCard><p className="text-sm" style={{ color: 'var(--flit-blue-text)' }}>{aviso}</p></FlitCard>}

      {/* Un total al que le faltan conceptos no puede pasar por completo. */}
      {data && data.totales.filasIncompletas > 0 && (
        <FlitCard>
          <p className="text-sm">
            <strong>{data.totales.filasIncompletas.toLocaleString('es-CO')}</strong> de{' '}
            <strong>{data.total.toLocaleString('es-CO')}</strong> trámites tienen algún concepto sin
            configurar, así que el total mostrado está incompleto. Revisa las tarifas de la compañía
            en Parametrización y los recibos de derecho de tránsito pendientes.
          </p>
        </FlitCard>
      )}

      {puedeLiquidar && seleccion.size > 0 && (
        <FlitCard>
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm font-semibold">{seleccion.size} seleccionado(s)</span>
            <button className={flitBtnPrimary} style={flitBtnPrimaryStyle} disabled={enProceso} onClick={liquidarLote}>
              {enProceso ? 'Liquidando…' : 'Liquidar seleccionados'}
            </button>
            <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={() => setSeleccion(new Set())}>Quitar selección</button>
          </div>
        </FlitCard>
      )}

      {data && filas.length === 0 && <FlitCard><FlitEmpty>No hay trámites que coincidan con los filtros.</FlitEmpty></FlitCard>}

      {filas.length > 0 && (
        <FlitCard>
          <div className="mb-3"><Paginacion total={data!.total} page={data!.page} totalPaginas={totalPaginas} onPrev={() => setPage((p) => Math.max(1, p - 1))} onNext={() => setPage((p) => p + 1)} /></div>
          <div className="overflow-x-auto">
            <FlitTable>
              <thead>
                <FlitTr>
                  {puedeLiquidar && (
                    <FlitTh>
                      <input type="checkbox" aria-label="Seleccionar liquidables"
                        checked={liquidables.length > 0 && liquidables.every((f) => seleccion.has(f.tramiteId))}
                        onChange={(e) => setSeleccion(e.target.checked ? new Set(liquidables.map((f) => f.tramiteId)) : new Set())} />
                    </FlitTh>
                  )}
                  <FlitTh>Trámite</FlitTh>
                  <FlitTh center>{CONCEPTO.soat}</FlitTh>
                  <FlitTh center>{CONCEPTO.impuesto}</FlitTh>
                  <FlitTh center>{CONCEPTO.derecho}</FlitTh>
                  <FlitTh center>{CONCEPTO.logistica}</FlitTh>
                  <FlitTh center>{CONCEPTO.digital}</FlitTh>
                  <FlitTh center>GMF</FlitTh>
                  <FlitTh center>Total</FlitTh>
                  <FlitTh />
                </FlitTr>
              </thead>
              <tbody>
                {filas.map((f) => (
                  <FlitTr key={f.tramiteId}>
                    {puedeLiquidar && (
                      <td className="px-3 py-2">
                        {liquidable(f) && (
                          <input type="checkbox" aria-label={`Seleccionar ${f.idFlit}`}
                            checked={seleccion.has(f.tramiteId)}
                            onChange={() => setSeleccion((s) => {
                              const n = new Set(s);
                              if (n.has(f.tramiteId)) n.delete(f.tramiteId); else n.add(f.tramiteId);
                              return n;
                            })} />
                        )}
                      </td>
                    )}
                    <td className="px-4 py-2">
                      <div className="text-sm font-medium tabular-nums">{f.idFlit}</div>
                      <div className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>{f.placa ?? '—'}{f.empresa ? ` · ${f.empresa}` : ''}</div>
                      <div className="mt-1">
                        {f.estadoLiquidacion === 'facturado'
                          ? <StatusChip tone="success">Facturado</StatusChip>
                          : f.sellada
                            ? <StatusChip tone="active">Liquidado</StatusChip>
                            : <StatusChip tone="draft">Estimado</StatusChip>}
                      </div>
                    </td>
                    {/* SOAT e impuesto nunca entran en `noConfigurados`: su ausencia significa
                        exento o autogestionado, no una configuración que falte. */}
                    <td className="px-4 py-2 text-right tabular-nums"><Monto v={f.soat} /></td>
                    <td className="px-4 py-2 text-right tabular-nums"><Monto v={f.impuesto} /></td>
                    <td className="px-4 py-2 text-right tabular-nums"><Monto v={f.derechoTramite} falta={f.noConfigurados.includes(CONCEPTO.derecho)} /></td>
                    <td className="px-4 py-2 text-right tabular-nums"><Monto v={f.logistica} falta={f.noConfigurados.includes(CONCEPTO.logistica)} /></td>
                    <td className="px-4 py-2 text-right tabular-nums"><Monto v={f.tramiteDigital} falta={f.noConfigurados.includes(CONCEPTO.digital)} /></td>
                    <td className="px-4 py-2 text-right tabular-nums"><Monto v={f.gmf} /></td>
                    <td className="px-4 py-2 text-right tabular-nums" style={{ color: 'var(--flit-blue-text)' }}><Monto v={f.total} negrita /></td>
                    <td className="px-3 py-2">
                      <Acciones fila={f} puedeLiquidar={puedeLiquidar} puedeReversar={puedeReversar} enProceso={enProceso}
                        onLiquidar={() => liquidarUno(f)} onFacturar={() => facturarUno(f)}
                        onReversar={(m) => reversarUno(f, m)} onSoportes={() => setSoportesDe(f)} />
                    </td>
                  </FlitTr>
                ))}
              </tbody>
              {data && (
                <tfoot>
                  <FlitTr>
                    {puedeLiquidar && <td />}
                    <td className="px-4 py-2 text-xs font-semibold" style={{ color: 'var(--flit-text-secondary)' }}>
                      Totales ({data.total.toLocaleString('es-CO')} trámites del filtro)
                    </td>
                    <td className="px-4 py-2 text-right font-semibold tabular-nums">{pesos(data.totales.soat)}</td>
                    <td className="px-4 py-2 text-right font-semibold tabular-nums">{pesos(data.totales.impuesto)}</td>
                    <td className="px-4 py-2 text-right font-semibold tabular-nums">{pesos(data.totales.derechoTramite)}</td>
                    <td className="px-4 py-2 text-right font-semibold tabular-nums">{pesos(data.totales.logistica)}</td>
                    <td className="px-4 py-2 text-right font-semibold tabular-nums">{pesos(data.totales.tramiteDigital)}</td>
                    <td className="px-4 py-2 text-right font-semibold tabular-nums">{pesos(data.totales.gmf)}</td>
                    <td className="px-4 py-2 text-right font-semibold tabular-nums" style={{ color: 'var(--flit-blue-text)' }}>{pesos(data.totales.total)}</td>
                    <td />
                  </FlitTr>
                </tfoot>
              )}
            </FlitTable>
          </div>

          <div className="mt-3"><Paginacion total={data!.total} page={data!.page} totalPaginas={totalPaginas} onPrev={() => setPage((p) => Math.max(1, p - 1))} onNext={() => setPage((p) => p + 1)} /></div>
        </FlitCard>
      )}

      {soportesDe && <VisorSoportes fila={soportesDe} onClose={() => setSoportesDe(null)} />}
    </div>
  );
}

function Acciones({ fila, puedeLiquidar, puedeReversar, enProceso, onLiquidar, onFacturar, onReversar, onSoportes }: {
  fila: Fila; puedeLiquidar: boolean; puedeReversar: boolean; enProceso: boolean;
  onLiquidar: () => void; onFacturar: () => void; onReversar: (motivo: string) => void; onSoportes: () => void;
}) {
  const [reversando, setReversando] = useState(false);
  const [motivo, setMotivo] = useState('');
  const bloqueado = fila.noConfigurados.length > 0;

  return (
    <div className="flex flex-wrap items-center gap-1">
      <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={onSoportes}>Soporte</button>

      {puedeLiquidar && !fila.sellada && (
        <button className={flitBtnPrimary} style={flitBtnPrimaryStyle} disabled={enProceso || bloqueado}
          title={bloqueado ? `Falta: ${fila.noConfigurados.join(', ')}` : 'Sellar los valores de este trámite'}
          onClick={onLiquidar}>Liquidar</button>
      )}
      {/* Por qué NO se puede liquidar, sin obligar a pasar el ratón por encima del botón. */}
      {puedeLiquidar && !fila.sellada && bloqueado && (
        <span className="text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>Falta: {fila.noConfigurados.join(', ')}</span>
      )}

      {puedeLiquidar && fila.estadoLiquidacion === 'liquidado' && (
        <button className={flitBtnPrimary} style={flitBtnPrimaryStyle} disabled={enProceso} onClick={onFacturar}>Facturar</button>
      )}
      {/* Tras facturar ya no se ofrece reversar: los valores quedan congelados de verdad. */}
      {puedeReversar && fila.estadoLiquidacion === 'liquidado' && (
        reversando ? (
          <span className="flex items-center gap-1">
            <input className={`${flitInp} h-8 w-40 text-xs`} placeholder="Motivo del reverso" aria-label="Motivo del reverso"
              value={motivo} onChange={(e) => setMotivo(e.target.value)} />
            <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} disabled={motivo.trim().length < 5 || enProceso}
              onClick={() => { onReversar(motivo.trim()); setReversando(false); setMotivo(''); }}>Confirmar</button>
          </span>
        ) : (
          <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={() => setReversando(true)}>Reversar</button>
        )
      )}
    </div>
  );
}

/** Visor de los soportes del trámite: SOAT, impuesto y derecho en una sola vista. */
function VisorSoportes({ fila, onClose }: { fila: Fila; onClose: () => void }) {
  const [soportes, setSoportes] = useState<Soporte[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activo, setActivo] = useState<Soporte | null>(null);

  useEffect(() => {
    api.get<Soporte[]>(`/finanzas/tramites/${fila.tramiteId}/soportes`)
      .then((s) => { setSoportes(s); setActivo(s[0] ?? null); })
      .catch((e) => setError(errorMessage(e)));
  }, [fila.tramiteId]);

  return (
    <FlitModal title={`Soportes de ${fila.idFlit}`} onClose={onClose}>
      {error && <p className="text-sm text-red-600">{error}</p>}
      {!soportes && !error && <p className="text-sm" style={{ color: 'var(--flit-text-muted)' }}>Cargando…</p>}
      {soportes && soportes.length === 0 && (
        <FlitEmpty>Este trámite no tiene ningún soporte cargado todavía.</FlitEmpty>
      )}
      {soportes && soportes.length > 0 && (
        <div className="space-y-3">
          <FlitPillGroup>
            {soportes.map((s) => (
              <FlitPillButton key={s.id} active={activo?.id === s.id} onClick={() => setActivo(s)}>
                {s.origen} · {s.nombreArchivo}
              </FlitPillButton>
            ))}
          </FlitPillGroup>
          {activo && (
            <object data={activo.url} type="application/pdf" className="h-[600px] w-full rounded-md border">
              <a href={activo.url} target="_blank" rel="noreferrer" style={{ color: 'var(--flit-blue-text)' }}>
                Abrir el documento
              </a>
            </object>
          )}
        </div>
      )}
    </FlitModal>
  );
}

function Paginacion({ total, page, totalPaginas, onPrev, onNext }: {
  total: number; page: number; totalPaginas: number; onPrev: () => void; onNext: () => void;
}) {
  const btn = 'rounded-lg border px-3 py-1.5 text-sm font-semibold disabled:opacity-40';
  const btnStyle = { borderColor: 'var(--flit-border-input)', color: 'var(--flit-blue-text)' } as const;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
        <strong style={{ color: 'var(--flit-text-primary)' }}>{total.toLocaleString('es-CO')}</strong> trámites · página {page} de {totalPaginas}
      </span>
      <div className="flex gap-2">
        <button className={btn} style={btnStyle} disabled={page <= 1} onClick={onPrev}>← Anterior</button>
        <button className={btn} style={btnStyle} disabled={page >= totalPaginas} onClick={onNext}>Siguiente →</button>
      </div>
    </div>
  );
}
