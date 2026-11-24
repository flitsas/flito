// Torre de Control (Épica #14590, B4) — Financiera › Facturación y Financiera › Bolsas (spec UX §B4.3–B4.4). Cada una
// es su propia petición (`/tableros/financiera/facturacion` y `/bolsas`) y su propio Excel. Sin cartera: FLITO no
// registra el pago de las facturas de Siigo. Los errores de Siigo llegan ya traducidos en las frases del API.
import type { TableroBolsas, TableroFacturacion } from '@operaciones/shared-types';
import DataTable, { type ColumnaTabla } from '../flit/DataTable';
import InlineAlert from '../flit/InlineAlert';
import StatusChip from '../flit/StatusChip';
import type { EstadoTablero } from './MoldeTablero';
import { Semaforo, notaFiltros } from './MoldeTablero';
import { BloqueTorre, REJILLA_KPI } from './PaginaTorre';
import KpiExplicable, { EnlaceDestino } from './KpiExplicable';
import TablaArea, { DesgloseCifra } from './TablaAreaTorre';
import { EstadosSubvista, FraseGuia } from './SubvistaTorre';
import { conteo, pesos, pesosCorto } from './formatoTorre';

type Fila = TableroBolsas['cobertura']['filas'][number];
const dinero = (n: number | null) => (n === null ? '—' : pesos(n));
const SIN_DINERO = 'Su rol no ve los valores en pesos de la Torre; las cifras de dinero no se muestran.';

const vacioFacturacion = (d: TableroFacturacion) => {
  const c = d.cifras;
  return c.sinFacturar === 0 && c.facturadasPeriodo === 0 && c.conError === 0 && c.rechazadasDian === 0 && c.colaAtascada === 0;
};
const vacioBolsas = (d: TableroBolsas) => d.cifras.activas === 0;
export const esVacioFacturacion = vacioFacturacion;
export const esVacioBolsas = (d: TableroBolsas) => vacioBolsas(d) && d.cifras.boletasSinConciliar === 0 && d.cifras.boletasConDiferencia === 0;

export function Facturacion({ estado, onReintentar, onLimpiar }: {
  estado: EstadoTablero<TableroFacturacion>; onReintentar: () => void; onLimpiar: () => void;
}) {
  return (
    <EstadosSubvista estado={estado} kpis={4} nombre="la facturación" error="No pudimos cargar la facturación. Intente de nuevo."
      vacio={{ es: vacioFacturacion, texto: 'No hay trámites aprobados ni facturas en el periodo con estos filtros.', detalle: 'Amplíe el periodo o quite filtros.' }}
      onReintentar={onReintentar} onLimpiar={onLimpiar}>
      {(d) => <ContenidoFacturacion d={d} />}
    </EstadosSubvista>
  );
}

function ContenidoFacturacion({ d }: { d: TableroFacturacion }) {
  const c = d.cifras;
  const x = d.explicaciones;
  const vista = 'facturacion';
  return (
    <>
      {x.facturadasPeriodo && (
        <FraseGuia texto={x.facturadasPeriodo.frase} destino={x.facturadasPeriodo.destino} cantidad={c.facturadasPeriodo}
          volver="financiera" vista={vista} nombre="facturas emitidas en el periodo" femenino />
      )}
      {!d.dineroVisible && <InlineAlert tono="info">{SIN_DINERO}</InlineAlert>}
      <div className={REJILLA_KPI}>
        <KpiExplicable volver="financiera" vista={vista} label="Trabajo sin facturar"
          value={c.sinFacturarValor === null ? conteo(c.sinFacturar) : pesosCorto(c.sinFacturarValor)} pendiente={c.sinFacturar > 0}
          explicacion={x.sinFacturar} cantidad={c.sinFacturar} nombreLista="trámites aprobados sin factura" />
        <KpiExplicable volver="financiera" vista={vista} label="Facturas con error" value={conteo(c.conError)} pendiente={c.conError > 0}
          explicacion={x.conError} cantidad={c.conError} verEtiqueta={`Ver las ${conteo(c.conError)}`} nombreLista="facturas con error" />
        <KpiExplicable volver="financiera" vista={vista} label="Rechazadas por la DIAN" value={conteo(c.rechazadasDian)} pendiente={c.rechazadasDian > 0}
          explicacion={x.rechazadasDian} cantidad={c.rechazadasDian} verEtiqueta={`Ver las ${conteo(c.rechazadasDian)}`} nombreLista="facturas rechazadas por la DIAN" />
        <KpiExplicable volver="financiera" vista={vista} label="Cola de facturación detenida" value={conteo(c.colaAtascada)} pendiente={c.colaAtascada > 0}
          explicacion={x.colaAtascada} cantidad={c.colaAtascada} nombreLista="trámites detenidos en la cola de facturación"
          pie={<DesgloseCifra partes={x.colaAtascada?.desglose} volver="financiera" vista={vista} nombre="cola de facturación detenida" />} />
      </div>
      {d.tablas.map((t, i) => <TablaArea key={`${t.conjunto}-${t.dimension}`} t={t} principal={i === 0} dinero={d.dineroVisible} volver="financiera" vista={vista} />)}
    </>
  );
}

export function Bolsas({ estado, onReintentar, onLimpiar }: {
  estado: EstadoTablero<TableroBolsas>; onReintentar: () => void; onLimpiar: () => void;
}) {
  return (
    <EstadosSubvista estado={estado} kpis={3} bloques={2} nombre="las bolsas" error="No pudimos cargar las bolsas. Intente de nuevo."
      vacio={{ es: vacioBolsas, texto: 'No hay bolsas activas con estos filtros.', detalle: 'Si la compañía usa bolsa, revise que esté activa en Bolsas únicas.' }}
      onReintentar={onReintentar} onLimpiar={onLimpiar} alVacio={(d) => <Boletas d={d} />}>
      {(d) => <ContenidoBolsas d={d} />}
    </EstadosSubvista>
  );
}

const TEXTO_SEVERIDAD = { critico: 'Crítico', atencion: 'Atención', ok: 'Al día' } as const;

function ContenidoBolsas({ d }: { d: TableroBolsas }) {
  const c = d.cifras;
  const x = d.explicaciones;
  const vista = 'bolsas';
  const conMovimientos = d.cobertura.filas.some((f) => f.destino.tipo === 'conjunto');
  const columnas: ColumnaTabla<Fila>[] = [
    { key: 'compania', header: 'Compañía', render: (f) => <strong>{f.compania}</strong> },
    ...(d.dineroVisible ? [
      { key: 'saldo', header: 'Saldo', align: 'right' as const, render: (f: Fila) => <span className="tabular-nums">{dinero(f.saldo)}</span> },
      { key: 'consumo', header: 'Consumo diario (30 días)', align: 'right' as const, render: (f: Fila) => <span className="tabular-nums">{dinero(f.consumoDiario)}</span> },
    ] : []),
    {
      key: 'dias', header: 'Días de cobertura', align: 'right',
      render: (f) => <span className="tabular-nums">{f.diasCobertura === null ? 'Sin consumo' : f.diasCobertura <= 0 ? 'Agotada' : conteo(f.diasCobertura)}</span>,
    },
    { key: 'severidad', header: 'Semáforo', render: (f) => <Semaforo severidad={f.severidad}>{TEXTO_SEVERIDAD[f.severidad]}</Semaforo> },
    ...(conMovimientos ? [{
      key: 'ver', header: <span className="sr-only">Movimientos</span>, acciones: true,
      render: (f: Fila) => (
        <EnlaceDestino destino={f.destino} cantidad={f.movimientos} volver="financiera" vista={vista}
          nombre={`movimientos de la bolsa de ${f.compania}`} texto={`Ver los ${conteo(f.movimientos)} movimientos`} />
      ),
    }] : []),
  ];
  return (
    <>
      <FraseGuia volver="financiera" vista={vista}
        texto={`${conteo(c.enCritico)} ${c.enCritico === 1 ? 'bolsa' : 'bolsas'} en crítico y ${conteo(c.enAtencion)} en atención, de ${conteo(c.activas)} ${c.activas === 1 ? 'activa' : 'activas'}.`} />
      {!d.dineroVisible && <InlineAlert tono="info">{SIN_DINERO}</InlineAlert>}
      <div className={REJILLA_KPI}>
        <KpiExplicable volver="financiera" vista={vista} label="Bolsas en crítico" value={conteo(c.enCritico)} pendiente={c.enCritico > 0}
          explicacion={x.enCritico} cantidad={c.enCritico} verEtiqueta={`Ver las ${conteo(c.enCritico)}`} nombreLista="bolsas en crítico"
          pie={<DesgloseCifra partes={x.enCritico?.desglose} volver="financiera" vista={vista} nombre="bolsas" />} />
        <KpiExplicable volver="financiera" vista={vista} label="Bolsas agotadas" value={conteo(c.agotadas)} pendiente={c.agotadas > 0}
          explicacion={x.agotadas} cantidad={c.agotadas} verEtiqueta={`Ver ${c.agotadas === 1 ? 'la' : 'las'} ${conteo(c.agotadas)}`} nombreLista="bolsas agotadas" />
        <KpiExplicable volver="financiera" vista={vista} label="Movimientos del periodo" value={conteo(c.movimientosPeriodo)}
          explicacion={x.movimientosPeriodo} cantidad={c.movimientosPeriodo} nombreLista="movimientos de bolsa del periodo"
          pie={<DesgloseCifra partes={x.movimientosPeriodo?.desglose} volver="financiera" vista={vista} nombre="movimientos" />} />
      </div>
      <BloqueTorre idPrueba="tabla-principal" titulo="Cobertura por bolsa"
        accion={d.cobertura.filtrosIgnorados.includes('rango') ? <StatusChip tone="neutral">Foto de hoy</StatusChip> : undefined}
        subtitulo={notaFiltros(d.cobertura, `Saldo de hoy y consumo de los últimos 30 días. Atención bajo ${d.cobertura.umbralAtencionDias} días; crítico bajo ${d.cobertura.umbralCriticoDias}.`)}>
        <DataTable ariaLabel="Cobertura por bolsa" columnas={columnas} filas={d.cobertura.filas} getKey={(f) => f.bolsaId}
          emptyMessage="No hay bolsas activas con estos filtros." />
      </BloqueTorre>
      <Boletas d={d} />
    </>
  );
}

/** Conciliación de boletas (pagos al organismo): dos filas con su frase y su enlace; en 0, una línea. */
function Boletas({ d }: { d: TableroBolsas }) {
  const c = d.cifras;
  const x = d.explicaciones;
  const filas = [
    { id: 'sin', etiqueta: 'Sin conciliar', n: c.boletasSinConciliar, e: x.boletasSinConciliar },
    { id: 'dif', etiqueta: 'Con diferencia', n: c.boletasConDiferencia, e: x.boletasConDiferencia },
  ];
  return (
    <BloqueTorre idPrueba="bloque-boletas" titulo="Conciliación de boletas" subtitulo="Pagos al organismo que aún no cuadran con sus trámites.">
      {filas.every((f) => f.n === 0)
        ? <p className="grafico-vacio">Todas las boletas están conciliadas y cuadran.</p>
        : (
          <ul className="m-0 flex list-none flex-col gap-0 p-0" aria-label="Conciliación de boletas">
            {filas.map((f) => (
              <li key={f.id} className="flex flex-col gap-2 border-b border-[color:var(--color-border)] py-3 last:border-b-0 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <strong className="block">{f.etiqueta}</strong>
                  <span className="text-sm text-[color:var(--color-text-secondary)]">{f.e?.frase ?? conteo(f.n)}</span>
                </div>
                <EnlaceDestino destino={f.e?.destino} cantidad={f.n} volver="financiera" vista="bolsas"
                  nombre={`boletas ${f.etiqueta.toLowerCase()}`} texto={`Ver las ${conteo(f.n)}`} />
              </li>
            ))}
          </ul>
        )}
    </BloqueTorre>
  );
}
