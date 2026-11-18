// Torre de Control (Épica #14590) — Resumen 360° (spec UX §7.4, maqueta `docs/ux/mockups/torre-360.html`). Tres
// tarjetas por área (enlace solo si el rol ve ese tablero), la proyección de cierre del mes y los 5 riesgos de hoy.
// El contrato trae UN endpoint (`/tableros/ejecutivo`), así que los 4 estados son de página (molde), no por tarjeta.
import { Link } from 'react-router-dom';
import type { RiesgoTorre, TableroEjecutivo } from '@operaciones/shared-types';
import { useAuth } from '../../lib/auth';
import { hasPage, type PageSlug } from '../../lib/permissions';
import KpiCard from '../../components/flit/KpiCard';
import { ListaFila } from '../../components/flit/Bloques';
import { claseBoton } from '../../components/flit/GradientButton';
import { LineaTendencia, SERIE_KIT } from '../../components/flit/Graficos';
import PaginaTorre, { BloqueTorre, REJILLA_2, REJILLA_KPI, rutaTorre, useTorre } from '../../components/torre/PaginaTorre';
import MoldeTablero, { ExportarTablero, Etiqueta, Semaforo, useTablero } from '../../components/torre/MoldeTablero';
import { conteo, pesosCorto, porcentaje, variacion } from '../../components/torre/formatoTorre';

const AREA: Record<RiesgoTorre['area'], { texto: string; slug: PageSlug }> = {
  comercial: { texto: 'Comercial', slug: 'torre_comercial' },
  operativo: { texto: 'Operativo', slug: 'torre_operativa' },
  financiero: { texto: 'Financiero', slug: 'torre_financiera' },
};

const esVacio = (d: TableroEjecutivo): boolean => d.comercial.tramitesMes === 0 && d.riesgos.length === 0 && d.proyeccion.acumulado.every((a) => a.valor === 0);

export default function Torre360() {
  const torre = useTorre();
  const { estado, reintentar } = useTablero<TableroEjecutivo>('ejecutivo', torre.filtros);
  return (
    <PaginaTorre torre={torre} titulo="Resumen 360°" subtitulo="Cómo va la compañía este mes: comercial, operación y finanzas en una vista."
      acciones={<ExportarTablero area="ejecutivo" filtros={torre.filtros} estado={estado} esVacio={esVacio} />}>
      <MoldeTablero estado={estado} nombre="Resumen 360°" onReintentar={reintentar} onLimpiar={torre.restablecer}
        esVacio={esVacio}>
        {(d) => <Contenido d={d} />}
      </MoldeTablero>
    </PaginaTorre>
  );
}

/** Acumulado del mes, su proyección punteada hasta el cierre y el mes anterior, día a día. */
function seriesProyeccion(p: TableroEjecutivo['proyeccion']) {
  const dias = Array.from({ length: p.diasMes }, (_, i) => i + 1);
  const valorDe = (lista: { dia: number; valor: number }[], dia: number) => lista.find((x) => x.dia === dia)?.valor ?? null;
  const hoy = p.diasTranscurridos;
  const ultimo = valorDe(p.acumulado, hoy) ?? 0;
  const ritmo = p.diasMes > hoy ? (p.proyeccionCierre - ultimo) / (p.diasMes - hoy) : 0;
  return {
    etiquetas: dias.map(String),
    series: [
      { t: 'Este mes', c: SERIE_KIT.azul, v: dias.map((d) => (d <= hoy ? valorDe(p.acumulado, d) : null)) },
      { t: 'Proyección', c: SERIE_KIT.azul, punteada: true, v: dias.map((d) => (d < hoy ? null : Math.round(ultimo + ritmo * (d - hoy)))) },
      { t: 'Mes anterior', c: SERIE_KIT.gris, v: dias.map((d) => valorDe(p.mesAnterior, d)) },
    ],
  };
}

function Contenido({ d }: { d: TableroEjecutivo }) {
  const { user } = useAuth();
  const ve = (slug: PageSlug) => hasPage(user, slug);
  const p = d.proyeccion;
  const graf = seriesProyeccion(p);
  const enlace = (slug: PageSlug) => (ve(slug) ? rutaTorre(slug) : undefined);

  return (
    <>
      <div className={REJILLA_KPI}>
        <KpiCard label="Comercial · trámites del mes" value={conteo(d.comercial.tramitesMes)} to={enlace('torre_comercial')}
          ariaLabel={`Comercial: ${conteo(d.comercial.tramitesMes)} trámites del mes. Abrir el tablero comercial`}>
          {d.comercial.clientesEnCaida > 0 && (
            <Etiqueta tono="warn">{conteo(d.comercial.clientesEnCaida)} {d.comercial.clientesEnCaida === 1 ? 'cliente en caída' : 'clientes en caída'}</Etiqueta>
          )}
        </KpiCard>
        <KpiCard label="Operativo · dentro del ANS" value={d.operativo.pctDentroAns === null ? '—' : porcentaje(d.operativo.pctDentroAns)}
          hint={`Aprobados en ${d.operativo.umbralDias} días o menos`} to={enlace('torre_operativa')}
          ariaLabel="Operativo: aprobados dentro del ANS. Abrir el tablero operativo" />
        <KpiCard label="Financiero · margen" value={d.financiero.margenPct === null ? '—' : porcentaje(d.financiero.margenPct)}
          hint={d.financiero.sinFacturarValor === null ? undefined : `${pesosCorto(d.financiero.sinFacturarValor)} sin facturar`}
          to={enlace('torre_financiera')} ariaLabel="Financiero: margen bruto. Abrir el tablero financiero" />
      </div>

      <div className={REJILLA_2}>
        <BloqueTorre idPrueba="bloque-proyeccion" ancho titulo="Proyección de cierre del mes" subtitulo="Siempre el mes en curso: no depende del periodo elegido.">
          <p className="m-0 text-3xl font-bold tabular-nums" style={{ color: 'var(--kit-azul)' }}>{conteo(p.proyeccionCierre)} trámites</p>
          <p className="mb-3 mt-1 text-sm" style={{ color: 'var(--color-text-secondary)' }}>
            {p.variacionPct === null ? '' : `${variacion(p.variacionPct)} frente al mes anterior (${conteo(p.totalMesAnterior)}). `}
            Calculada con el ritmo diario de lo que va del mes.
          </p>
          <LineaTendencia fluido titulo="Aprobados acumulados por día del mes" etiquetas={graf.etiquetas} series={graf.series}
            guia={p.meta !== null ? { v: p.meta, t: `Meta ${conteo(p.meta)}` } : undefined} vacio="Aún no hay aprobados este mes." />
        </BloqueTorre>

        <BloqueTorre idPrueba="bloque-riesgos" ancho titulo="Los 5 riesgos de hoy" subtitulo="Primero lo crítico y luego lo de mayor impacto.">
          {d.riesgos.length === 0
            ? <p className="grafico-vacio">Nada fuera de umbral hoy.</p>
            : (
              <ListaFila filas={d.riesgos.slice(0, 5).map((r, i) => ({
                id: `${r.area}-${i}`,
                titulo: r.frase,
                detalle: `${AREA[r.area].texto} · ${r.umbral}`,
                extra: <Semaforo severidad={r.severidad} />,
                accion: ve(AREA[r.area].slug)
                  ? <Link to={rutaTorre(AREA[r.area].slug)} className={claseBoton('ghost', 'sm')} aria-label={`Ver tablero ${AREA[r.area].texto.toLowerCase()}`}>Ver</Link>
                  : undefined,
              }))} />
            )}
        </BloqueTorre>
      </div>
    </>
  );
}
