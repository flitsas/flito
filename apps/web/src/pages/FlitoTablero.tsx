// FLITO Tablero (Fase 6). Porta packages/client/src/paginas/tablero.tsx al kit flit/ + api.
// Lo que el proceso por Excel y correo no dejaba ver: retenciones, estancamientos y diferencias.

import { puedeOperar } from '../lib/permissions';
import { useEffect, useState } from 'react';
import {
  ESTADO_IMPUESTO_LABEL, ESTADO_SOAT_LABEL, type EstadoImpuesto, type EstadoSoat,
} from '@operaciones/shared-types';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import KpiCard from '../components/flit/KpiCard';
import { FlitCard } from '../components/flit/flitPageKit';
import { flitBtnPrimary, flitBtnPrimaryStyle } from '../components/flit/flitPageKit';
import type { ChipTone } from '../components/flit/StatusChip';

interface TableroResumen {
  soat: Record<string, number>;
  impuestos: Record<string, number>;
  revisionesPendientes: { soat: number; impuestos: number };
  estancados: { soat: number; impuestos: number };
  diferenciasDeValor: number;
  compuertaHabilitados: number;
}

interface ResumenSync {
  ejecutadoEn?: string;
  tramitesLeidos?: number; tramitesNuevos?: number; soatCreados?: number;
  soatBloqueadosPorVin?: number; impuestosCreados?: number; documentosLogisticaCreados?: number;
}

function ConteosPorEstado({ titulo, conteos, etiquetas, destino }: {
  titulo: string; conteos: Record<string, number>; etiquetas: Record<string, string>; destino: string;
}) {
  const entradas = Object.entries(conteos);
  const total = entradas.reduce((s, [, n]) => s + n, 0);
  return (
    <FlitCard>
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold" style={{ color: 'var(--flit-blue-text)' }}>{titulo}</h2>
        <span className="text-xs tabular-nums" style={{ color: 'var(--flit-text-muted)' }}>{total} en total</span>
      </div>
      <div className="mt-2 space-y-1">
        {entradas.map(([estado, n]) => (
          <div key={estado} className="flex items-center justify-between rounded-md px-2 py-1 text-sm">
            <span style={{ color: 'var(--flit-text-secondary)' }}>{etiquetas[estado] ?? estado}</span>
            <span className="font-medium tabular-nums">{n}</span>
          </div>
        ))}
      </div>
    </FlitCard>
  );
}

// El backend real siempre devuelve el objeto completo; esto solo protege contra respuestas
// malformadas (mock/proxy) que, sin error boundary, dejarían el shell en blanco.
function esResumenValido(r: unknown): r is TableroResumen {
  return !!r && typeof r === 'object' && !Array.isArray(r)
    && 'revisionesPendientes' in r && 'estancados' in r && 'soat' in r && 'impuestos' in r;
}

export default function FlitoTablero() {
  const { user } = useAuth();
  const [data, setData] = useState<TableroResumen | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sync, setSync] = useState<ResumenSync | null>(null);
  const [sincronizando, setSincronizando] = useState(false);

  const puedeSincronizar = puedeOperar(user?.role);

  const cargar = () => {
    setError(null);
    api.get<TableroResumen>('/flito/tablero')
      // Blindaje: un shape inesperado (p.ej. lista vacía) no debe reventar el render y
      // dejar el shell en blanco. Exigimos las claves anidadas que consume la vista.
      .then((r) => setData(esResumenValido(r) ? r : null))
      .catch((e) => setError(errorMessage(e)));
  };
  useEffect(cargar, []);

  const sincronizar = async () => {
    setSincronizando(true);
    setError(null);
    try {
      // initialDate por defecto: últimos 30 días (para el selector de fecha, ir a Trámites).
      const desde = new Date(); desde.setDate(desde.getDate() - 30);
      const r = await api.post<ResumenSync>('/flito/sync/sincronizar', { initialDate: desde.toISOString().slice(0, 10) });
      setSync(r);
      cargar();
    } catch (e) { setError(errorMessage(e)); }
    finally { setSincronizando(false); }
  };

  const kpi = (label: string, value: number, hint: string, tone: ChipTone | null) => (
    <KpiCard label={label} value={value} hint={hint}
      chip={tone && value > 0 ? { tone, label: 'atención' } : undefined} />
  );

  return (
    <div className="space-y-4">
      <PageHeaderCard
        title="Tablero"
        subtitle="Lo que el proceso por Excel y correo no dejaba ver: retenciones, estancamientos y diferencias."
        actions={puedeSincronizar && (
          <button onClick={sincronizar} disabled={sincronizando} className={flitBtnPrimary} style={flitBtnPrimaryStyle}>
            {sincronizando ? 'Sincronizando…' : 'Sincronizar desde FLIT'}
          </button>
        )}
      />

      {error && <FlitCard><p className="text-sm text-red-600">{error}</p></FlitCard>}

      {sync && (
        <FlitCard>
          <p className="text-sm font-semibold" style={{ color: 'var(--flit-blue-text)' }}>
            Sincronización ejecutada{sync.ejecutadoEn ? ` · ${new Date(sync.ejecutadoEn).toLocaleString('es-CO')}` : ''}
          </p>
          <ul className="mt-2 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2 lg:grid-cols-3" style={{ color: 'var(--flit-text-secondary)' }}>
            <li className="flex justify-between gap-3"><span>Trámites nuevos</span><span className="font-medium tabular-nums">{sync.tramitesNuevos ?? 0}</span></li>
            <li className="flex justify-between gap-3"><span>SOAT creados</span><span className="font-medium tabular-nums">{sync.soatCreados ?? 0}</span></li>
            <li className="flex justify-between gap-3"><span>SOAT bloqueados por VIN (RN-01)</span><span className="font-medium tabular-nums">{sync.soatBloqueadosPorVin ?? 0}</span></li>
            <li className="flex justify-between gap-3"><span>Impuestos creados</span><span className="font-medium tabular-nums">{sync.impuestosCreados ?? 0}</span></li>
            <li className="flex justify-between gap-3"><span>Documentos de logística</span><span className="font-medium tabular-nums">{sync.documentosLogisticaCreados ?? 0}</span></li>
          </ul>
        </FlitCard>
      )}

      {data && (
        <>
          <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {kpi('Revisiones pendientes', data.revisionesPendientes.soat + data.revisionesPendientes.impuestos, `SOAT ${data.revisionesPendientes.soat} · Impuestos ${data.revisionesPendientes.impuestos}`, 'warning')}
            {kpi('Estancados por SLA', data.estancados.soat + data.estancados.impuestos, `SOAT ${data.estancados.soat} · Impuestos ${data.estancados.impuestos}`, 'warning')}
            {kpi('Diferencias de valor', data.diferenciasDeValor, 'Pagados cuyo recibo no cuadra con lo liquidado.', 'warning')}
            {kpi('Habilitados para entrega', data.compuertaHabilitados, 'SOAT e impuestos resueltos. Falta ejecutar.', null)}
          </section>

          <section className="grid gap-3 md:grid-cols-2">
            <ConteosPorEstado titulo="SOAT por estado" conteos={data.soat} etiquetas={ESTADO_SOAT_LABEL as Record<EstadoSoat, string>} destino="/flito/soat" />
            <ConteosPorEstado titulo="Impuestos por estado" conteos={data.impuestos} etiquetas={ESTADO_IMPUESTO_LABEL as Record<EstadoImpuesto, string>} destino="/flito/impuestos" />
          </section>
        </>
      )}

      {user?.role === 'auditor' && (
        <p className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>
          Solo lectura · Auditoría observa el tablero; no ejecuta acciones sobre él.
        </p>
      )}
    </div>
  );
}
