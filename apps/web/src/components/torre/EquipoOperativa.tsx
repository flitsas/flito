// Torre de Control (Épica #14590, B5) — Operativa › Equipo (spec UX §B5): cómo está repartido el trabajo, no un
// ranking. Orden alfabético por defecto, sin posiciones, sin semáforo ni tinta de peligro por persona, solo el nombre
// del funcionario (nunca el correo). Cada cifra abre su lista con `s=funcionario:<id>`; en 0, «—» sin enlace.
// Sin Excel en esta subvista (información de desempeño de personas): cada detalle exporta su lista.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { DestinoCifra, FilaEquipoTorre, TableroEquipoTorre } from '@operaciones/shared-types';
import type { FiltrosTorre } from '../../lib/torreFiltros';
import { rutaDestino } from '../../lib/torreDetalle';
import DataTable, { type ColumnaTabla } from '../flit/DataTable';
import FlitSelect from '../flit/FlitSelect';
import StatusChip from '../flit/StatusChip';
import { useTablero } from './MoldeTablero';
import { BloqueTorre, REJILLA_KPI } from './PaginaTorre';
import KpiExplicable, { usePuedeVerDetalle } from './KpiExplicable';
import { EstadosSubvista, FraseGuia } from './SubvistaTorre';
import { conteo } from './formatoTorre';

type Columna = 'gestionesPeriodo' | 'cargaAbierta' | 'fueraAns';
const COLUMNAS: { id: Columna; rotulo: string; nombre: string }[] = [
  { id: 'gestionesPeriodo', rotulo: 'Gestiones del periodo', nombre: 'gestiones del periodo' },
  { id: 'cargaAbierta', rotulo: 'Carga abierta', nombre: 'gestiones abiertas' },
  { id: 'fueraAns', rotulo: 'Pendientes fuera de ANS', nombre: 'pendientes fuera de ANS' },
];
type Orden = 'nombre' | Columna;
const OPCIONES_ORDEN = [
  { valor: 'nombre', etiqueta: 'Nombre (A a Z)' },
  ...COLUMNAS.map((c) => ({ valor: c.id, etiqueta: `${c.rotulo} (mayor primero)` })),
];
const VISTA = 'equipo';

const esVacio = (d: TableroEquipoTorre) => d.porFuncionario.length === 0 && d.cifras.gestionesPeriodo === 0 && d.cifras.cargaAbierta === 0;

/** La cifra de una celda: número con aspecto de enlace (color de acción, semibold) que abre la lista; 0 = «—». */
function CeldaEquipo({ n, destino, nombre, rotulo }: { n: number; destino: DestinoCifra; nombre: string; rotulo: string }) {
  const puedeVer = usePuedeVerDetalle();
  const ruta = puedeVer && n > 0 ? rutaDestino(destino, { volver: 'operativa', vista: VISTA }) : null;
  if (n === 0) {
    return <span className="text-[color:var(--color-text-tertiary)]" data-torre="celda-cero"><span aria-hidden="true">—</span><span className="sr-only">sin {rotulo}</span></span>;
  }
  if (!ruta) return <span className="tabular-nums">{conteo(n)}</span>;
  return (
    <Link to={ruta} data-torre="celda-equipo" aria-label={`${nombre}: ${conteo(n)} ${rotulo}. Ver cuáles`}
      className="flit-focus-inset -mx-1 -my-0.5 inline-block cursor-pointer rounded px-1 py-0.5 font-semibold tabular-nums text-[color:var(--color-action)] no-underline transition-colors hover:bg-[var(--kit-hover)] hover:underline hover:underline-offset-[3px]">
      {conteo(n)}
    </Link>
  );
}

export default function EquipoOperativa({ filtros, onLimpiar }: { filtros: FiltrosTorre; onLimpiar: () => void }) {
  const { estado, reintentar } = useTablero<TableroEquipoTorre>('operativa/equipo', filtros);
  return (
    <EstadosSubvista estado={estado} kpis={3} nombre="la información del equipo"
      error="No pudimos cargar la información del equipo. Intente de nuevo."
      vacio={{ es: esVacio, texto: 'Nadie del equipo registró gestiones en el periodo ni tiene gestiones abiertas.', detalle: 'Amplíe el periodo para ver la actividad anterior.' }}
      onReintentar={reintentar} onLimpiar={onLimpiar}>
      {(d) => <Contenido d={d} />}
    </EstadosSubvista>
  );
}

function Contenido({ d }: { d: TableroEquipoTorre }) {
  const [orden, setOrden] = useState<Orden>('nombre');
  const c = d.cifras;
  const x = d.explicaciones;
  // El API ya manda el orden alfabético; solo se reordena si el usuario lo pide.
  const filas = orden === 'nombre' ? d.porFuncionario : [...d.porFuncionario].sort((a, b) => b[orden] - a[orden] || a.nombre.localeCompare(b.nombre, 'es-CO'));
  const columnas: ColumnaTabla<FilaEquipoTorre>[] = [
    { key: 'nombre', header: 'Funcionario', render: (f) => f.nombre },
    ...COLUMNAS.map((col) => ({
      key: col.id, header: col.rotulo, align: 'right' as const,
      render: (f: FilaEquipoTorre) => <CeldaEquipo n={f[col.id]} destino={f.destinos[col.id]} nombre={f.nombre} rotulo={col.nombre} />,
    })),
  ];
  return (
    <>
      <FraseGuia texto={d.frase} volver="operativa" vista={VISTA} />
      <div className={REJILLA_KPI}>
        <KpiExplicable volver="operativa" vista={VISTA} label="Gestiones del periodo" value={conteo(c.gestionesPeriodo)}
          explicacion={x.gestionesPeriodo} cantidad={c.gestionesPeriodo} verEtiqueta={`Ver las ${conteo(c.gestionesPeriodo)}`} nombreLista="gestiones del periodo" />
        <KpiExplicable volver="operativa" vista={VISTA} label="Carga abierta" value={conteo(c.cargaAbierta)}
          explicacion={x.cargaAbierta} cantidad={c.cargaAbierta} verEtiqueta={`Ver las ${conteo(c.cargaAbierta)}`} nombreLista="gestiones abiertas del equipo" />
        <KpiExplicable volver="operativa" vista={VISTA} label="Pendientes fuera de ANS" value={conteo(c.fueraAns)}
          explicacion={x.fueraAns} cantidad={c.fueraAns} verEtiqueta={`Ver las ${conteo(c.fueraAns)}`} nombreLista="pendientes fuera de ANS" />
      </div>
      <BloqueTorre idPrueba="tabla-equipo" titulo="Por funcionario"
        subtitulo="Cómo está repartido el trabajo. Un número alto no es una falta: puede ser quien tiene más carga asignada."
        accion={(
          <div className="flex flex-wrap items-end gap-2">
            <StatusChip tone="neutral">Carga: foto de hoy</StatusChip>
            <div className="w-60 max-w-full">
              <FlitSelect label="Ordenar por" value={orden} opciones={OPCIONES_ORDEN} onChange={(v) => setOrden(v as Orden)} />
            </div>
          </div>
        )}>
        <DataTable ariaLabel="Por funcionario" columnas={columnas} filas={filas} getKey={(f) => f.funcionarioId}
          emptyMessage="Nadie del equipo tiene gestiones en el periodo ni abiertas." />
      </BloqueTorre>
    </>
  );
}
