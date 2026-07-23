// Finanzas — Reporte de costos. Tabla de trámites con el costo de SOAT e impuesto (0 si aún no tienen
// valor) más los conceptos fijos del trámite (hardcode por ahora). Rol `financiera` (+ admin/auditor).

import { useEffect, useState } from 'react';
import { api, errorMessage } from '../lib/api';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import {
  FlitCard, FlitTable, FlitTh, FlitTr, FlitEmpty, flitInp, FlitPillGroup, FlitPillButton,
} from '../components/flit/flitPageKit';

interface Fila {
  tramiteId: string; idFlit: string; placa: string | null; estado: string | null; empresa: string | null;
  soat: number; impuesto: number; derechoTramite: number; logistica: number; tramiteDigital: number; gmf: number; total: number;
}
interface Totales { soat: number; impuesto: number; derechoTramite: number; logistica: number; tramiteDigital: number; gmf: number; total: number }
interface Reporte { items: Fila[]; total: number; page: number; pageSize: number; totales: Totales }
interface Facetas { estados: string[]; empresas: { nit: string; nombre: string | null }[] }

const pesos = (n: number) => n.toLocaleString('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 });

export default function FinanzasReporteCostos() {
  const [data, setData] = useState<Reporte | null>(null);
  const [facetas, setFacetas] = useState<Facetas | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [buscar, setBuscar] = useState('');
  const [empresa, setEmpresa] = useState('');
  const [estados, setEstados] = useState<string[]>([]);
  const [page, setPage] = useState(1);

  useEffect(() => { setPage(1); }, [buscar, empresa, estados]);

  useEffect(() => {
    setError(null);
    const params = new URLSearchParams();
    if (buscar.trim()) params.set('buscar', buscar.trim());
    if (empresa) params.set('empresas', empresa);
    if (estados.length) params.set('estados', estados.join(','));
    params.set('page', String(page));
    api.get<Reporte>(`/finanzas/reporte-costos?${params.toString()}`).then(setData).catch((e) => setError(errorMessage(e)));
  }, [buscar, empresa, estados, page]);

  useEffect(() => { api.get<Facetas>('/finanzas/reporte-costos/facetas').then(setFacetas).catch(() => setFacetas(null)); }, []);

  const toggleEstado = (e: string) => setEstados((p) => (p.includes(e) ? p.filter((x) => x !== e) : [...p, e]));
  const filas = data?.items ?? [];
  const totalPaginas = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <div className="space-y-4">
      <PageHeaderCard title="Reporte de costos"
        subtitle="Costos por trámite: SOAT e impuesto (0 si aún no tienen valor) más los conceptos fijos del trámite." />

      <FlitCard>
        <div className="flex flex-wrap items-center gap-3">
          <input className={flitInp + ' max-w-xs'} placeholder="Buscar placa, VIN o trámite FLIT…" value={buscar} onChange={(e) => setBuscar(e.target.value)} />
          <select className={flitInp + ' max-w-xs'} value={empresa} onChange={(e) => setEmpresa(e.target.value)}>
            <option value="">Todas las empresas</option>
            {facetas?.empresas.map((e) => <option key={e.nit} value={e.nit}>{e.nombre ?? e.nit}</option>)}
          </select>
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

      {data && filas.length === 0 && <FlitCard><FlitEmpty>No hay trámites que coincidan con los filtros.</FlitEmpty></FlitCard>}

      {filas.length > 0 && (
        <FlitCard>
          {/* Paginación ARRIBA (visible sin bajar) y también abajo. */}
          <div className="mb-3"><Paginacion total={data!.total} page={data!.page} totalPaginas={totalPaginas} onPrev={() => setPage((p) => Math.max(1, p - 1))} onNext={() => setPage((p) => p + 1)} /></div>
          <div className="overflow-x-auto">
            <FlitTable>
              <thead>
                <FlitTr>
                  <FlitTh>Trámite</FlitTh>
                  <FlitTh center>SOAT</FlitTh>
                  <FlitTh center>Impuesto</FlitTh>
                  <FlitTh center>Derecho de trámite</FlitTh>
                  <FlitTh center>Logística</FlitTh>
                  <FlitTh center>Trámite digital</FlitTh>
                  <FlitTh center>GMF</FlitTh>
                  <FlitTh center>Total</FlitTh>
                </FlitTr>
              </thead>
              <tbody>
                {filas.map((f) => (
                  <FlitTr key={f.tramiteId}>
                    <td className="px-4 py-2">
                      <div className="text-sm font-medium tabular-nums">{f.idFlit}</div>
                      <div className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>{f.placa ?? '—'}{f.empresa ? ` · ${f.empresa}` : ''}</div>
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">{pesos(f.soat)}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{pesos(f.impuesto)}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{pesos(f.derechoTramite)}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{pesos(f.logistica)}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{pesos(f.tramiteDigital)}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{pesos(f.gmf)}</td>
                    <td className="px-4 py-2 text-right font-semibold tabular-nums" style={{ color: 'var(--flit-blue-text)' }}>{pesos(f.total)}</td>
                  </FlitTr>
                ))}
              </tbody>
              {data && (
                <tfoot>
                  <FlitTr>
                    <td className="px-4 py-2 text-xs font-semibold" style={{ color: 'var(--flit-text-secondary)' }}>Totales (página)</td>
                    <td className="px-4 py-2 text-right font-semibold tabular-nums">{pesos(data.totales.soat)}</td>
                    <td className="px-4 py-2 text-right font-semibold tabular-nums">{pesos(data.totales.impuesto)}</td>
                    <td className="px-4 py-2 text-right font-semibold tabular-nums">{pesos(data.totales.derechoTramite)}</td>
                    <td className="px-4 py-2 text-right font-semibold tabular-nums">{pesos(data.totales.logistica)}</td>
                    <td className="px-4 py-2 text-right font-semibold tabular-nums">{pesos(data.totales.tramiteDigital)}</td>
                    <td className="px-4 py-2 text-right font-semibold tabular-nums">{pesos(data.totales.gmf)}</td>
                    <td className="px-4 py-2 text-right font-semibold tabular-nums" style={{ color: 'var(--flit-blue-text)' }}>{pesos(data.totales.total)}</td>
                  </FlitTr>
                </tfoot>
              )}
            </FlitTable>
          </div>

          <div className="mt-3"><Paginacion total={data!.total} page={data!.page} totalPaginas={totalPaginas} onPrev={() => setPage((p) => Math.max(1, p - 1))} onNext={() => setPage((p) => p + 1)} /></div>
        </FlitCard>
      )}
    </div>
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
