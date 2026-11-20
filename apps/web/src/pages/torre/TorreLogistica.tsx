// Torre de Control (Épica #14590, B4) — área Logística (spec UX `flito-torre-areas-b3-b6.md` §B4.1–B4.2, molde de
// Productos): pestañas Traslados · Entregas en `?vista=` (Traslados por defecto, no viaja). UNA petición
// (`POST /flito/torre/tableros/logistica`) para las dos; cada cifra, desglose y fila abre su lista en el Detalle y
// «Volver a Logística» regresa a la pestaña. Ley 1581: aquí no hay mensajero, receptor ni dirección: solo conteos.
import type { CifrasEntregasTorre, ExplicacionesTablero, TableroLogistica } from '@operaciones/shared-types';
import { useSearchParams } from 'react-router-dom';
import Pestanas from '../../components/flit/Pestanas';
import PaginaTorre, { REJILLA_KPI, useTorre } from '../../components/torre/PaginaTorre';
import { ExportarTablero, useTablero } from '../../components/torre/MoldeTablero';
import KpiExplicable from '../../components/torre/KpiExplicable';
import TablaArea, { DesgloseCifra } from '../../components/torre/TablaAreaTorre';
import { EstadosSubvista, FraseGuia } from '../../components/torre/SubvistaTorre';
import { conteo, porcentaje } from '../../components/torre/formatoTorre';
import { VISTAS_ORIGEN, type VistaLogisticaTorre } from '../../lib/torreDetalle';

type VistaLogistica = 'traslados' | VistaLogisticaTorre;
const PESTANAS: { id: VistaLogistica; etiqueta: string }[] = [
  { id: 'traslados', etiqueta: 'Traslados' },
  ...Object.entries(VISTAS_ORIGEN.logistica).map(([id, etiqueta]) => ({ id: id as VistaLogisticaTorre, etiqueta })),
];
const leerVista = (v: string | null): VistaLogistica => (PESTANAS.some((p) => p.id === v) ? (v as VistaLogistica) : 'traslados');

const vacioTraslados = (d: TableroLogistica) => d.traslados.cifras.abiertos === 0 && (d.traslados.tablas[0]?.total.n ?? 0) === 0;
const vacioEntregas = (d: TableroLogistica) => {
  const c = d.entregas.cifras;
  return c.entregasPeriodo === 0 && c.pendientesEntrega === 0 && c.devueltasPeriodo === 0 && c.viajesAdicionales === 0;
};
const esVacio = (d: TableroLogistica) => vacioTraslados(d) && vacioEntregas(d);
const plural = (n: number, uno: string, varios: string) => `${conteo(n)} ${n === 1 ? uno : varios}`;

export default function TorreLogistica() {
  const torre = useTorre();
  const [params, setParams] = useSearchParams();
  const vista = leerVista(params.get('vista'));
  const elegir = (id: string) => setParams((q) => {
    const n = new URLSearchParams(q);
    if (id === 'traslados') n.delete('vista'); else n.set('vista', id);
    return n;
  });
  const { estado, reintentar } = useTablero<TableroLogistica>('logistica', torre.filtros);
  const traslados = vista === 'traslados';
  return (
    <PaginaTorre torre={torre} titulo="Logística" subtitulo="Qué documentos se están moviendo y qué entregas están pendientes o volvieron."
      acciones={<ExportarTablero area="logistica" filtros={torre.filtros} estado={estado} esVacio={esVacio} />}>
      <Pestanas etiqueta="Logística" pestanas={PESTANAS} activa={vista} onElegir={elegir} />
      <div role="tabpanel" aria-label={PESTANAS.find((p) => p.id === vista)?.etiqueta} className="flex min-w-0 flex-col gap-4" data-torre={`vista-${vista}`}>
        <EstadosSubvista estado={estado} kpis={traslados ? 2 : 4} nombre={traslados ? 'los traslados' : 'las entregas'}
          error={traslados ? 'No pudimos cargar los traslados. Intente de nuevo.' : 'No pudimos cargar las entregas. Intente de nuevo.'}
          vacio={traslados
            ? { es: vacioTraslados, texto: 'No hay traslados registrados con estos filtros.', detalle: 'Quite filtros de compañía para ver el resto.' }
            : { es: vacioEntregas, texto: 'No hay entregas ni actas en el periodo con estos filtros.', detalle: 'Amplíe el periodo o quite filtros.' }}
          onReintentar={reintentar} onLimpiar={torre.restablecer}>
          {(d) => (traslados ? <Traslados d={d} /> : <Entregas d={d} />)}
        </EstadosSubvista>
      </div>
    </PaginaTorre>
  );
}

function Traslados({ d }: { d: TableroLogistica }) {
  const p = d.traslados;
  const c = p.cifras;
  const x = p.explicaciones;
  return (
    <>
      <FraseGuia volver="logistica"
        texto={`${plural(c.abiertos, 'traslado abierto', 'traslados abiertos')} hoy; ${conteo(c.abiertosMasDeN)} ${c.abiertosMasDeN === 1 ? 'lleva' : 'llevan'} más de ${p.umbralDias} días.`} />
      <div className={REJILLA_KPI}>
        <KpiExplicable volver="logistica" label="Traslados abiertos" value={conteo(c.abiertos)} explicacion={x.abiertos} cantidad={c.abiertos}
          pie={<DesgloseCifra partes={x.abiertos?.desglose} volver="logistica" nombre="traslados abiertos por ruta" />} />
        <KpiExplicable volver="logistica" label={`Abiertos hace más de ${p.umbralDias} días`} value={conteo(c.abiertosMasDeN)}
          pendiente={c.abiertosMasDeN > 0} explicacion={x.abiertosMasDeN} cantidad={c.abiertosMasDeN} nombreLista="traslados abiertos hace demasiado"
          pie={<DesgloseCifra partes={x.abiertosMasDeN?.desglose} volver="logistica" nombre="traslados abiertos hace demasiado" />} />
      </div>
      {p.tablas.map((t, i) => <TablaArea key={`${t.conjunto}-${t.dimension}`} t={t} principal={i === 0} dinero={d.dineroVisible} volver="logistica" />)}
    </>
  );
}

/** E2: la cifra es el %; «Ver» abre las que necesitaron otro viaje (el desglose del API), no las de primer intento. */
function explicacionReintento(x: ExplicacionesTablero<CifrasEntregasTorre>) {
  const e = x.primerIntento;
  const conViaje = e?.desglose?.find((p) => p.destino);
  return e && conViaje?.destino ? { ...e, destino: conViaje.destino } : e;
}

function Entregas({ d }: { d: TableroLogistica }) {
  const p = d.entregas;
  const c = p.cifras;
  const x = p.explicaciones;
  const vista = 'entregas';
  const conViajes = Math.max(0, c.entregasPeriodo - c.primerIntento);
  return (
    <>
      <FraseGuia volver="logistica" vista={vista}
        texto={`${plural(c.entregasPeriodo, 'entrega', 'entregas')} en el periodo; ${plural(c.pendientesEntrega, 'acta sigue pendiente', 'actas siguen pendientes')} de entrega hoy.`} />
      <div className={REJILLA_KPI}>
        <KpiExplicable volver="logistica" vista={vista} label="Actas pendientes de entrega" value={conteo(c.pendientesEntrega)}
          pendiente={c.pendientesEntrega > 0} explicacion={x.pendientesEntrega} cantidad={c.pendientesEntrega}
          verEtiqueta={`Ver las ${conteo(c.pendientesEntrega)}`} nombreLista="actas pendientes de entrega" />
        <KpiExplicable volver="logistica" vista={vista} label="Entregas al primer intento"
          value={c.primerIntentoPct === null ? '—' : porcentaje(c.primerIntentoPct)} explicacion={explicacionReintento(x)}
          cantidad={conViajes} verEtiqueta={`Ver las ${conteo(conViajes)} con reintento`} />
        <KpiExplicable volver="logistica" vista={vista} label="Actas devueltas" value={conteo(c.devueltasPeriodo)}
          pendiente={c.devueltasPeriodo > 0} explicacion={x.devueltasPeriodo} cantidad={c.devueltasPeriodo}
          verEtiqueta={`Ver las ${conteo(c.devueltasPeriodo)}`} nombreLista="actas devueltas" />
        <KpiExplicable volver="logistica" vista={vista} label="Viajes adicionales" value={conteo(c.viajesAdicionales)}
          explicacion={x.viajesAdicionales} cantidad={c.viajesAdicionales} />
      </div>
      {p.tablas.map((t, i) => <TablaArea key={`${t.conjunto}-${t.dimension}`} t={t} principal={i === 0} dinero={d.dineroVisible} volver="logistica" vista={vista} />)}
    </>
  );
}
