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
import { Dona, SERIE_KIT } from '../components/flit/Graficos';
import { ErrorVista } from '../components/flit/Cargador';
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


/** Paleta del manual en orden fijo: cada estado toma el siguiente color de la serie. */
const PALETA_DONA = [
  SERIE_KIT.azul, SERIE_KIT.turquesa, SERIE_KIT.amarillo, SERIE_KIT.verde,
  SERIE_KIT.naranja, SERIE_KIT.rojo, SERIE_KIT.gris, SERIE_KIT.tinta,
];
/** Ícono de módulo (mapa flito-*) de cada alerta: dónde vive lo que está en riesgo. */
const ICONO_ALERTA: Record<AlertaOperativa, string> = {
  borrador_5d: 'flito-tramites',
  sin_aprobar_ans: 'flito-tramites',
  soat_sin_gestion: 'flito-soat',
  impuesto_sin_gestion: 'flito-impuestos',
};

function ConteosPorEstado({ titulo, conteos, etiquetas }: {
  titulo: string; conteos: Record<string, number>; etiquetas: Record<string, string>; destino: string;
}) {
  const entradas = Object.entries(conteos);
  const total = entradas.reduce((s, [, n]) => s + n, 0);
  return (
    <FlitCard>
      <div className="card__cabeza">
        <h2 className="text-base font-semibold text-[color:var(--color-action)]">{titulo}</h2>
        <span className="text-xs tabular-nums text-[color:var(--color-text-tertiary)]">{total} en total</span>
      </div>
      <div>
        <Dona
          etiqueta={titulo}
          pie="en total"
          vacio="Sin registros por estado."
          partes={entradas.map(([estado, n], i) => ({
            t: etiquetas[estado] ?? estado, v: n, c: PALETA_DONA[i % PALETA_DONA.length],
          }))}
        />
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

  const kpi = (label: string, value: number, hint: string, tone: ChipTone | null, icono: string) => (
    <KpiCard label={label} value={value} hint={hint} icono={icono} pendiente={Boolean(tone && value > 0)}
      chip={tone && value > 0 ? { tone, label: 'atención' } : undefined} />
  );

  return (
    <div className="space-y-6">
      <PageHeaderCard
        title="Tablero"
        icono="flito-inicio"
        subtitle="Lo que el proceso por Excel y correo no dejaba ver: retenciones, estancamientos y diferencias."
      />

      {error && <ErrorVista texto={error} onReintentar={cargar} />}

      {data && (
        <>
          <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {kpi('Revisiones pendientes', ...porModulo(data.revisionesPendientes), 'warning', 'flito-revisiones')}
            {kpi('Fuera de ANS', ...porModulo(data.estancados), 'warning', 'flito-jornadas')}
            {kpi('Diferencias de valor', data.diferenciasDeValor, 'Pagados cuyo recibo no cuadra con lo liquidado.', 'warning', 'flito-impuestos')}
            {kpi('Habilitados para entrega', data.compuertaHabilitados, 'SOAT e impuestos resueltos. Falta ejecutar.', null, 'flito-compuerta')}
          </section>

          {/* Alertas operativas: cada tarjeta lleva a Gestión Trámites con su filtro ya aplicado,
              para no obligar a rearmar a mano la búsqueda de lo que está en riesgo. */}
          {data.alertas && (
            <section aria-label="Alertas operativas" className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
              {ALERTAS_OPERATIVAS.map((a) => {
                const n = data.alertas?.[a] ?? 0;
                return (
                  <KpiCard key={a} to={`/flito/tramites?alerta=${a}`}
                    ariaLabel={`${ALERTA_OPERATIVA_LABEL[a]}: ${n} trámites`}
                    label={ALERTA_OPERATIVA_LABEL[a]} value={n} hint={PISTA_ALERTA[a]}
                    icono={ICONO_ALERTA[a]} pendiente={n > 0}
                    chip={n > 0 ? { tone: 'danger', label: 'Requiere atención' } : undefined} />
                );
              })}
            </section>
          )}

          <section className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {data.soat && <ConteosPorEstado titulo="SOAT por estado" conteos={data.soat} etiquetas={ESTADO_SOAT_LABEL as Record<EstadoSoat, string>} destino="/flito/soat" />}
            {data.impuestos && <ConteosPorEstado titulo="Impuestos por estado" conteos={data.impuestos} etiquetas={ESTADO_IMPUESTO_LABEL as Record<EstadoImpuesto, string>} destino="/flito/impuestos" />}
          </section>
        </>
      )}

    </div>
  );
}
