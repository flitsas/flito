// La gráfica de evolución diaria de Gastos diarios (HU #12625): SVG propio —sin dependencia—, una
// barra apilada por día con un segmento por categoría visible, ejes y rejilla con tokens del tema.
// Vive dentro de una `<figure>` con el resumen en `aria-label` y la tabla equivalente por
// `aria-describedby`; el detalle del día activo y su anuncio quedan fuera del svg.
//
// El ancho del `viewBox` es el ancho medido del contenedor: 1 unidad = 1 px, el texto no se
// deforma y `pasoEtiquetas` decide con píxeles reales cuántos días rotular. El puntero se resuelve
// una sola vez en el svg (`indicePorX`), no con un handler por barra: 366 días no son 366 listeners.
//
// Lo que NO decide este componente: cargando y error los lleva la página (skeleton de este alto en
// `SkeletonGastos`; en error no se pinta nada). El vacío sí es suyo: «Sin gastos en el rango».

import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from 'react';
import type { GastosDiariosRespuesta } from '@operaciones/shared-types';
import { FlitCard } from '../../flit/flitPageKit';
import BarrasDias, { type ModoActiva } from './BarrasDias';
import DetalleDia from './DetalleDia';
import LeyendaGrafica from './LeyendaGrafica';
import PatronesSerie from './PatronesSerie';
import TablaGrafica, { ID_TABLA_GRAFICA } from './TablaGrafica';
import {
  ALTO_SVG, MARGEN, apilar, escalaValor, filasTabla, indicePorX, pasoEtiquetas, resumenFigura, anchoBarra,
  type EscalaValor,
} from './geometriaGrafica';
import { CATEGORIAS, cifra, diaCorto, type GastosDiariosCategoria } from './tiposGastosDiarios';

const ID_TITULO = 'gastos-grafica-titulo';
const ANCHO_INICIAL = 1100;
const texto = { fontSize: 11, fill: 'var(--flit-text-muted)', fontFamily: 'inherit' } as const;

function Ejes({ escala, dias, ancho, altoPlot }: { escala: EscalaValor; dias: string[]; ancho: number; altoPlot: number }) {
  const anchoPlot = ancho - MARGEN.izq - MARGEN.der;
  const { ranura } = anchoBarra(dias.length, anchoPlot);
  const paso = pasoEtiquetas(dias.length, anchoPlot);
  const y = (v: number) => MARGEN.arriba + altoPlot - (v / escala.max) * altoPlot;
  return (
    <g aria-hidden="true">
      {escala.ticks.map((v) => (
        <g key={v}>
          <line x1={MARGEN.izq} x2={ancho - MARGEN.der} y1={y(v)} y2={y(v)} stroke="var(--flit-border-soft)" strokeWidth={1} />
          <text x={MARGEN.izq - 8} y={y(v) + 4} textAnchor="end" style={texto}>{cifra(v)}</text>
        </g>
      ))}
      <line x1={MARGEN.izq} x2={ancho - MARGEN.der} y1={y(0)} y2={y(0)} stroke="var(--flit-border-input)" strokeWidth={1} />
      {dias.map((d, i) => (i % paso === 0
        ? <text key={d} x={MARGEN.izq + i * ranura + ranura / 2} y={ALTO_SVG - 8} textAnchor="middle" style={texto}>{diaCorto(d, false)}</text>
        : null))}
    </g>
  );
}

export default function GraficaGastosDiarios({ datos, tipos, onTipo, vacio }: {
  datos: GastosDiariosRespuesta;
  tipos: readonly GastosDiariosCategoria[];
  onTipo: (c: GastosDiariosCategoria) => void;
  /** Las cinco categorías en 0 en todo el rango: solo el mensaje, sin ejes ni tabla. */
  vacio: boolean;
}) {
  const visibles = CATEGORIAS.filter((c) => tipos.includes(c.clave));
  const barras = apilar(datos.serie, tipos);
  const escala = escalaValor(barras);
  const resumen = resumenFigura(datos.desde, datos.hasta, visibles.length, datos.totales.total);

  const contenedor = useRef<HTMLDivElement>(null);
  const [ancho, setAncho] = useState(ANCHO_INICIAL);
  useLayoutEffect(() => {
    const el = contenedor.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const medir = () => { const w = Math.floor(el.getBoundingClientRect().width); if (w > 0) setAncho(w); };
    medir();
    const ro = new ResizeObserver(medir);
    ro.observe(el);
    return () => ro.disconnect();
  }, [vacio]);
  const anchoPlot = ancho - MARGEN.izq - MARGEN.der;
  const altoPlot = ALTO_SVG - MARGEN.arriba - MARGEN.abajo;

  const [puntero, setPuntero] = useState<number | null>(null);
  const [foco, setFoco] = useState(0);
  const [enfocada, setEnfocada] = useState(false);
  const [tablaAbierta, setTablaAbierta] = useState(false);
  // Otra consulta: el foco vuelve al primer día y el puntero se olvida.
  useEffect(() => { setFoco(0); setPuntero(null); }, [datos]);

  const mover = (e: MouseEvent<SVGSVGElement>) => {
    const caja = e.currentTarget.getBoundingClientRect();
    setPuntero(indicePorX(e.clientX - caja.left - MARGEN.izq, barras.length, anchoPlot));
  };
  const activa = puntero ?? (enfocada ? foco : null);
  const modo: ModoActiva | null = puntero !== null ? 'puntero' : enfocada ? 'foco' : null;

  if (vacio) {
    return (
      <FlitCard>
        <figure className="m-0" aria-label={resumen}>
          <h2 id={ID_TITULO} className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--flit-text-muted)' }}>Evolución diaria</h2>
          <p className="flex items-center justify-center text-sm" style={{ height: ALTO_SVG, color: 'var(--flit-text-muted)' }}>
            Sin gastos en el rango
          </p>
        </figure>
      </FlitCard>
    );
  }

  return (
    <FlitCard>
      <figure className="m-0" aria-label={resumen} aria-describedby={ID_TABLA_GRAFICA}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id={ID_TITULO} className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--flit-text-muted)' }}>Evolución diaria</h2>
          <LeyendaGrafica tipos={tipos} onTipo={onTipo} />
        </div>
        <div ref={contenedor} className="mt-2 w-full">
          <svg viewBox={`0 0 ${ancho} ${ALTO_SVG}`} width="100%" height={ALTO_SVG} style={{ display: 'block' }}
            onMouseMove={mover} onMouseLeave={() => setPuntero(null)}>
            <PatronesSerie />
            <Ejes escala={escala} dias={barras.map((b) => b.dia)} ancho={ancho} altoPlot={altoPlot} />
            <BarrasDias barras={barras} escala={escala} anchoPlot={anchoPlot} altoPlot={altoPlot}
              activa={activa} modo={modo} foco={foco}
              onFoco={(i) => { setFoco(i); setEnfocada(true); }} onSalirFoco={() => setEnfocada(false)} />
          </svg>
        </div>
        <DetalleDia barra={activa !== null ? barras[activa] ?? null : null} />
        <TablaGrafica filas={filasTabla(barras)} visibles={visibles} abierta={tablaAbierta}
          onAlternar={() => setTablaAbierta((v) => !v)} />
      </figure>
    </FlitCard>
  );
}
