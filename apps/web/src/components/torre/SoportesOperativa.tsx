// Torre de Control (Épica #14590 B2) — Operativa › Soportes (molde de subvista, spec UX §6.1): KPI explicables arriba
// (aprobados del periodo y los que tienen soportes incompletos), una tabla por soporte faltante (SOAT · Impuesto ·
// Derecho) y «Ver los N» por fila al detalle con el segmento `faltante`. Frase, definición y destinos los da el API.
import type { SoportesFaltantesTorre } from '@operaciones/shared-types';
import { torreOperativaApi } from '../../lib/api';
import type { FiltrosTorre } from '../../lib/torreFiltros';
import DataTable, { type ColumnaTabla } from '../flit/DataTable';
import GradientButton from '../flit/GradientButton';
import InlineAlert from '../flit/InlineAlert';
import { Vacio } from '../flit/Cargador';
import KpiExplicable, { EnlaceDestino } from './KpiExplicable';
import { BloqueTorre, REJILLA_KPI } from './PaginaTorre';
import { aFiltroTorre, conteo, porcentaje } from './formatoTorre';
import { useConsultaTorre } from './useConsultaTorre';

type FilaFaltante = SoportesFaltantesTorre['porFaltante'][number];

const fechaCorta = (iso: string) => new Date(`${iso.slice(0, 10)}T12:00:00`).toLocaleDateString('es-CO', { day: 'numeric', month: 'short', year: 'numeric' });

export default function SoportesOperativa({ filtros }: { filtros: FiltrosTorre }) {
  const filtro = aFiltroTorre(filtros);
  const { estado, reintentar } = useConsultaTorre(JSON.stringify(filtro), () => torreOperativaApi.soportes(filtro));

  if (estado.tipo === 'cargando') {
    return (
      <div className="flex flex-col gap-4" data-torre="soportes" data-estado="cargando" role="status" aria-busy="true" aria-label="Cargando los soportes">
        <div className={REJILLA_KPI}>
          {[0, 1].map((i) => <div key={i} className="card flex flex-col gap-2" aria-hidden="true">
            <div className="kit-esqueleto h-3 w-1/2" /><div className="kit-esqueleto h-8 w-1/3" /><div className="kit-esqueleto h-3 w-3/4" />
          </div>)}
        </div>
        <div className="card flex flex-col gap-2" aria-hidden="true">
          {[0, 1, 2, 3].map((i) => <div key={i} className="kit-esqueleto h-5" />)}
        </div>
      </div>
    );
  }
  if (estado.tipo === 'error') {
    return (
      <div data-torre="soportes" data-estado="error">
        <InlineAlert tono="danger" accion={<GradientButton variant="secondary" size="sm" onClick={reintentar}>Reintentar</GradientButton>}>
          No pudimos cargar los soportes de los trámites aprobados. Intente de nuevo.
        </InlineAlert>
      </div>
    );
  }

  const d = estado.datos;
  if (d.aprobados === 0) {
    return (
      <div className="card" data-torre="soportes" data-estado="vacio">
        <Vacio icono="carpeta" texto="No hay trámites aprobados en el periodo."
          detalle="Cambie el periodo en la barra de filtros para revisar los soportes de otros meses." />
      </div>
    );
  }

  const inc = d.incompletos.n;
  const columnas: ColumnaTabla<FilaFaltante>[] = [
    { key: 'soporte', header: 'Soporte que falta', render: (f) => <strong>{f.etiqueta}</strong> },
    { key: 'n', header: 'Trámites sin él', align: 'right', render: (f) => (f.n === 0 ? '—' : conteo(f.n)) },
    { key: 'pct', header: '% de los aprobados', align: 'right', render: (f) => porcentaje((f.n / d.aprobados) * 100) },
    {
      key: 'ver', header: <span className="sr-only">Registros</span>, acciones: true,
      render: (f) => <EnlaceDestino destino={f.destino} cantidad={f.n} nombre={`trámites sin ${f.etiqueta}`} volver="operativa" vista="soportes" />,
    },
  ];

  return (
    <div className="flex flex-col gap-4" data-torre="soportes" data-estado="lleno">
      <div className={REJILLA_KPI}>
        <KpiExplicable volver="operativa" vista="soportes" label="Aprobados del periodo" value={conteo(d.aprobados)} cantidad={0}
          explicacion={undefined}>
          {/* Texto, no enlace: fuera de `metrica__pie`, que el kit subraya. */}
          <p className="m-0 text-xs text-[color:var(--color-text-secondary)]" data-torre="rango">
            Del {fechaCorta(d.rango.desde)} al {fechaCorta(d.rango.hasta)}
          </p>
        </KpiExplicable>
        <KpiExplicable volver="operativa" vista="soportes" label="Con soportes incompletos" value={conteo(inc)} pendiente={inc > 0}
          explicacion={{ frase: d.frase, definicion: d.definicion, destino: d.incompletos.destino }} cantidad={inc}
          verEtiqueta={inc > 0 ? `Ver los ${conteo(inc)} incompletos` : undefined} />
      </div>
      <BloqueTorre idPrueba="bloque-faltantes" titulo="Qué soporte falta"
        subtitulo="Un trámite puede faltar en más de una fila: la suma puede pasar de los incompletos.">
        <DataTable ariaLabel="Trámites aprobados por soporte que falta" columnas={columnas} filas={d.porFaltante}
          getKey={(f) => f.faltante} emptyMessage="Todos los aprobados tienen sus soportes." />
      </BloqueTorre>
    </div>
  );
}
