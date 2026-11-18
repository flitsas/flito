// Torre de Control (Épica #14590) — tablero Comercial, el MOLDE de los cuatro (spec UX §7.1, maqueta
// `docs/ux/mockups/torre-comercial.html`): 4 cifras, caídas de volumen, concentración, conversión, tendencia y la
// matriz de venta cruzada («Usa», «No usa», «Autogestiona»).
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  LINEAS_VENTA_TORRE, type ConcentracionTorre, type LineaVentaTorre, type TableroComercial, type UsoLineaTorre,
} from '@operaciones/shared-types';
import { useAuth } from '../../lib/auth';
import { hasPage } from '../../lib/permissions';
import { guardarFiltrosTorre } from '../../lib/torreFiltros';
import KpiCard from '../../components/flit/KpiCard';
import Sparkline from '../../components/flit/Sparkline';
import DataTable, { type ColumnaTabla } from '../../components/flit/DataTable';
import FiltroSegmentado from '../../components/flit/FiltroSegmentado';
import GradientButton from '../../components/flit/GradientButton';
import { ListaFila } from '../../components/flit/Bloques';
import { Dona, LineaTendencia, SERIE_KIT } from '../../components/flit/Graficos';
import type { TonoKit } from '../../components/flit/kit/tonos';
import PaginaTorre, { BloqueTorre, REJILLA_2, REJILLA_KPI, useTorre } from '../../components/torre/PaginaTorre';
import MoldeTablero, { ExportarTablero, Etiqueta, notaFiltros, useTablero } from '../../components/torre/MoldeTablero';
import RankingTorre from '../../components/torre/RankingTorre';
import { conteo, porcentaje, pesos, variacion } from '../../components/torre/formatoTorre';

type FilaVenta = TableroComercial['ventaCruzada']['filas'][number];

const LINEA: Record<LineaVentaTorre, string> = { tramites: 'Trámites', soat: 'SOAT', impuestos: 'Impuestos', derechos: 'Derechos', logistica: 'Logística' };
const USO: Record<UsoLineaTorre, { tono: TonoKit; texto: string }> = {
  usa: { tono: 'ok', texto: 'Usa' }, autogestiona: { tono: 'info', texto: 'Autogestiona' }, no_usa: { tono: 'neutro', texto: 'No usa' },
};
const PASO: Record<string, string> = { creados: 'Creados', radicados: 'Radicados', aprobados: 'Aprobados', facturados: 'Facturados' };
const COLORES_DONA = [SERIE_KIT.azul, SERIE_KIT.turquesa, SERIE_KIT.amarillo];

function partesDona(c: ConcentracionTorre) {
  return [
    ...c.top.slice(0, 3).map((p, i) => ({ t: `${p.compania} · ${Math.round(p.pct)} %`, v: p.valor, c: COLORES_DONA[i] })),
    ...(c.demas.n > 0 ? [{ t: `Los demás (${c.demas.n}) · ${Math.round(c.demas.pct)} %`, v: c.demas.valor, c: SERIE_KIT.gris }] : []),
  ];
}

const esVacio = (d: TableroComercial): boolean => d.cifras.tramitesPeriodo === 0 && d.ventaCruzada.filas.length === 0;

export default function TorreComercial() {
  const torre = useTorre();
  const { estado, reintentar } = useTablero<TableroComercial>('comercial', torre.filtros);
  return (
    <PaginaTorre torre={torre} titulo="Comercial" subtitulo="Qué clientes crecen, cuáles se están yendo y dónde hay venta por hacer."
      acciones={<ExportarTablero area="comercial" filtros={torre.filtros} estado={estado} esVacio={esVacio} />}>
      <MoldeTablero estado={estado} nombre="Comercial" onReintentar={reintentar} onLimpiar={torre.restablecer}
        esVacio={esVacio}>
        {(d) => (
          <Contenido d={d} onExplorar={(companiaId) => {
            // Se guarda YA: la navegación desmonta esta página antes de que corra el efecto que persiste.
            const siguiente = { ...torre.filtros, companiaIds: [companiaId] };
            guardarFiltrosTorre(siguiente);
            torre.setFiltros(siguiente);
          }} />
        )}
      </MoldeTablero>
    </PaginaTorre>
  );
}

function Contenido({ d, onExplorar }: { d: TableroComercial; onExplorar: (companiaId: number) => void }) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const puedeExplorar = hasPage(user, 'torre_explorador');
  const [vistaConc, setVistaConc] = useState<'volumen' | 'ingreso'>('volumen');
  const [vistaTend, setVistaTend] = useState<'mensual' | 'trimestral'>('mensual');
  const c = d.cifras;
  const dif = c.tramitesPeriodo - c.tramitesPeriodoAnterior;
  const conc = vistaConc === 'ingreso' && d.concentracion.ingreso ? d.concentracion.ingreso : d.concentracion.volumen;
  const serie = vistaTend === 'mensual' ? d.tendencia.mensual : d.tendencia.trimestral;

  const columnasVenta: ColumnaTabla<FilaVenta>[] = [
    { key: 'cliente', header: 'Cliente', render: (f) => <strong>{f.compania}</strong> },
    ...LINEAS_VENTA_TORRE.map((l) => ({
      key: l, header: LINEA[l],
      render: (f: FilaVenta) => <Etiqueta tono={USO[f.lineas[l]].tono}>{USO[f.lineas[l]].texto}</Etiqueta>,
    })),
  ];

  return (
    <>
      <div className={REJILLA_KPI}>
        <KpiCard label="Clientes con caída de volumen" value={conteo(c.clientesEnCaida)} pendiente={c.clientesEnCaida > 0}
          hint={c.clientesEnCaida > 0 ? 'Vea cuáles en «Clientes con caída de volumen»' : 'Ninguno por debajo de su promedio'} />
        <KpiCard label="Concentración en el Top 3" value={porcentaje(c.concentracionTop3Pct)} hint={`Top 5: ${porcentaje(c.concentracionTop5Pct)}`} />
        <KpiCard label="Conversión a facturado" value={porcentaje(c.conversionFacturadoPct)} hint="De lo creado en el periodo" />
        <KpiCard label="Trámites del periodo" value={conteo(c.tramitesPeriodo)}
          hint={`${dif === 0 ? 'Igual que' : `${conteo(Math.abs(dif))} ${dif > 0 ? 'más' : 'menos'} que`} el periodo anterior (${conteo(c.tramitesPeriodoAnterior)})`}>
          <Sparkline data={c.sparkline} />
        </KpiCard>
      </div>

      <div className={REJILLA_2}>
        <BloqueTorre idPrueba="bloque-caidas" titulo="Clientes con caída de volumen"
          subtitulo={notaFiltros(d.fuga, `Trámites de los últimos ${d.fuga.ventanaDias} días frente a su promedio. Umbral: caída de ${d.fuga.umbralPct} % o más.`)}>
          {d.fuga.filas.length === 0
            ? <p className="grafico-vacio">Ningún cliente cayó por debajo de su promedio en este periodo.</p>
            : (
              <ListaFila filas={d.fuga.filas.map((f) => ({
                id: String(f.companiaId),
                titulo: f.compania,
                detalle: `${conteo(f.tramitesVentana)} trámites; su promedio es ${conteo(f.promedio)}`,
                extra: <Etiqueta tono="warn">{variacion(f.variacionPct)}</Etiqueta>,
                accion: puedeExplorar ? (
                  <GradientButton variant="ghost" size="sm" aria-label={`Explorar ${f.compania}`}
                    onClick={() => { onExplorar(f.companiaId); navigate('/flito/torre/explorador'); }}>
                    Explorar
                  </GradientButton>
                ) : undefined,
              }))} />
            )}
        </BloqueTorre>

        <BloqueTorre idPrueba="bloque-concentracion" titulo="Concentración de clientes" subtitulo={notaFiltros(d.concentracion, 'Qué parte del total se llevan los clientes más grandes.')}
          accion={d.concentracion.ingreso ? (
            <FiltroSegmentado ariaLabel="Medir la concentración por" valor={vistaConc} onCambio={setVistaConc}
              opciones={[{ valor: 'volumen', etiqueta: 'Volumen' }, { valor: 'ingreso', etiqueta: 'Ingreso' }]} />
          ) : undefined}>
          <Dona partes={partesDona(conc)} etiqueta={`Concentración por ${vistaConc}`} pie={vistaConc === 'ingreso' ? 'pesos' : 'trámites'}
            vacio="Sin trámites en el periodo." />
          {vistaConc === 'ingreso' && <p className="mt-2 text-sm" style={{ color: 'var(--color-text-tertiary)' }}>Total: {pesos(conc.total)}</p>}
        </BloqueTorre>

        <BloqueTorre idPrueba="bloque-conversion" titulo="Conversión" subtitulo={notaFiltros(d.embudo, 'Cada paso sobre lo creado en el periodo.')}>
          <RankingTorre etiqueta="Conversión por paso" filas={d.embudo.pasos.map((p) => ({ id: p.paso, etiqueta: PASO[p.paso] ?? p.paso, pct: p.pct, valor: conteo(p.valor) }))} />
        </BloqueTorre>

        <BloqueTorre idPrueba="bloque-tendencia" titulo="Tendencia" subtitulo={notaFiltros(d.tendencia, 'Últimos 6 meses cerrados.')}
          accion={(
            <FiltroSegmentado ariaLabel="Ver la tendencia" valor={vistaTend} onCambio={setVistaTend}
              opciones={[{ valor: 'mensual', etiqueta: 'Mensual' }, { valor: 'trimestral', etiqueta: 'Trimestral' }]} />
          )}>
          <LineaTendencia fluido titulo={`Trámites por ${vistaTend === 'mensual' ? 'mes' : 'trimestre'}`} etiquetas={serie.map((s) => s.etiqueta)}
            series={[{ t: 'Trámites', c: SERIE_KIT.azul, v: serie.map((s) => s.valor) }]} vacio="Sin trámites en los últimos 6 meses." />
        </BloqueTorre>

        <BloqueTorre idPrueba="bloque-venta-cruzada" ancho titulo="Venta cruzada"
          subtitulo={notaFiltros(d.ventaCruzada, 'Los 10 clientes con más trámites y qué líneas usan. El resto, en el Excel.')}>
          {d.ventaCruzada.filas.length === 0
            ? <p className="grafico-vacio">Sin clientes con trámites en el periodo.</p>
            : <DataTable matriz ariaLabel="Venta cruzada por cliente" columnas={columnasVenta} filas={d.ventaCruzada.filas} getKey={(f) => String(f.companiaId)} />}
        </BloqueTorre>
      </div>
    </>
  );
}
