// Torre de Control (Épica #14590 B2) — Operativa › Inventario por estado (spec UX §6.2, maqueta
// `docs/ux/mockups/torre-operativa-inventario.html`). Matriz estado × días en el estado (tramos fijos del contrato), foto
// de hoy. Cada cifra abre su lista en el detalle (estado + tramo + organismo, los segmentos los arma el API); en 0, «—»
// sin enlace. ▲ + tinta de atención SOLO en las celdas que pasan el umbral de su estado (nunca solo color; sin mapa de
// calor), con la leyenda del API. El organismo se suma al filtro de la Torre. Los totales los calcula el servidor.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { CeldaInventarioTorre, FilaInventarioTorre, InventarioEstadoTorre, TramoAntiguedadTorre } from '@operaciones/shared-types';
import { TRAMOS_ANTIGUEDAD_TORRE } from '@operaciones/shared-types';
import { torreOperativaApi } from '../../lib/api';
import type { FiltrosTorre } from '../../lib/torreFiltros';
import { rutaDestino } from '../../lib/torreDetalle';
import DataTable, { type ColumnaTabla } from '../flit/DataTable';
import FlitSelect from '../flit/FlitSelect';
import GradientButton from '../flit/GradientButton';
import InlineAlert from '../flit/InlineAlert';
import { Vacio } from '../flit/Cargador';
import { BotonComoSeCalcula, DefinicionCalculo, useComoSeCalcula } from './ComoSeCalcula';
import { usePuedeVerDetalle } from './KpiExplicable';
import { aFiltroTorre, conteo } from './formatoTorre';
import { useConsultaTorre } from './useConsultaTorre';

type Tramo = InventarioEstadoTorre['tramos'][number];

/** «0–2 días» → «0 a 2 días»; «Más de 30» → «más de 30 días» (para el `aria-label` de la celda). */
function tramoHablado(t: Tramo | null): string {
  if (!t) return 'total';
  const base = t.etiqueta.replace('–', ' a ');
  const texto = base.charAt(0).toLowerCase() + base.slice(1);
  return /días?$/.test(texto) ? texto : `${texto} días`;
}

function CeldaInventario({ celda, fila, tramo, puedeVer }: {
  celda: CeldaInventarioTorre; fila: string; tramo: Tramo | null; puedeVer: boolean;
}) {
  if (celda.n === 0) {
    return <span className="text-[color:var(--color-text-tertiary)]" data-torre="celda-cero">
      <span aria-hidden="true">—</span><span className="sr-only">sin trámites</span>
    </span>;
  }
  const uno = celda.n === 1;
  const marca = celda.sobreUmbral ? <><span aria-hidden="true">▲ </span></> : null;
  const contenido = <>{marca}{conteo(celda.n)}</>;
  const clase = celda.sobreUmbral ? 'font-semibold text-[color:var(--flit-warning-ink)]' : '';
  const ruta = puedeVer ? rutaDestino(celda.destino, { volver: 'operativa', vista: 'inventario' }) : null;
  const umbral = celda.sobreUmbral ? (uno ? ', pasa el umbral' : ', pasan el umbral') : '';
  const etiqueta = `${fila}, ${tramoHablado(tramo)}: ${conteo(celda.n)} ${uno ? 'trámite' : 'trámites'}${umbral}`;
  if (!ruta) {
    return <span className={clase} data-umbral={celda.sobreUmbral || undefined}>
      <span aria-hidden="true">{contenido}</span><span className="sr-only">{etiqueta}</span>
    </span>;
  }
  return (
    <Link to={ruta} data-torre="celda-inventario" data-umbral={celda.sobreUmbral || undefined}
      aria-label={`${etiqueta}. ${uno ? 'Ver cuál' : 'Ver cuáles'}`}
      className={`flit-focus-inset -mx-1 -my-0.5 block cursor-pointer rounded px-1 py-0.5 tabular-nums no-underline transition-colors hover:bg-[var(--kit-hover)] ${clase || 'text-inherit'}`}>
      {contenido}
    </Link>
  );
}

/** Esqueleto: la rejilla con el número real de columnas (Estado + tramos + Total) y 5 filas. */
function EsqueletoMatriz() {
  const columnas = TRAMOS_ANTIGUEDAD_TORRE.length + 2;
  return (
    <div role="status" aria-busy="true" aria-label="Cargando el inventario por estado" data-torre="inventario-cargando"
      className="grid gap-2" style={{ gridTemplateColumns: `minmax(6rem,2fr) repeat(${columnas - 1}, minmax(0,1fr))` }}>
      {Array.from({ length: 6 * columnas }, (_, i) => <div key={i} className="kit-esqueleto h-5" aria-hidden="true" />)}
    </div>
  );
}

export default function InventarioPorEstado({ filtros }: { filtros: FiltrosTorre }) {
  const puedeVer = usePuedeVerDetalle();
  const disc = useComoSeCalcula();
  const [organismo, setOrganismo] = useState<string | null>(null);
  const filtro = aFiltroTorre(filtros);
  const { estado, reintentar } = useConsultaTorre(JSON.stringify([filtro, organismo]), () => torreOperativaApi.inventario(filtro, organismo));
  // Las opciones del selector se conservan mientras recarga (que el control no desaparezca al cambiar de organismo).
  const [opciones, setOpciones] = useState<InventarioEstadoTorre['organismos']>([]);
  const [definicion, setDefinicion] = useState<string | null>(null);
  const d = estado.tipo === 'listo' ? estado.datos : null;
  if (d && (d.organismos !== opciones || d.definicion !== definicion)) {
    setOpciones(d.organismos);
    setDefinicion(d.definicion);
  }

  const elegidos = organismo && !opciones.some((o) => o.codigo === organismo) ? [{ codigo: organismo, nombre: organismo }, ...opciones] : opciones;
  const vacio = d !== null && d.totales.total.n === 0;

  const columnas: ColumnaTabla<FilaInventarioTorre>[] = d ? [
    { key: 'estado', header: 'Estado', render: (f) => f.etiqueta },
    ...d.tramos.map((t): ColumnaTabla<FilaInventarioTorre> => ({
      key: `t-${t.clave}`, header: t.etiqueta, align: 'right',
      render: (f) => <CeldaInventario celda={f.celdas[t.clave as TramoAntiguedadTorre]} fila={f.etiqueta} tramo={t} puedeVer={puedeVer} />,
    })),
    {
      key: 'total', header: 'Total', align: 'right', className: 'font-semibold',
      render: (f) => <CeldaInventario celda={f.total} fila={f.etiqueta} tramo={null} puedeVer={puedeVer} />,
    },
  ] : [];

  const pie = d ? (
    <tr>
      <th scope="row">Total</th>
      {d.tramos.map((t) => (
        <td key={t.clave} className="text-right">
          <CeldaInventario celda={d.totales.celdas[t.clave as TramoAntiguedadTorre]} fila="Total" tramo={t} puedeVer={puedeVer} />
        </td>
      ))}
      <td className="text-right"><CeldaInventario celda={d.totales.total} fila="Total general" tramo={null} puedeVer={puedeVer} /></td>
    </tr>
  ) : null;

  return (
    <section className="card min-w-0" aria-labelledby="t-inventario" data-torre="inventario"
      data-estado={estado.tipo === 'listo' ? (vacio ? 'vacio' : 'lleno') : estado.tipo} onKeyDown={disc.onKeyDown}>
      <div className="card__cabeza flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 id="t-inventario">Inventario por estado</h2>
          {d && !vacio && <p className="text-sm text-[color:var(--color-text-secondary)]" data-torre="frase">{d.frase}</p>}
        </div>
        <span className="kit-etiqueta" data-tono="neutro">Foto de hoy</span>
      </div>

      <div className="mb-3 flex flex-wrap items-end gap-x-4 gap-y-2">
        <div className="w-full sm:w-64">
          <FlitSelect label="Organismo" value={organismo ?? ''} onChange={(v) => setOrganismo(v || null)}
            opciones={[{ valor: '', etiqueta: 'Todos' }, ...elegidos.map((o) => ({ valor: o.codigo, etiqueta: o.nombre }))]} />
        </div>
        {definicion && <div className="pb-2"><BotonComoSeCalcula {...disc} /></div>}
      </div>
      {definicion && <div className="mb-3"><DefinicionCalculo id={disc.id} abierto={disc.abierto} definicion={definicion} /></div>}

      {estado.tipo === 'cargando' && <EsqueletoMatriz />}
      {estado.tipo === 'error' && (
        <InlineAlert tono="danger" accion={<GradientButton variant="secondary" size="sm" onClick={reintentar}>Reintentar</GradientButton>}>
          No pudimos cargar el inventario por estado. Intente de nuevo.
        </InlineAlert>
      )}
      {d && vacio && (
        <Vacio icono="carpeta" texto={organismo ? 'Este organismo no tiene trámites en curso. Elija «Todos» para ver el resto.' : 'No hay trámites en curso hoy.'}
          accion={organismo ? <GradientButton variant="secondary" size="sm" onClick={() => setOrganismo(null)}>Ver todos los organismos</GradientButton> : undefined} />
      )}
      {d && !vacio && (
        <div className="flex min-w-0 flex-col gap-2">
          <DataTable matriz encabezadoFila ariaLabel="Trámites en curso por estado y días en el estado. Cada número abre su lista."
            caption="Trámites en curso por estado y días en el estado" regionDesplazable="Inventario por estado"
            columnas={columnas} filas={d.filas} getKey={(f) => f.estado ?? '~'} pie={pie} />
          <p className="m-0 text-xs text-[color:var(--color-text-secondary)]" data-torre="leyenda-umbral">{d.leyendaUmbral}</p>
        </div>
      )}
    </section>
  );
}
