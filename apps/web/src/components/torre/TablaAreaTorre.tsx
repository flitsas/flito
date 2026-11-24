// Torre de Control (Épica #14590, B3–B4) — piezas comunes de las áreas por pestañas (Productos, Logística, Facturación):
// la tabla de un conjunto cortado por una dimensión (`TablaAreaTorre` del contrato: estado, motivo, secretaría o
// compañía) con su fila Total, y el desglose de una KPI con sus propios enlaces. Cada fila abre su lista en el Detalle
// universal; «Otros» y las filas en 0 van sin enlace; la columna de valor solo se pinta con permiso de dinero.
import type { ComponenteCifra, FilaTablaProductosTorre, TablaAreaTorre } from '@operaciones/shared-types';
import DataTable, { type ColumnaTabla } from '../flit/DataTable';
import StatusChip, { type ChipTone } from '../flit/StatusChip';
import type { OrigenPantallaTorre } from '../../lib/torreDetalle';
import { BloqueTorre } from './PaginaTorre';
import { notaFiltros } from './MoldeTablero';
import { EnlaceDestino } from './KpiExplicable';
import { conteo, pesos } from './formatoTorre';

const CABECERA_DIMENSION: Record<TablaAreaTorre['dimension'], string> = {
  estado: 'Estado', motivo: 'Motivo', organismo: 'Secretaría', compania: 'Compañía',
};
/** Sustantivo de la columna de conteo y su artículo para «Ver los/las N». */
const SUSTANTIVO: Partial<Record<TablaAreaTorre['conjunto'], { cabecera: string; femenino: boolean }>> = {
  soat_por_estado: { cabecera: 'SOAT', femenino: false },
  soat_incompletas_abiertas: { cabecera: 'Solicitudes', femenino: true },
  impuestos_por_estado: { cabecera: 'Impuestos', femenino: false },
  impuestos_rechazados_periodo: { cabecera: 'Impuestos', femenino: false },
  derechos_pendientes_sin_resolver: { cabecera: 'Recibos', femenino: false },
  traslados_por_estado: { cabecera: 'Traslados', femenino: false },
  actas_devueltas_periodo: { cabecera: 'Actas', femenino: true },
  sin_facturar: { cabecera: 'Trámites sin facturar', femenino: false },
};
const MENSAJE_VACIO: Partial<Record<TablaAreaTorre['conjunto'], string>> = {
  soat_incompletas_abiertas: 'No hay solicitudes incompletas abiertas.',
  impuestos_rechazados_periodo: 'No se rechazó ningún impuesto en el periodo.',
  derechos_pendientes_sin_resolver: 'No hay pagos de derechos pendientes.',
  actas_devueltas_periodo: 'Ninguna acta volvió en el periodo.',
  sin_facturar: 'Todo lo aprobado en el periodo ya está facturado.',
  traslados_por_estado: 'No hay traslados registrados con estos filtros.',
};

/** Tono del estado (pendiente → solicitado/en ruta → con novedad → pagado/recibido). El texto lo trae el API. */
function tonoEstado(clave: string | null): ChipTone {
  const k = (clave ?? '').toLowerCase();
  if (k.includes('pagad') || k.includes('recibid') || k.includes('entregad')) return 'success';
  if (k.includes('novedad') || k.includes('rechaz') || k.includes('devuel') || k.includes('anulad')) return 'warning';
  if (k.includes('solicit') || k.includes('enviad') || k.includes('proceso') || k.includes('ruta')) return 'active';
  return 'neutral';
}

type FilaVista = FilaTablaProductosTorre & { total?: boolean };

export default function TablaArea({ t, principal, dinero, volver, vista }: {
  t: TablaAreaTorre; principal: boolean; dinero: boolean; volver: OrigenPantallaTorre; vista?: string;
}) {
  const s = SUSTANTIVO[t.conjunto] ?? { cabecera: 'Registros', femenino: false };
  // `valor` undefined = la tabla no lleva valor; null = sin permiso de dinero: en ambos casos la columna no se pinta.
  const conValor = t.conValor && dinero && t.total.valor != null;
  const foto = t.filtrosIgnorados.includes('rango');
  const columnas: ColumnaTabla<FilaVista>[] = [
    {
      key: 'etiqueta', header: CABECERA_DIMENSION[t.dimension],
      render: (f) => (f.total ? <strong>Total</strong>
        : t.dimension === 'estado' && f.clave !== '__otros' ? <StatusChip tone={tonoEstado(f.clave)}>{f.etiqueta}</StatusChip> : f.etiqueta),
    },
    { key: 'n', header: s.cabecera, align: 'right', render: (f) => (f.total ? <strong className="tabular-nums">{conteo(f.n)}</strong> : <span className="tabular-nums">{conteo(f.n)}</span>) },
    ...(conValor ? [{
      key: 'valor', header: 'Valor', align: 'right' as const,
      render: (f: FilaVista) => <span className="tabular-nums">{f.valor == null ? '—' : pesos(f.valor)}</span>,
    }] : []),
    {
      key: 'ver', header: <span className="sr-only">Registros</span>, acciones: true,
      render: (f) => (
        <EnlaceDestino destino={f.destino} cantidad={f.n} volver={volver} vista={vista}
          nombre={f.total ? t.titulo : `${t.titulo}: ${f.etiqueta}`} texto={`Ver ${s.femenino ? 'las' : 'los'} ${conteo(f.n)}`} />
      ),
    },
  ];
  const filas: FilaVista[] = t.filas.length ? [...t.filas, { ...t.total, total: true }] : [];
  return (
    <BloqueTorre idPrueba={principal ? 'tabla-principal' : `tabla-${t.conjunto}`} titulo={t.titulo} subtitulo={notaFiltros(t)}
      accion={foto ? <StatusChip tone="neutral">Foto de hoy</StatusChip> : undefined}>
      <DataTable ariaLabel={t.titulo} columnas={columnas} filas={filas} getKey={(f) => (f.total ? '__total' : f.clave ?? '__sin')}
        emptyMessage={MENSAJE_VACIO[t.conjunto] ?? 'Sin registros con estos filtros.'} />
    </BloqueTorre>
  );
}

/**
 * Desglose de una KPI («Más de 6 días: 2», «Reintento vencido: 3»): texto, y enlace a su lista si el API manda destino
 * y hay registros. Va bajo la frase (`pie` de `KpiExplicable`); nunca es un segundo «Ver» de la tarjeta.
 */
export function DesgloseCifra({ partes, volver, vista, nombre }: {
  partes: ComponenteCifra[] | undefined; volver: OrigenPantallaTorre; vista?: string; nombre: string;
}) {
  if (!partes?.length) return null;
  return (
    <ul className="m-0 flex list-none flex-wrap gap-x-3 gap-y-1 p-0 text-xs" aria-label={`Desglose: ${nombre}`} data-torre="desglose">
      {partes.map((p) => (
        <li key={p.etiqueta} className="flex items-center gap-1">
          <span className="text-[color:var(--color-text-secondary)]">{p.etiqueta}: <span className="tabular-nums">{conteo(p.valor)}</span></span>
          {p.destino && <EnlaceDestino destino={p.destino} cantidad={p.valor} volver={volver} vista={vista} nombre={`${nombre}, ${p.etiqueta.toLowerCase()}`} texto="Ver" />}
        </li>
      ))}
    </ul>
  );
}
