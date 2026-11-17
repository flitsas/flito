/**
 * Gráficos del UI Kit 2026 («Uso de gráficos»): dona de 132 px con total y leyenda en lista, y barras agrupadas con
 * guías punteadas, ejes y leyenda. Colores de la paleta del manual vía `SERIE_KIT` (tokens), nunca hex en páginas.
 */
import { useEffect, useRef, useState, type PointerEvent as EventoPuntero } from 'react';

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

export function BarrasGrupo({ etiquetas, series, titulo }: { etiquetas: string[]; series: SerieBarras[]; titulo: string }) {
  const max = Math.max(1, ...series.flatMap((s) => s.v));
  const paso = max <= 10 ? 2 : max <= 25 ? 5 : max <= 100 ? 10 : Math.pow(10, Math.floor(Math.log10(max)));
  const tope = Math.ceil(max / paso) * paso;
  const W = 560, y0 = 214, alto = 190, x0 = 34;
  const grupo = (W - x0 - 8) / Math.max(1, etiquetas.length);
  const bw = Math.min(46, (grupo - 24) / Math.max(1, series.length));
  const guias: number[] = [];
  for (let t = 0; t <= tope; t += paso) guias.push(t);
  const { svg, tip, mostrar, columna, cajaProps } = useTipGrafico();
  const resumen = series.map((s) => `${s.t}: ${etiquetas.map((e, i) => `${e} ${s.v[i] ?? 0}`).join(', ')}`).join('. ');
  return (
    <div className="grafico" data-kit="barras" {...cajaProps}>
      <svg ref={svg} viewBox={`0 0 ${W} 250`} role="img" aria-label={`${titulo}. ${resumen}`}>
        {guias.map((t) => {
          const y = y0 - (alto * t) / tope;
          return (
            <g key={t}>
              <line x1={x0} x2={W} y1={y} y2={y} className="grafico__guia" />
              <text x={x0 - 8} y={y + 4} textAnchor="end" className="grafico__eje">{t}</text>
            </g>
          );
        })}
        {etiquetas.map((e, i) => {
          const ini = x0 + grupo * i + (grupo - bw * series.length - 3 * (series.length - 1)) / 2;
          return (
            <g key={e}>
              {series.map((s, j) => {
                const h = (alto * (s.v[i] ?? 0)) / tope;
                return <rect key={s.t} x={ini + j * (bw + 3)} y={y0 - h} width={bw} height={h} rx="3" fill={s.c} />;
              })}
              <text x={x0 + grupo * i + grupo / 2} y={y0 + 18} textAnchor="middle" className="grafico__eje">{e}</text>
              <rect x={x0 + grupo * i} y={y0 - alto} width={grupo} height={alto} className="grafico__columna" data-etiqueta={e}
                {...columna(i, () => mostrar(i, x0 + grupo * i + grupo / 2,
                  y0 - (alto * Math.max(...series.map((s) => s.v[i] ?? 0))) / tope, W, e,
                  series.map((s) => ({ t: s.t, c: s.c, valor: String(s.v[i] ?? 0) }))))} />
            </g>
          );
        })}
      </svg>
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
 * discontinua de tinta (la meta) que se nombra en la leyenda. Colores solo por `SERIE_KIT`.
 */
export function LineaTendencia({ etiquetas, series, titulo, guia, formato, vacio = 'Sin datos en el periodo' }: {
  etiquetas: string[]; series: SerieLinea[]; titulo: string; guia?: { v: number; t: string };
  formato?: (n: number) => string; vacio?: string;
}) {
  const angosto = useAnchoAngosto();
  const { svg, tip, mostrar, columna, cajaProps } = useTipGrafico();
  const valores = series.flatMap((s) => s.v.filter((x): x is number => x !== null));
  if (etiquetas.length === 0 || valores.length === 0) return <p className="grafico-vacio">{vacio}</p>;
  const fmt = formato ?? ((n: number) => n.toLocaleString('es-CO'));
  const max = Math.max(1, ...valores, guia?.v ?? 0);
  const paso = max <= 10 ? 2 : max <= 25 ? 5 : max <= 100 ? 10 : Math.pow(10, Math.floor(Math.log10(max)));
  const tope = Math.ceil(max / paso) * paso;
  const W = 560, y0 = 214, alto = 190, x0 = 34;
  const grupo = (W - x0 - 8) / Math.max(1, etiquetas.length);
  const x = (i: number) => x0 + grupo * i + grupo / 2;
  const y = (v: number) => y0 - (alto * v) / tope;
  const guias: number[] = [];
  for (let t = 0; t <= tope; t += paso) guias.push(t);
  const saltar = angosto && etiquetas.length > 8;
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
    const conValor = s.v.map((v, i) => (v === null ? null : `${etiquetas[i]} ${fmt(v)}`)).filter(Boolean);
    return `${s.t}: ${conValor.join(', ')}`;
  }).join('. ');
  return (
    <div className="grafico" data-kit="linea" {...cajaProps}>
      <svg ref={svg} viewBox={`0 0 ${W} 250`} role="img" aria-label={`${titulo}. ${resumen}${guia ? `. ${guia.t}: ${fmt(guia.v)}` : ''}`}>
        {guias.map((t) => (
          <g key={t}>
            <line x1={x0} x2={W} y1={y(t)} y2={y(t)} className="grafico__guia" />
            <text x={x0 - 8} y={y(t) + 4} textAnchor="end" className="grafico__eje">{t}</text>
          </g>
        ))}
        {guia && (
          <line x1={x0} x2={W} y1={y(guia.v)} y2={y(guia.v)} stroke={SERIE_KIT.tinta} strokeWidth="1.5" strokeDasharray="4 4">
            <title>{`${guia.t}: ${fmt(guia.v)}`}</title>
          </line>
        )}
        {etiquetas.map((e, i) => (saltar && i % 2 === 1 ? null : (
          <text key={`${e}-${i}`} x={x(i)} y={y0 + 18} textAnchor="middle" className="grafico__eje">{e}</text>
        )))}
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
        {tip && <line x1={x(tip.i)} x2={x(tip.i)} y1={y0 - alto} y2={y0} className="grafico__foco" />}
        {etiquetas.map((e, i) => {
          const filas = series.flatMap((s, j) => (s.v[i] === null || s.v[i] === undefined ? [] : [
            { t: s.t, c: s.c, forma: FORMAS[j % FORMAS.length], valor: fmt(s.v[i] as number) },
          ]));
          const pico = Math.max(...series.map((s) => s.v[i] ?? 0));
          return (
            <rect key={`col-${i}`} x={x0 + grupo * i} y={y0 - alto} width={grupo} height={alto} className="grafico__columna"
              data-etiqueta={e} {...columna(i, () => mostrar(i, x(i), y(pico), W, e, filas))} />
          );
        })}
      </svg>
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
