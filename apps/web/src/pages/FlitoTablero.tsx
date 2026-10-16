// FLITO Tablero (Fase 6). Porta packages/client/src/paginas/tablero.tsx al kit flit/ + api.
// Lo que el proceso por Excel y correo no dejaba ver: retenciones, estancamientos y diferencias.

import { useEffect, useState } from 'react';
import {
  ALERTAS_OPERATIVAS, ALERTA_OPERATIVA_LABEL, ESTADO_IMPUESTO_LABEL, ESTADO_SOAT_LABEL,
  type AlertaOperativa, type EstadoImpuesto, type EstadoSoat,
} from '@operaciones/shared-types';
import { api, errorMessage } from '../lib/api';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import KpiCard from '../components/flit/KpiCard';
import { FlitCard } from '../components/flit/flitPageKit';
import type { ChipTone } from '../components/flit/StatusChip';

interface TableroResumen {
  // HU #13428 (AC4): el API omite el bloque del módulo que el usuario no ve.
  soat?: Record<string, number>;
  impuestos?: Record<string, number>;
  revisionesPendientes: { soat?: number; impuestos?: number };
  estancados: { soat?: number; impuestos?: number };
  diferenciasDeValor: number;
  compuertaHabilitados: number;
  alertas?: Record<AlertaOperativa, number>;
}

/** Qué se ve al pulsar cada alerta. El orden es el de urgencia percibida por Operaciones. */
const PISTA_ALERTA: Record<AlertaOperativa, string> = {
  borrador_5d: 'Llevan demasiado sin salir de borrador.',
  sin_aprobar_ans: 'Creados y aún sin aprobación.',
  soat_sin_gestion: 'Solicitados al proveedor y sin respuesta dentro del ANS de un día.',
  impuesto_sin_gestion: 'Solicitados al organismo y sin respuesta dentro del ANS de un día.',
};


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
    && 'revisionesPendientes' in r && 'estancados' in r;
}

/** Suma y detalle de un indicador partido por módulo, solo con los módulos que llegaron (HU #13428). */
function porModulo(v: { soat?: number; impuestos?: number }): [number, string] {
  const partes: string[] = [];
  if (v.soat !== undefined) partes.push(`SOAT ${v.soat}`);
  if (v.impuestos !== undefined) partes.push(`Impuestos ${v.impuestos}`);
  return [(v.soat ?? 0) + (v.impuestos ?? 0), partes.join(' · ')];
}

export default function FlitoTablero() {
  const [data, setData] = useState<TableroResumen | null>(null);
  const [error, setError] = useState<string | null>(null);

  const cargar = () => {
    setError(null);
    api.get<TableroResumen>('/flito/tablero')
      // Blindaje: un shape inesperado (p.ej. lista vacía) no debe reventar el render y
      // dejar el shell en blanco. Exigimos las claves anidadas que consume la vista.
      .then((r) => setData(esResumenValido(r) ? r : null))
      .catch((e) => setError(errorMessage(e)));
  };
  useEffect(cargar, []);

  const kpi = (label: string, value: number, hint: string, tone: ChipTone | null) => (
    <KpiCard label={label} value={value} hint={hint}
      chip={tone && value > 0 ? { tone, label: 'atención' } : undefined} />
  );

  return (
    <div className="space-y-4">
      <PageHeaderCard
        title="Tablero"
        subtitle="Lo que el proceso por Excel y correo no dejaba ver: retenciones, estancamientos y diferencias."
      />

      {error && <FlitCard><p className="text-sm text-red-600">{error}</p></FlitCard>}

      {data && (
        <>
          <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {kpi('Revisiones pendientes', ...porModulo(data.revisionesPendientes), 'warning')}
            {kpi('Fuera de ANS', ...porModulo(data.estancados), 'warning')}
            {kpi('Diferencias de valor', data.diferenciasDeValor, 'Pagados cuyo recibo no cuadra con lo liquidado.', 'warning')}
            {kpi('Habilitados para entrega', data.compuertaHabilitados, 'SOAT e impuestos resueltos. Falta ejecutar.', null)}
          </section>

          {/* Alertas operativas: cada tarjeta lleva a Gestión Trámites con su filtro ya aplicado,
              para no obligar a rearmar a mano la búsqueda de lo que está en riesgo. */}
          {data.alertas && (
            <section aria-label="Alertas operativas" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {ALERTAS_OPERATIVAS.map((a) => {
                const n = data.alertas?.[a] ?? 0;
                return (
                  <KpiCard key={a} to={`/flito/tramites?alerta=${a}`}
                    ariaLabel={`${ALERTA_OPERATIVA_LABEL[a]}: ${n} trámites`}
                    label={ALERTA_OPERATIVA_LABEL[a]} value={n} hint={PISTA_ALERTA[a]}
                    chip={n > 0 ? { tone: 'danger', label: 'Requiere atención' } : undefined} />
                );
              })}
            </section>
          )}

          <section className="grid gap-3 md:grid-cols-2">
            {data.soat && <ConteosPorEstado titulo="SOAT por estado" conteos={data.soat} etiquetas={ESTADO_SOAT_LABEL as Record<EstadoSoat, string>} destino="/flito/soat" />}
            {data.impuestos && <ConteosPorEstado titulo="Impuestos por estado" conteos={data.impuestos} etiquetas={ESTADO_IMPUESTO_LABEL as Record<EstadoImpuesto, string>} destino="/flito/impuestos" />}
          </section>
        </>
      )}

    </div>
  );
}
