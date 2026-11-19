// Torre de Control (Épica #14590, B3) — área Productos (spec UX `flito-torre-areas-b3-b6.md` §B3 sobre el molde
// `flito-torre-detalle-universal.md` §4–§6.1): pestañas SOAT · Impuestos · Derechos en `?vista=` (SOAT por defecto, no
// viaja), hasta 4 KPI explicables por pestaña y sus tablas (`tablas[0]` = la principal; las demás debajo). Cada cifra y
// cada fila abre su lista en el Detalle universal y «Volver a Productos» regresa a la pestaña de origen. UNA petición
// (`POST /flito/torre/tableros/productos`) para las tres pestañas; la primaria exporta el Excel del área.
import type {
  CifrasDerechosTorre, CifrasImpuestosTorre, CifrasSoatTorre, PestanaProductosTorre, TableroProductos,
} from '@operaciones/shared-types';
import { useSearchParams } from 'react-router-dom';
import { ErrorVista, Vacio } from '../../components/flit/Cargador';
import GradientButton from '../../components/flit/GradientButton';
import Pestanas from '../../components/flit/Pestanas';
import PaginaTorre, { REJILLA_KPI, useTorre } from '../../components/torre/PaginaTorre';
import { ExportarTablero, useTablero } from '../../components/torre/MoldeTablero';
import KpiExplicable from '../../components/torre/KpiExplicable';
import TablaArea from '../../components/torre/TablaAreaTorre';
import { conteo } from '../../components/torre/formatoTorre';
import { VISTAS_ORIGEN, type VistaProductosTorre } from '../../lib/torreDetalle';

type VistaProductos = 'soat' | VistaProductosTorre;
const PESTANAS_PRODUCTOS: { id: VistaProductos; etiqueta: string }[] = [
  { id: 'soat', etiqueta: 'SOAT' },
  ...Object.entries(VISTAS_ORIGEN.productos).map(([id, etiqueta]) => ({ id: id as VistaProductosTorre, etiqueta })),
];
const leerVista = (v: string | null): VistaProductos => (PESTANAS_PRODUCTOS.some((p) => p.id === v) ? (v as VistaProductos) : 'soat');
/** La subvista que viaja al detalle: SOAT es la de por defecto (sin `ov`). */
const vistaDetalle = (v: VistaProductos) => (v === 'soat' ? undefined : v);

const vacioSoat = (p: PestanaProductosTorre<CifrasSoatTorre>) => {
  const c = p.cifras;
  return (p.tablas[0]?.total.n ?? 0) === 0 && c.pagadosPeriodo === 0 && c.porVencer === 0 && c.sinGestion === 0 && c.vigenciaNoVerificada === 0;
};
const vacioImpuestos = (p: PestanaProductosTorre<CifrasImpuestosTorre>) => {
  const c = p.cifras;
  return (p.tablas[0]?.total.n ?? 0) === 0 && c.pagadosPeriodo === 0 && c.sinGestion === 0 && c.conDiferencia === 0 && c.direccionPendiente === 0;
};
const vacioDerechos = (p: PestanaProductosTorre<CifrasDerechosTorre>) => {
  const c = p.cifras;
  return c.pagadosPeriodo === 0 && c.sinSoporte === 0 && c.pendientesSinResolver === 0;
};
/** El Excel se apaga solo si las tres pestañas están vacías. */
const esVacio = (d: TableroProductos) => vacioSoat(d.soat) && vacioImpuestos(d.impuestos) && vacioDerechos(d.derechos);

const COPY: Record<VistaProductos, { error: string; vacio: string; nombre: string }> = {
  soat: {
    error: 'No pudimos cargar los SOAT. Intente de nuevo.', nombre: 'SOAT',
    vacio: 'No hay SOAT en gestión ni pagados en el periodo con estos filtros.',
  },
  impuestos: {
    error: 'No pudimos cargar los impuestos. Intente de nuevo.', nombre: 'impuestos',
    vacio: 'No hay impuestos en gestión ni pagados en el periodo con estos filtros.',
  },
  derechos: { error: 'No pudimos cargar los derechos. Intente de nuevo.', nombre: 'derechos', vacio: '' },
};

export default function TorreProductos() {
  const torre = useTorre();
  // La pestaña vive en la URL (`?vista=`): «Atrás» y «Volver a Productos» del detalle regresan a ella (§6.1).
  const [params, setParams] = useSearchParams();
  const vista = leerVista(params.get('vista'));
  const elegir = (id: string) => setParams((q) => {
    const n = new URLSearchParams(q);
    if (id === 'soat') n.delete('vista'); else n.set('vista', id);
    return n;
  });
  const { estado, reintentar } = useTablero<TableroProductos>('productos', torre.filtros);
  return (
    <PaginaTorre torre={torre} titulo="Productos" subtitulo="En qué va cada SOAT, impuesto y derecho, y qué está detenido."
      acciones={<ExportarTablero area="productos" filtros={torre.filtros} estado={estado} esVacio={esVacio} />}>
      <Pestanas etiqueta="Productos" pestanas={PESTANAS_PRODUCTOS} activa={vista} onElegir={elegir} />
      <div role="tabpanel" aria-label={PESTANAS_PRODUCTOS.find((p) => p.id === vista)?.etiqueta} className="flex min-w-0 flex-col gap-4"
        data-torre={`vista-${vista}`}>
        {estado.tipo === 'cargando' && <Esqueleto kpis={vista === 'derechos' ? 3 : 4} tabla={vista !== 'derechos'} />}
        {estado.tipo === 'error' && (
          <section className="card" data-torre="tablero" data-estado="error">
            <ErrorVista texto={COPY[vista].error} onReintentar={reintentar} />
          </section>
        )}
        {estado.tipo === 'listo' && (
          <Contenido d={estado.datos} vista={vista} onLimpiar={torre.restablecer} />
        )}
      </div>
    </PaginaTorre>
  );
}

function Esqueleto({ kpis, tabla }: { kpis: number; tabla: boolean }) {
  return (
    <div className="flex flex-col gap-4" role="status" aria-busy="true" data-torre="tablero" data-estado="cargando">
      <span className="sr-only">Cargando el tablero de productos</span>
      <div className={REJILLA_KPI}>{Array.from({ length: kpis }, (_, i) => <div key={i} className="kit-esqueleto h-[104px]" aria-hidden="true" />)}</div>
      {tabla && <div className="kit-esqueleto h-[260px]" aria-hidden="true" />}
      {tabla && <div className="kit-esqueleto h-[160px]" aria-hidden="true" />}
    </div>
  );
}

function Contenido({ d, vista, onLimpiar }: { d: TableroProductos; vista: VistaProductos; onLimpiar: () => void }) {
  const vacio = vista === 'soat' ? vacioSoat(d.soat) : vista === 'impuestos' ? vacioImpuestos(d.impuestos) : false;
  if (vacio) {
    return (
      <section className="card" data-torre="tablero" data-estado="vacio">
        <Vacio texto={COPY[vista].vacio} detalle="Amplíe el periodo o quite filtros de compañía u organismo."
          accion={<GradientButton variant="secondary" size="sm" onClick={onLimpiar}>Limpiar filtros</GradientButton>} />
      </section>
    );
  }
  const v = vistaDetalle(vista);
  return (
    <div className="flex flex-col gap-4" data-torre="tablero" data-estado="lleno">
      {vista === 'soat' && <KpisSoat p={d.soat} />}
      {vista === 'impuestos' && <KpisImpuestos p={d.impuestos} />}
      {vista === 'derechos' && <KpisDerechos p={d.derechos} />}
      {d[vista].tablas.map((t, i) => (
        <TablaArea key={`${t.conjunto}-${t.dimension}`} t={t} principal={i === 0} dinero={d.dineroVisible} volver="productos" vista={v} />
      ))}
    </div>
  );
}

function KpisSoat({ p }: { p: PestanaProductosTorre<CifrasSoatTorre> }) {
  const c = p.cifras;
  const x = p.explicaciones;
  return (
    <div className={REJILLA_KPI}>
      <KpiExplicable volver="productos" label="SOAT sin soporte fuera de ANS" value={conteo(c.sinGestion)} pendiente={c.sinGestion > 0}
        explicacion={x.sinGestion} cantidad={c.sinGestion} verEtiqueta={`Ver las ${conteo(c.sinGestion)}`} nombreLista="gestiones de SOAT sin soporte" />
      <KpiExplicable volver="productos" label="SOAT por vencer" value={conteo(c.porVencer)} pendiente={c.porVencer > 0}
        explicacion={x.porVencer} cantidad={c.porVencer} />
      <KpiExplicable volver="productos" label="Vigencia sin verificar" value={conteo(c.vigenciaNoVerificada)}
        explicacion={x.vigenciaNoVerificada} cantidad={c.vigenciaNoVerificada} nombreLista="SOAT con la vigencia sin verificar" />
      <KpiExplicable volver="productos" label="SOAT pagados" value={conteo(c.pagadosPeriodo)}
        explicacion={x.pagadosPeriodo} cantidad={c.pagadosPeriodo} />
    </div>
  );
}

function KpisImpuestos({ p }: { p: PestanaProductosTorre<CifrasImpuestosTorre> }) {
  const c = p.cifras;
  const x = p.explicaciones;
  const vista = 'impuestos';
  return (
    <div className={REJILLA_KPI}>
      <KpiExplicable volver="productos" vista={vista} label="Impuestos sin soporte fuera de ANS" value={conteo(c.sinGestion)} pendiente={c.sinGestion > 0}
        explicacion={x.sinGestion} cantidad={c.sinGestion} verEtiqueta={`Ver las ${conteo(c.sinGestion)}`} nombreLista="gestiones de impuesto sin soporte" />
      <KpiExplicable volver="productos" vista={vista} label="Con diferencia de valor" value={conteo(c.conDiferencia)} pendiente={c.conDiferencia > 0}
        explicacion={x.conDiferencia} cantidad={c.conDiferencia} nombreLista="impuestos con diferencia de valor" />
      <KpiExplicable volver="productos" vista={vista} label="Dirección por revisar" value={conteo(c.direccionPendiente)}
        explicacion={x.direccionPendiente} cantidad={c.direccionPendiente} nombreLista="impuestos con la dirección por revisar" />
      <KpiExplicable volver="productos" vista={vista} label="Impuestos pagados" value={conteo(c.pagadosPeriodo)}
        explicacion={x.pagadosPeriodo} cantidad={c.pagadosPeriodo} />
    </div>
  );
}

function KpisDerechos({ p }: { p: PestanaProductosTorre<CifrasDerechosTorre> }) {
  const c = p.cifras;
  const x = p.explicaciones;
  const vista = 'derechos';
  return (
    <div className={REJILLA_KPI}>
      <KpiExplicable volver="productos" vista={vista} label="Derechos pagados" value={conteo(c.pagadosPeriodo)}
        explicacion={x.pagadosPeriodo} cantidad={c.pagadosPeriodo} nombreLista="derechos de tránsito pagados" />
      <KpiExplicable volver="productos" vista={vista} label="Derechos sin soporte" value={conteo(c.sinSoporte)} pendiente={c.sinSoporte > 0}
        explicacion={x.sinSoporte} cantidad={c.sinSoporte} />
      <KpiExplicable volver="productos" vista={vista} label="Pendientes sin resolver" value={conteo(c.pendientesSinResolver)}
        pendiente={c.pendientesSinResolver > 0} explicacion={x.pendientesSinResolver} cantidad={c.pendientesSinResolver}
        nombreLista="recibos pendientes de asociar" />
    </div>
  );
}
