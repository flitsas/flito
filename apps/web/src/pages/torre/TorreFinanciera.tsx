// Torre de Control (Épica #14590) — tablero Financiero (spec UX §7.3), con el molde de Comercial. Sin la función
// de dinero la API manda los valores en `null` (`dineroVisible: false`): se muestran como «—» y el margen se calla.
import { SERVICIOS_MARGEN_TORRE, type ServicioMargenTorre, type TableroFinanciero } from '@operaciones/shared-types';
import DataTable, { type ColumnaTabla } from '../../components/flit/DataTable';
import InlineAlert from '../../components/flit/InlineAlert';
import { BarrasGrupo, Dona, SERIE_KIT } from '../../components/flit/Graficos';
import PaginaTorre, { BloqueTorre, REJILLA_2, REJILLA_KPI, useTorre } from '../../components/torre/PaginaTorre';
import MoldeTablero, { ExportarTablero, Semaforo, notaFiltros, useTablero } from '../../components/torre/MoldeTablero';
import { conteo, pesos, pesosCorto, porcentaje } from '../../components/torre/formatoTorre';
import KpiExplicable, { EnlaceDestino } from '../../components/torre/KpiExplicable';

type FilaBolsa = TableroFinanciero['bolsas']['filas'][number];
type FilaSinFacturar = TableroFinanciero['sinFacturar']['filas'][number];

const NIVELES = [['completos', '3 de 3'], ['dos', '2 de 3'], ['uno', '1 de 3'], ['cero', '0 de 3']] as const;
const SERVICIO: Record<ServicioMargenTorre, string> = { tramite: 'Trámite', soat: 'SOAT', impuestos: 'Impuestos', derechos: 'Derechos', logistica: 'Logística' };
const dinero = (n: number | null) => (n === null ? '—' : pesos(n));
// Saldo ≤ 0 llega como 0 días (RN-TOR-FI1): se dice «Agotada», nunca «0 días» ni días negativos.
const dias = (n: number) => (n <= 0 ? 'Agotada' : `${n.toLocaleString('es-CO', { maximumFractionDigits: 1 })} ${n === 1 ? 'día' : 'días'}`);

const esVacio = (d: TableroFinanciero): boolean => d.bolsas.filas.length === 0 && d.sinFacturar.filas.length === 0 && d.conciliacion.total === 0 && (d.margen === null || d.margen.porServicio.every((s) => s.cobrado === 0));

export default function TorreFinanciera() {
  const torre = useTorre();
  const { estado, reintentar } = useTablero<TableroFinanciero>('financiera', torre.filtros);
  return (
    <PaginaTorre torre={torre} titulo="Financiera" subtitulo="Cuánto dura el saldo de cada bolsa, qué falta por facturar y cuánto deja cada servicio."
      acciones={<ExportarTablero area="financiera" filtros={torre.filtros} estado={estado} esVacio={esVacio} />}>
      <MoldeTablero estado={estado} nombre="Financiero" onReintentar={reintentar} onLimpiar={torre.restablecer}
        esVacio={esVacio}>
        {(d) => <Contenido d={d} />}
      </MoldeTablero>
    </PaginaTorre>
  );
}

function Contenido({ d }: { d: TableroFinanciero }) {
  const c = d.cifras;
  const x = d.explicaciones ?? {};

  const columnasBolsa: ColumnaTabla<FilaBolsa>[] = [
    { key: 'compania', header: 'Compañía', render: (f) => <strong>{f.compania}</strong> },
    { key: 'saldo', header: 'Saldo', align: 'right', render: (f) => dinero(f.saldo) },
    { key: 'consumo', header: 'Consumo diario (30 días)', align: 'right', render: (f) => dinero(f.consumoDiario) },
    { key: 'dias', header: 'Días de cobertura', align: 'right', render: (f) => (f.diasCobertura === null ? 'Sin consumo' : f.diasCobertura <= 0 ? 'Agotada' : conteo(f.diasCobertura)) },
    { key: 'estado', header: 'Estado', render: (f) => <Semaforo severidad={f.severidad} /> },
  ];
  const columnasSinFacturar: ColumnaTabla<FilaSinFacturar>[] = [
    { key: 'compania', header: 'Compañía', render: (f) => <strong>{f.compania}</strong> },
    { key: 'tramites', header: 'Trámites', align: 'right', render: (f) => conteo(f.tramites) },
    { key: 'valor', header: 'Valor estimado', align: 'right', render: (f) => dinero(f.valorEstimado) },
    { key: 'antiguo', header: 'Más antiguo (días)', align: 'right', render: (f) => conteo(f.masAntiguoDias) },
    // Antes «Ver en reporte de costos» abría esa pantalla sin filtrar (el defecto de AC13): ahora abre su conjunto.
    {
      key: 'acciones', header: <span className="sr-only">Registros</span>, acciones: true,
      render: (f: FilaSinFacturar) => <EnlaceDestino destino={f.destino} cantidad={f.tramites} nombre={`trabajo sin facturar de ${f.compania}`} volver="financiera" />,
    },
  ];

  const margen = d.margen;
  const sinCosto = margen?.porServicio.some((s) => s.sinCostoRegistrado) ?? false;
  const con = d.conciliacion;

  return (
    <>
      <div className={REJILLA_KPI}>
        <KpiExplicable volver="financiera" label="Bolsa con menor cobertura" value={c.menorCobertura ? dias(c.menorCobertura.dias) : '—'}
          explicacion={x.menorCobertura} hintSinExplicacion={c.menorCobertura?.compania} nombreLista="bolsas en riesgo"
          pendiente={c.menorCobertura ? c.menorCobertura.severidad !== 'ok' : false}>
          {c.menorCobertura && c.menorCobertura.severidad !== 'ok' && <Semaforo severidad={c.menorCobertura.severidad} />}
        </KpiExplicable>
        <KpiExplicable volver="financiera" label="Trabajo sin facturar" value={c.sinFacturarValor === null ? conteo(c.sinFacturarTramites) : pesosCorto(c.sinFacturarValor)}
          explicacion={x.sinFacturarTramites} cantidad={c.sinFacturarTramites} nombreLista="trámites aprobados sin factura"
          hintSinExplicacion={`${conteo(c.sinFacturarTramites)} trámites`} pendiente={c.sinFacturarTramites > 0} />
        <KpiExplicable volver="financiera" label="Margen bruto del periodo" value={c.margenPct === null ? '—' : porcentaje(c.margenPct)}
          explicacion={x.margenPct} cantidad={c.margenPct === null ? 0 : null} verEtiqueta="Ver los aprobados" />
        <KpiExplicable volver="financiera" label="Soportes completos 3/3" value={c.soportesCompletosPct === null ? '—' : porcentaje(c.soportesCompletosPct)}
          explicacion={x.soportesCompletosPct} cantidad={d.conciliacion.dos + d.conciliacion.uno + d.conciliacion.cero}
          verEtiqueta={`Ver los ${conteo(d.conciliacion.dos + d.conciliacion.uno + d.conciliacion.cero)} incompletos`} />
      </div>

      {!d.dineroVisible && (
        <InlineAlert tono="info">Su rol no ve los valores en pesos de la Torre; las cifras de dinero aparecen con «—».</InlineAlert>
      )}

      <div className={REJILLA_2}>
        <BloqueTorre idPrueba="bloque-bolsas" ancho titulo="Cobertura de bolsas"
          subtitulo={notaFiltros(d.bolsas, `Saldo de hoy y consumo de los últimos 30 días. Atención bajo ${d.bolsas.umbralAtencionDias} días; crítico bajo ${d.bolsas.umbralCriticoDias}.`)}>
          {d.bolsas.filas.length === 0
            ? <p className="grafico-vacio">Todas las bolsas cubren más de {d.bolsas.umbralAtencionDias} días.</p>
            : <DataTable ariaLabel="Cobertura de bolsas" columnas={columnasBolsa} filas={d.bolsas.filas} getKey={(f) => String(f.companiaId)} />}
        </BloqueTorre>

        <BloqueTorre idPrueba="bloque-sin-facturar" titulo="Trabajo terminado sin facturar" subtitulo={notaFiltros(d.sinFacturar, 'Trámites aprobados que aún no tienen factura.')}>
          {d.sinFacturar.filas.length === 0
            ? <p className="grafico-vacio">No hay trabajo terminado pendiente de facturar.</p>
            : <DataTable ariaLabel="Trabajo terminado sin facturar" columnas={columnasSinFacturar} filas={d.sinFacturar.filas}
              getKey={(f) => String(f.companiaId ?? f.compania)} />}
        </BloqueTorre>

        {margen && (
          <BloqueTorre idPrueba="bloque-margen" titulo="Margen por servicio" subtitulo={notaFiltros(margen, 'Lo cobrado frente a lo que costó. El margen por cliente va en el Excel.')}>
            <BarrasGrupo fluido titulo="Cobrado y costo por servicio"
              etiquetas={SERVICIOS_MARGEN_TORRE.map((s) => SERVICIO[s])}
              series={[
                { t: 'Cobrado', c: SERIE_KIT.azul, v: SERVICIOS_MARGEN_TORRE.map((s) => margen.porServicio.find((x) => x.servicio === s)?.cobrado ?? 0) },
                { t: 'Costo', c: SERIE_KIT.gris, v: SERVICIOS_MARGEN_TORRE.map((s) => margen.porServicio.find((x) => x.servicio === s)?.costo ?? 0) },
              ]} />
            {sinCosto && <p className="mt-2 text-sm" style={{ color: 'var(--color-text-tertiary)' }}>Algún servicio no tiene costo registrado en FLITO: su barra de costo sale en cero.</p>}
          </BloqueTorre>
        )}

        <BloqueTorre idPrueba="bloque-conciliacion" titulo="Conciliación documental 3/3" subtitulo={notaFiltros(con, 'Trámites con sus tres soportes (SOAT, impuesto y derecho).')}>
          <Dona etiqueta="Conciliación documental" pie="trámites" vacio="Sin trámites con soportes en el periodo."
            partes={[
              { t: '3/3', v: con.completos, c: SERIE_KIT.verde },
              { t: '2/3', v: con.dos, c: SERIE_KIT.amarillo },
              { t: '1/3', v: con.uno, c: SERIE_KIT.naranja },
              { t: '0/3', v: con.cero, c: SERIE_KIT.gris },
            ]} />
          {con.destinos && (
            <ul className="m-0 mt-3 flex list-none flex-wrap gap-x-3 gap-y-1 p-0" aria-label="Registros por nivel de soportes" data-torre="niveles-soportes">
              {NIVELES.map(([k, t]) => (con[k] > 0 && (
                <li key={k}><EnlaceDestino destino={con.destinos![k]} cantidad={con[k]} nombre={`${t}: ${conteo(con[k])} trámites`} volver="financiera" texto={`${t}: ver ${conteo(con[k])}`} /></li>
              )))}
            </ul>
          )}
        </BloqueTorre>
      </div>
    </>
  );
}
