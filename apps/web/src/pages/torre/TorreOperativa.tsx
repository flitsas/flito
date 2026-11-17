// Torre de Control (Épica #14590) — tablero Operativo (spec UX §7.2), con el molde de Comercial. Extiende
// `FlitoTablero` sin duplicarlo: no repite los conteos por estado, lo enlaza («Abrir el tablero operativo»).
import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { CausaRadarTorre, TableroOperativo } from '@operaciones/shared-types';
import { useAuth } from '../../lib/auth';
import { hasPage, type PageSlug } from '../../lib/permissions';
import KpiCard from '../../components/flit/KpiCard';
import DataTable, { type ColumnaTabla } from '../../components/flit/DataTable';
import FiltroSegmentado from '../../components/flit/FiltroSegmentado';
import { ListaFila } from '../../components/flit/Bloques';
import { claseBoton } from '../../components/flit/GradientButton';
import { Dona, SERIE_KIT } from '../../components/flit/Graficos';
import PaginaTorre, { BloqueTorre, REJILLA_2, REJILLA_KPI, useTorre } from '../../components/torre/PaginaTorre';
import MoldeTablero, { ExportarTablero, Etiqueta, Semaforo, notaFiltros, useTablero } from '../../components/torre/MoldeTablero';
import RankingTorre from '../../components/torre/RankingTorre';
import { conteo, porcentaje } from '../../components/torre/formatoTorre';

type FilaOt = TableroOperativo['benchmarkOt']['filas'][number];

/** «Ver cola»: la cola existente que atiende cada causa. */
const COLA: Record<CausaRadarTorre, { to: string; page: PageSlug }> = {
  soat_sin_gestion: { to: '/flito/soat', page: 'flito_soat' },
  impuesto_sin_gestion: { to: '/flito/impuestos', page: 'flito_impuestos' },
  borrador_abandonado: { to: '/flito/tramites', page: 'flito_tramites' },
  estancado_ot: { to: '/flito/tramites', page: 'flito_tramites' },
};

const dias = (n: number | null) => (n === null ? '—' : `${n.toLocaleString('es-CO', { maximumFractionDigits: 1 })} ${n === 1 ? 'día' : 'días'}`);

const esVacio = (d: TableroOperativo): boolean => d.cifras.wip === 0 && d.benchmarkOt.filas.length === 0 && d.radar.filas.every((f) => f.cantidad === 0);

export default function TorreOperativa() {
  const torre = useTorre();
  const { estado, reintentar } = useTablero<TableroOperativo>('operativa', torre.filtros);
  return (
    <PaginaTorre torre={torre} titulo="Operativa" subtitulo="Dónde se está quedando el trabajo y qué organismo responde más lento."
      acciones={<ExportarTablero area="operativa" filtros={torre.filtros} estado={estado} esVacio={esVacio} />}>
      <MoldeTablero estado={estado} nombre="Operativo" onReintentar={reintentar} onLimpiar={torre.restablecer}
        esVacio={esVacio}>
        {(d) => <Contenido d={d} />}
      </MoldeTablero>
    </PaginaTorre>
  );
}

function Contenido({ d }: { d: TableroOperativo }) {
  const { user } = useAuth();
  const [vistaCarga, setVistaCarga] = useState<'organismo' | 'funcionario'>('organismo');
  const c = d.cifras;
  const carga = vistaCarga === 'funcionario' && d.carga.porFuncionario ? d.carga.porFuncionario : d.carga.porOrganismo;
  const topCarga = carga.slice(0, 8);
  const maxCarga = Math.max(1, ...topCarga.map((s) => s.valor));
  const l = d.logistica;

  const columnasOt: ColumnaTabla<FilaOt>[] = [
    { key: 'ot', header: 'Organismo de tránsito', render: (f) => <strong>{f.organismo}</strong> },
    { key: 'volumen', header: 'Volumen', align: 'right', render: (f) => conteo(f.volumen) },
    { key: 'aprobado', header: '% aprobado', align: 'right', render: (f) => porcentaje(f.pctAprobado) },
    { key: 'rechazado', header: '% rechazado', align: 'right', render: (f) => porcentaje(f.pctRechazado) },
    { key: 'pendientes', header: 'Pendientes', align: 'right', render: (f) => conteo(f.pendientes) },
    {
      key: 'mediana', header: 'Mediana de respuesta', align: 'right',
      render: (f) => (f.sobreUmbral ? <Etiqueta tono="warn">{dias(f.medianaRespuestaDias)}</Etiqueta> : dias(f.medianaRespuestaDias)),
    },
  ];

  return (
    <>
      <div className={REJILLA_KPI}>
        <KpiCard label="Sin gestión fuera de ANS" value={conteo(c.sinGestionFueraAns)} pendiente={c.sinGestionFueraAns > 0} hint="SOAT e impuestos" />
        <KpiCard label="Borradores abandonados" value={conteo(c.borradoresAbandonados)} pendiente={c.borradoresAbandonados > 0} />
        <KpiCard label="Trámites en curso" value={conteo(c.wip)} hint="Trabajo activo hoy" />
        <KpiCard label="Entregas al primer intento" value={c.primerIntentoPct === null ? '—' : porcentaje(c.primerIntentoPct)} />
      </div>

      <div className={REJILLA_2}>
        <BloqueTorre idPrueba="bloque-radar" titulo="Radar de estancamiento" subtitulo={notaFiltros(d.radar, 'Lo que superó su umbral y en qué cola se atiende.')}>
          {d.radar.filas.every((f) => f.cantidad === 0)
            ? <p className="grafico-vacio">Nada estancado fuera de umbral.</p>
            : (
              <ListaFila filas={d.radar.filas.filter((f) => f.cantidad > 0).map((f) => {
                const cola = COLA[f.causa];
                return {
                  id: f.causa,
                  titulo: <span className="tabular-nums">{f.etiqueta}: {conteo(f.cantidad)}</span>,
                  detalle: `Umbral: ${f.umbral} ${f.unidad === 'horas' ? 'horas' : 'días'}`,
                  extra: <Semaforo severidad={f.severidad} />,
                  accion: hasPage(user, cola.page)
                    ? <Link to={cola.to} className={claseBoton('ghost', 'sm')} aria-label={`Ver cola: ${f.etiqueta}`}>Ver cola</Link>
                    : undefined,
                };
              })} />
            )}
          {hasPage(user, 'flito_tablero') && (
            <p className="mt-3"><Link to="/flito/tablero" className={claseBoton('ghost', 'sm')}>Abrir el tablero operativo</Link></p>
          )}
        </BloqueTorre>

        <BloqueTorre idPrueba="bloque-carga" titulo="Carga activa"
          subtitulo={notaFiltros(d.carga, vistaCarga === 'funcionario' ? 'Solo trámites con funcionario registrado.' : 'Trámites en curso por organismo (los 8 con más carga).')}
          accion={d.carga.porFuncionario ? (
            <FiltroSegmentado ariaLabel="Ver la carga" valor={vistaCarga} onCambio={setVistaCarga}
              opciones={[{ valor: 'organismo', etiqueta: 'Por organismo' }, { valor: 'funcionario', etiqueta: 'Por funcionario' }]} />
          ) : undefined}>
          {topCarga.length === 0
            ? <p className="grafico-vacio">Sin trámites en curso.</p>
            : <RankingTorre etiqueta="Carga activa" filas={topCarga.map((s) => ({ id: s.clave, etiqueta: s.etiqueta, pct: (s.valor / maxCarga) * 100, valor: conteo(s.valor) }))} />}
        </BloqueTorre>

        <BloqueTorre idPrueba="bloque-organismos" ancho titulo="Comparativo de organismos de tránsito"
          subtitulo={notaFiltros(d.benchmarkOt, `La mediana sobre ${d.benchmarkOt.umbralDias} días se marca en atención.`)}>
          <DataTable ariaLabel="Comparativo de organismos de tránsito" columnas={columnasOt} filas={d.benchmarkOt.filas}
            getKey={(f) => f.organismoCodigo ?? f.organismo} emptyMessage="Sin trámites radicados en el periodo." />
        </BloqueTorre>

        <BloqueTorre idPrueba="bloque-logistica" ancho titulo="Eficiencia logística" subtitulo={notaFiltros(d.logistica)}>
          {l.entregas === 0
            ? <p className="grafico-vacio">Sin viajes de logística en el periodo.</p>
            : (
              <div className="grid grid-cols-1 items-center gap-4 md:grid-cols-[minmax(0,1fr)_auto]">
                <ul className="m-0 grid list-none grid-cols-1 gap-3 p-0 sm:grid-cols-3">
                  <li><strong className="block text-2xl tabular-nums">{l.primerIntentoPct === null ? '—' : porcentaje(l.primerIntentoPct)}</strong><small>al primer intento</small></li>
                  <li><strong className="block text-2xl tabular-nums">{conteo(l.viajesAdicionales)}</strong><small>viajes fallidos</small></li>
                  <li><strong className="block text-2xl tabular-nums">{dias(l.tiempoMedioEntregaDias)}</strong><small>de entrega en promedio</small></li>
                </ul>
                <Dona etiqueta="Entregas al primer intento frente a reintento" pie="entregas"
                  partes={[
                    { t: 'Primer intento', v: l.primerIntento, c: SERIE_KIT.verde },
                    { t: 'Con reintento', v: Math.max(0, l.entregas - l.primerIntento), c: SERIE_KIT.naranja },
                  ]} />
              </div>
            )}
        </BloqueTorre>
      </div>
    </>
  );
}
