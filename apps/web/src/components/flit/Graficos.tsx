/**
 * Gráficos del UI Kit 2026 («Uso de gráficos»): dona de 132 px con total y leyenda en lista, y barras agrupadas con
 * guías punteadas, ejes y leyenda. Colores de la paleta del manual vía `SERIE_KIT` (tokens), nunca hex en páginas.
 */
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as EventoPuntero, type ReactNode, type RefObject } from 'react';

export const SERIE_KIT = {
  azul: 'var(--kit-serie-azul)', turquesa: 'var(--kit-serie-turquesa)', amarillo: 'var(--kit-serie-amarillo)',
  verde: 'var(--kit-serie-verde)', naranja: 'var(--kit-serie-naranja)', rojo: 'var(--kit-serie-rojo)',
  gris: 'var(--kit-serie-gris)', tinta: 'var(--color-text-primary)',
} as const;

export interface ParteDona { t: string; v: number; c: string }

export function Dona({ partes, etiqueta, pie = 'total', vacio = 'Sin datos en el periodo' }: {
  partes: ParteDona[]; etiqueta: string; pie?: string; vacio?: string;
}) {
  const con = partes.filter((x) => x.v > 0);
  const total = con.reduce((a, x) => a + x.v, 0);
  if (!total) return <p className="grafico-vacio">{vacio}</p>;
  const C = 2 * Math.PI * 42;
  let ido = 0;
  return (
    <div className="dona" data-kit="dona">
      <svg viewBox="0 0 120 120" role="img" aria-label={`${etiqueta}: ${con.map((x) => `${x.t} ${x.v}`).join(', ')}`}>
        {con.map((x) => {
          const largo = (C * x.v) / total;
          const arco = (
            <circle key={x.t} cx="60" cy="60" r="42" fill="none" stroke={x.c} strokeWidth="18"
              strokeDasharray={`${largo.toFixed(2)} ${(C - largo).toFixed(2)}`} strokeDashoffset={(-ido).toFixed(2)} transform="rotate(-90 60 60)" />
          );
          ido += largo;
          return arco;
        })}
        <text x="60" y="59" textAnchor="middle" className="dona__total">{total.toLocaleString('es-CO')}</text>
        <text x="60" y="73" textAnchor="middle" className="dona__pie">{pie}</text>
      </svg>
      <ul className="leyenda leyenda--lista">
        {con.map((x) => <li key={x.t}><i style={{ background: x.c }} />{x.t}<strong>{x.v.toLocaleString('es-CO')}</strong></li>)}
      </ul>
    </div>
  );
}

export interface SerieBarras { t: string; c: string; v: number[] }

/** Props del modo `fluido` (G1, spec Torre vistas flexibles §4). Opt-in: sin ella, el dibujo de siempre (viewBox 560). */
interface PropsEje {
  /** Ancho real del contenedor (`ResizeObserver`), rótulos espaciados y scroll horizontal con eje Y fijo. */
  fluido?: boolean;
  /** Etiqueta larga de cada corte para el tip y el `aria-label`; el eje pinta la corta de `etiquetas`. */
  titulosTip?: string[];
}

const ALTO_SVG = 250, Y0 = 214, ALTO = 190, X0 = 34;

/** Ancho real de la caja del gráfico; 560 de respaldo hasta la primera medida (o sin `ResizeObserver`). */
function useAnchoCaja(caja: RefObject<HTMLDivElement>, activo: boolean): number {
  const [ancho, setAncho] = useState(560);
  useLayoutEffect(() => {
    const el = caja.current;
    if (!activo || !el || typeof ResizeObserver === 'undefined') return undefined;
    const medir = () => { const w = Math.floor(el.clientWidth); if (w > 0) setAncho(w); };
    medir();
    const ro = new ResizeObserver(medir);
    ro.observe(el);
    return () => ro.disconnect();
  }, [caja, activo]);
  return ancho;
}

interface GeometriaEje {
  /** Ancho del viewBox del área del trazo. */
  W: number; x0: number; grupo: number;
  /** El trazo no cabe: va en un área desplazable y el eje Y en un SVG fijo aparte. */
  desliza: boolean;
  rotula: (i: number) => boolean;
}

/**
 * Geometría del eje X. Clásica: viewBox 560 y, por debajo de 640 px con más de 8 cortes, una etiqueta de cada dos.
 * Fluida (spec §4): el viewBox mide lo que la caja, se rotula un corte de cada ⌈separación / px por corte⌉ desde el
 * primero (56 px con «1 jun», 76 con «jun 2026» o «T3 2026»), el último solo si queda a esa distancia del anterior, y
 * si no caben `minPorCorte` px por corte el trazo se desliza.
 */
function geometriaEje(fluido: boolean, ancho: number, etiquetas: string[], minPorCorte: number, alternar: boolean): GeometriaEje {
  const n = Math.max(1, etiquetas.length);
  if (!fluido) {
    const grupo = (560 - X0 - 8) / n;
    return { W: 560, x0: X0, grupo, desliza: false, rotula: (i) => !(alternar && etiquetas.length > 8 && i % 2 === 1) };
  }
  const util = Math.max(1, ancho - X0 - 16);
  const desliza = etiquetas.length * minPorCorte > util;
  const x0 = desliza ? 16 : X0;
  const plot = desliza ? etiquetas.length * minPorCorte : util;
  const grupo = plot / n;
  // Separación por la etiqueta TÍPICA (mediana de largos): el año del primer corte no debe ralear todo el eje.
  const largos = etiquetas.map((e) => e.length).sort((a, b) => a - b);
  const separacion = (largos[Math.floor(largos.length / 2)] ?? 0) <= 6 ? 56 : 76;
  const paso = Math.max(1, Math.ceil(separacion / grupo));
  const ultimo = etiquetas.length - 1;
  const ultimoRotulado = Math.floor(ultimo / paso) * paso;
  const conUltimo = ultimo !== ultimoRotulado && (ultimo - ultimoRotulado) * grupo >= separacion;
  return { W: x0 + plot + 16, x0, grupo, desliza, rotula: (i) => i % paso === 0 || (conUltimo && i === ultimo) };
}

/** Escala del eje Y: guías «redondas» hasta el tope. */
function escalaY(max: number) {
  const paso = max <= 10 ? 2 : max <= 25 ? 5 : max <= 100 ? 10 : Math.pow(10, Math.floor(Math.log10(max)));
  const tope = Math.ceil(max / paso) * paso;
  const guias: number[] = [];
  for (let t = 0; t <= tope; t += paso) guias.push(t);
  return { tope, guias };
}

/**
 * Marco común: guías, rótulos del eje Y y, en modo fluido con desborde, el aviso «Deslice…», el eje Y fijo y el área
 * desplazable (región con foco, arranca en el corte más reciente).
 */
function MarcoEje({ geo, fluido, guias, y, svg, etiquetaSvg, titulo, children }: {
  geo: GeometriaEje; fluido: boolean; guias: number[]; y: (v: number) => number; svg: RefObject<SVGSVGElement>;
  etiquetaSvg: string; titulo: string; children: ReactNode;
}) {
  const area = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (geo.desliza && area.current) area.current.scrollLeft = area.current.scrollWidth;
  }, [geo.desliza, geo.W]);
  const lineas = (desde: number) => guias.map((t) => <line key={t} x1={desde} x2={geo.W} y1={y(t)} y2={y(t)} className="grafico__guia" />);
  const rotulosY = (x: number) => guias.map((t) => <text key={t} x={x - 8} y={y(t) + 4} textAnchor="end" className="grafico__eje">{t}</text>);
  const estilo = fluido ? { width: geo.desliza ? geo.W : '100%', height: ALTO_SVG, maxHeight: 'none' } : undefined;
  if (!geo.desliza) {
    return (
      <svg ref={svg} viewBox={`0 0 ${geo.W} ${ALTO_SVG}`} style={estilo} role="img" aria-label={etiquetaSvg}>
        {lineas(geo.x0)}
        {rotulosY(geo.x0)}
        {children}
      </svg>
    );
  }
  return (
    <>
      <p className="mb-1 text-sm" style={{ color: 'var(--color-text-tertiary)' }}>Deslice para ver todos los cortes.</p>
      <div className="flex" data-kit="eje-desplazable">
        <svg viewBox={`0 0 ${X0} ${ALTO_SVG}`} style={{ width: X0, height: ALTO_SVG, maxHeight: 'none', flex: 'none' }} aria-hidden="true">
          {rotulosY(X0)}
        </svg>
        <div ref={area} role="region" tabIndex={0} aria-label={`Gráfica ${titulo}, desplazable`}
          className="flit-focus min-w-0 flex-1 overflow-x-auto rounded-[6px]">
          <svg ref={svg} viewBox={`0 0 ${geo.W} ${ALTO_SVG}`} style={estilo} role="img" aria-label={etiquetaSvg}>
            {lineas(0)}
            {children}
          </svg>
        </div>
      </div>
    </>
  );
}

/** Rótulos del eje X (solo los que `rotula`) y, en modo fluido, la marca de 4 px de TODOS los cortes. */
function RotulosX({ geo, fluido, etiquetas, x }: { geo: GeometriaEje; fluido: boolean; etiquetas: string[]; x: (i: number) => number }) {
  return (
    <g data-kit="eje-x">
      {etiquetas.map((e, i) => (
        <g key={`${e}-${i}`}>
          {fluido && <line x1={x(i)} x2={x(i)} y1={Y0} y2={Y0 + 4} className="grafico__marca" />}
          {geo.rotula(i) && <text x={x(i)} y={Y0 + 18} textAnchor="middle" className="grafico__eje" data-rotulo="x">{e}</text>}
        </g>
      ))}
    </g>
  );
}

export function BarrasGrupo({ etiquetas, series, titulo, fluido = false, titulosTip }: {
  etiquetas: string[]; series: SerieBarras[]; titulo: string;
} & PropsEje) {
  const max = Math.max(1, ...series.flatMap((s) => s.v));
  const { tope, guias } = escalaY(max);
  const { svg, tip, mostrar, columna, cajaProps } = useTipGrafico();
  const ancho = useAnchoCaja(cajaProps.ref, fluido);
  const geo = geometriaEje(fluido, ancho, etiquetas, 8 * Math.max(1, series.length) + 8, false);
  const { grupo, x0, W } = geo;
  const bw = fluido
    ? Math.max(3, Math.min(46, (grupo * 0.7 - 3 * (series.length - 1)) / Math.max(1, series.length)))
    : Math.min(46, (grupo - 24) / Math.max(1, series.length));
  const largo = (i: number) => titulosTip?.[i] ?? etiquetas[i];
  const y = (v: number) => Y0 - (ALTO * v) / tope;
  const resumen = series.map((s) => `${s.t}: ${etiquetas.map((_, i) => `${largo(i)} ${s.v[i] ?? 0}`).join(', ')}`).join('. ');
  return (
    <div className="grafico" data-kit="barras" data-fluido={fluido || undefined} {...cajaProps}>
      <MarcoEje geo={geo} fluido={fluido} guias={guias} y={y} svg={svg} etiquetaSvg={`${titulo}. ${resumen}`} titulo={titulo}>
        {etiquetas.map((e, i) => {
          const ini = x0 + grupo * i + (grupo - bw * series.length - 3 * (series.length - 1)) / 2;
          return (
            <g key={`${e}-${i}`}>
              {series.map((s, j) => {
                const h = (ALTO * (s.v[i] ?? 0)) / tope;
                return <rect key={s.t} x={ini + j * (bw + 3)} y={Y0 - h} width={bw} height={h} rx="3" fill={s.c} />;
              })}
            </g>
          );
        })}
        <RotulosX geo={geo} fluido={fluido} etiquetas={etiquetas} x={(i) => x0 + grupo * i + grupo / 2} />
        {etiquetas.map((e, i) => (
          <rect key={`col-${i}`} x={x0 + grupo * i} y={Y0 - ALTO} width={grupo} height={ALTO} className="grafico__columna" data-etiqueta={e}
            {...columna(i, () => mostrar(i, x0 + grupo * i + grupo / 2,
              Y0 - (ALTO * Math.max(...series.map((s) => s.v[i] ?? 0))) / tope, W, largo(i),
              series.map((s) => ({ t: s.t, c: s.c, valor: String(s.v[i] ?? 0) }))))} />
        ))}
      </MarcoEje>
      <TipGrafico tip={tip} />
      <ul className="leyenda">{series.map((s) => <li key={s.t}><i style={{ background: s.c }} />{s.t}</li>)}</ul>
    </div>
  );
}

export interface SerieLinea { t: string; c: string; v: (number | null)[]; punteada?: boolean }

/** Las etiquetas del eje X se alternan por debajo de 640 px cuando hay más de 8 (spec Torre §9). */
function useAnchoAngosto(): boolean {
  const consulta = '(max-width: 639px)';
  const [angosto, setAngosto] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.(consulta).matches);
  useEffect(() => {
    const mq = window.matchMedia?.(consulta);
    if (!mq) return;
    const cambio = () => setAngosto(mq.matches);
    mq.addEventListener('change', cambio);
    return () => mq.removeEventListener('change', cambio);
  }, []);
  return angosto;
}

type FormaMarcador = 'circulo' | 'cuadrado' | 'rombo';
interface FilaTip { t: string; c: string; valor: string; forma?: FormaMarcador }
interface Tip { i: number; x: number; y: number; lado: 'izq' | 'centro' | 'der'; abajo: boolean; titulo: string; filas: FilaTip[] }

/**
 * Valor al pasar el cursor (o al tocar en móvil) sin el retardo del `<title>` nativo: columnas invisibles por etiqueta
 * en el SVG y una tarjeta HTML posicionada sobre el punto más alto. El texto accesible sigue en el `aria-label` del SVG
 * (la tarjeta es `aria-hidden` para no duplicar la lectura).
 */
function useTipGrafico() {
  const caja = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const [tip, setTip] = useState<Tip | null>(null);
  const mostrar = (i: number, vx: number, vy: number, W: number, titulo: string, filas: FilaTip[]) => {
    const m = svg.current?.getScreenCTM();
    const c = caja.current?.getBoundingClientRect();
    if (!m || !c || !svg.current || filas.length === 0) { setTip(null); return; }
    const p = new DOMPoint(vx, vy).matrixTransform(m);
    const frac = vx / W;
    setTip({ i, x: p.x - c.left, y: p.y - c.top, lado: frac < 0.3 ? 'izq' : frac > 0.7 ? 'der' : 'centro', abajo: vy < 90, titulo, filas });
  };
  const columna = (i: number, abrir: () => void) => ({
    onPointerEnter: (e: EventoPuntero<SVGRectElement>) => { if (e.pointerType === 'mouse') abrir(); },
    onPointerDown: (e: EventoPuntero<SVGRectElement>) => {
      if (e.pointerType === 'mouse') return;
      if (tip?.i === i) setTip(null); else abrir();
    },
  });
  const cajaProps = {
    ref: caja,
    onPointerLeave: (e: EventoPuntero<HTMLDivElement>) => { if (e.pointerType === 'mouse') setTip(null); },
  };
  return { svg, tip, mostrar, columna, cajaProps };
}

function TipGrafico({ tip }: { tip: Tip | null }) {
  if (!tip) return null;
  return (
    <div className="grafico__tip" data-lado={tip.lado} data-abajo={tip.abajo ? 'si' : undefined} aria-hidden="true"
      style={{ left: tip.x, top: tip.y }}>
      <p className="grafico__tip-titulo">{tip.titulo}</p>
      <ul>
        {tip.filas.map((f) => <li key={f.t}><i data-forma={f.forma} style={{ background: f.c }} />{f.t}<b>{f.valor}</b></li>)}
      </ul>
    </div>
  );
}

/** Forma del punto por orden de serie: señal no cromática (WCAG 1.4.1) para que dos líneas no dependan solo del color. */
const FORMAS: readonly FormaMarcador[] = ['circulo', 'cuadrado', 'rombo'];

function Marcador({ forma, cx, cy, c, activo }: { forma: FormaMarcador; cx: number; cy: number; c: string; activo: boolean }) {
  const k = activo ? 1.4 : 1;
  if (forma === 'cuadrado') return <rect x={cx - 3.5 * k} y={cy - 3.5 * k} width={7 * k} height={7 * k} fill={c} />;
  if (forma === 'rombo') {
    return <path d={`M${cx.toFixed(1)} ${(cy - 5 * k).toFixed(1)}l${5 * k} ${5 * k}l${-5 * k} ${5 * k}l${-5 * k} ${-5 * k}z`} fill={c} />;
  }
  return <circle cx={cx} cy={cy} r={4 * k} fill={c} />;
}

/**
 * Línea de tendencia del kit: misma geometría, guías, ejes y leyenda que `BarrasGrupo` (viewBox 560×250, x0=34, y0=214,
 * alto 190). Trazo 2,5, puntos con `<title>` cuya forma cambia por serie (círculo, cuadrado, rombo), `punteada` =
 * dasharray 6 6, `null` corta la línea. `guia` es una línea
 * discontinua de tinta (la meta) que se nombra en la leyenda. Colores solo por `SERIE_KIT`. Con `fluido`, el eje
 * de la spec de la Torre §4 (ancho real, rótulos espaciados, scroll con eje Y fijo desde 20 px por corte).
 */
export function LineaTendencia({ etiquetas, series, titulo, guia, formato, vacio = 'Sin datos en el periodo', fluido = false, titulosTip }: {
  etiquetas: string[]; series: SerieLinea[]; titulo: string; guia?: { v: number; t: string };
  formato?: (n: number) => string; vacio?: string;
} & PropsEje) {
  const angosto = useAnchoAngosto();
  const { svg, tip, mostrar, columna, cajaProps } = useTipGrafico();
  const valores = series.flatMap((s) => s.v.filter((x): x is number => x !== null));
  const hayDatos = etiquetas.length > 0 && valores.length > 0;
  const ancho = useAnchoCaja(cajaProps.ref, fluido && hayDatos);
  if (!hayDatos) return <p className="grafico-vacio">{vacio}</p>;
  const fmt = formato ?? ((n: number) => n.toLocaleString('es-CO'));
  const { tope, guias } = escalaY(Math.max(1, ...valores, guia?.v ?? 0));
  const geo = geometriaEje(fluido, ancho, etiquetas, 20, angosto);
  const { grupo, x0, W } = geo;
  const x = (i: number) => x0 + grupo * i + grupo / 2;
  const y = (v: number) => Y0 - (ALTO * v) / tope;
  const largo = (i: number) => titulosTip?.[i] ?? etiquetas[i];
  const tramos = (v: (number | null)[]) => {
    const out: string[] = [];
    let actual: string[] = [];
    v.forEach((val, i) => {
      if (val === null || val === undefined) { if (actual.length) out.push(actual.join(' ')); actual = []; return; }
      actual.push(`${actual.length ? 'L' : 'M'}${x(i).toFixed(1)} ${y(val).toFixed(1)}`);
    });
    if (actual.length) out.push(actual.join(' '));
    return out;
  };
  const resumen = series.map((s) => {
    const conValor = s.v.map((v, i) => (v === null ? null : `${largo(i)} ${fmt(v)}`)).filter(Boolean);
    return `${s.t}: ${conValor.join(', ')}`;
  }).join('. ');
  return (
    <div className="grafico" data-kit="linea" data-fluido={fluido || undefined} {...cajaProps}>
      <MarcoEje geo={geo} fluido={fluido} guias={guias} y={y} svg={svg} titulo={titulo}
        etiquetaSvg={`${titulo}. ${resumen}${guia ? `. ${guia.t}: ${fmt(guia.v)}` : ''}`}>
        {guia && (
          <line x1={geo.desliza ? 0 : x0} x2={W} y1={y(guia.v)} y2={y(guia.v)} stroke={SERIE_KIT.tinta} strokeWidth="1.5" strokeDasharray="4 4">
            <title>{`${guia.t}: ${fmt(guia.v)}`}</title>
          </line>
        )}
        <RotulosX geo={geo} fluido={fluido} etiquetas={etiquetas} x={x} />
        {series.map((s, j) => (
          <g key={s.t}>
            {tramos(s.v).map((d, k) => (
              <path key={k} d={d} fill="none" stroke={s.c} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round"
                strokeDasharray={s.punteada ? '6 6' : undefined} />
            ))}
            {s.v.map((v, i) => (v === null ? null : (
              <Marcador key={i} forma={FORMAS[j % FORMAS.length]} cx={x(i)} cy={y(v)} c={s.c} activo={tip?.i === i} />
            )))}
          </g>
        ))}
        {tip && <line x1={x(tip.i)} x2={x(tip.i)} y1={Y0 - ALTO} y2={Y0} className="grafico__foco" />}
        {etiquetas.map((e, i) => {
          const filas = series.flatMap((s, j) => (s.v[i] === null || s.v[i] === undefined ? [] : [
            { t: s.t, c: s.c, forma: FORMAS[j % FORMAS.length], valor: fmt(s.v[i] as number) },
          ]));
          const pico = Math.max(...series.map((s) => s.v[i] ?? 0));
          return (
            <rect key={`col-${i}`} x={x0 + grupo * i} y={Y0 - ALTO} width={grupo} height={ALTO} className="grafico__columna"
              data-etiqueta={e} {...columna(i, () => mostrar(i, x(i), y(pico), W, largo(i), filas))} />
          );
        })}
      </MarcoEje>
      <TipGrafico tip={tip} />
      <ul className="leyenda">
        {series.map((s, j) => (
          <li key={s.t}><i data-forma={FORMAS[j % FORMAS.length]} style={{ background: s.c }} />{s.t}{s.punteada ? ' (punteada)' : ''}</li>
        ))}
        {guia && <li><i style={{ background: SERIE_KIT.tinta }} />{guia.t}</li>}
      </ul>
    </div>
  );
}
