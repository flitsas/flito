// Selector de rango de fechas en un solo calendario (HU #11026).
//
// Sustituye a los pares de `<input type="date">` que había en el reporte de costos y en las colas de
// SOAT e impuestos. Dos campos sueltos obligan a abrir dos veces el calendario del navegador y a
// acordarse de cuál era cuál; aquí se marca inicio y fin sobre la misma vista y se ve el tramo
// pintado, que es como se piensa un rango.
//
// Sin dependencias: el frontend solo trae pdfjs, tesseract y react-router, y añadir una librería de
// calendarios para esto no se sostiene. Es un `<details>`, el mismo patrón de ThFiltroMulti: el
// navegador ya resuelve abrir, cerrar y el foco por teclado.
//
// Las fechas se manejan SIEMPRE como 'yyyy-mm-dd' en texto, nunca como Date. Construir un Date desde
// 'yyyy-mm-dd' lo interpreta como medianoche UTC y en Colombia (UTC−5) retrocede un día: el mismo
// fallo que ya costó una corrección en la tabla de derechos.

import { useMemo, useState } from 'react';

export interface Rango {
  desde: string;
  hasta: string;
}

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const DIAS = ['lu', 'ma', 'mi', 'ju', 'vi', 'sá', 'do'];

const iso = (y: number, m: number, d: number): string =>
  `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/** Hoy en local, sin pasar por UTC. */
function hoyIso(): string {
  const n = new Date();
  return iso(n.getFullYear(), n.getMonth(), n.getDate());
}

/** Desplaza una fecha ISO n días, en el calendario local. */
function sumarDias(base: string, n: number): string {
  const [y, m, d] = base.split('-').map(Number);
  const f = new Date(y, m - 1, d + n);
  return iso(f.getFullYear(), f.getMonth(), f.getDate());
}

/** '2026-07-28' → '28 jul 2026'. A mano, para que el día no se mueva de zona horaria. */
function bonita(v: string): string {
  const [y, m, d] = v.split('-');
  return `${Number(d)} ${MESES[Number(m) - 1].slice(0, 3)} ${y}`;
}

/** Lunes de la semana en que cae el día 1, para cuadrar la rejilla. */
function huecoInicial(y: number, m: number): number {
  const dia = new Date(y, m, 1).getDay(); // 0 = domingo
  return (dia + 6) % 7;
}

const diasDelMes = (y: number, m: number): number => new Date(y, m + 1, 0).getDate();

export default function RangoFechas({ etiqueta, valor, onCambio }: {
  etiqueta: string;
  valor: Rango;
  onCambio: (r: Rango) => void;
}) {
  const hoy = hoyIso();
  // El mes que se ve al abrir: el del inicio elegido, o el actual.
  const [ancla, setAncla] = useState(() => {
    const base = valor.desde || hoy;
    const [y, m] = base.split('-').map(Number);
    return { y, m: m - 1 };
  });

  const celdas = useMemo(() => {
    const total = diasDelMes(ancla.y, ancla.m);
    const hueco = huecoInicial(ancla.y, ancla.m);
    return [
      ...Array.from({ length: hueco }, () => null),
      ...Array.from({ length: total }, (_, i) => iso(ancla.y, ancla.m, i + 1)),
    ];
  }, [ancla]);

  /**
   * Un clic decide solo. Sin inicio, o con el rango ya cerrado, empieza uno nuevo; con inicio puesto
   * lo cierra. Y si el segundo clic cae antes del primero, se invierten en vez de rechazarlo: quien
   * marca al revés está señalando el mismo tramo.
   */
  function elegir(d: string) {
    if (!valor.desde || valor.hasta) { onCambio({ desde: d, hasta: '' }); return; }
    onCambio(d < valor.desde ? { desde: d, hasta: valor.desde } : { desde: valor.desde, hasta: d });
  }

  const dentro = (d: string) => valor.desde && valor.hasta && d >= valor.desde && d <= valor.hasta;
  const extremo = (d: string) => d === valor.desde || d === valor.hasta;

  const mover = (n: number) => setAncla((a) => {
    const m = a.m + n;
    return { y: a.y + Math.floor(m / 12), m: ((m % 12) + 12) % 12 };
  });

  const atajos: Array<[string, Rango]> = [
    ['Hoy', { desde: hoy, hasta: hoy }],
    ['7 días', { desde: sumarDias(hoy, -6), hasta: hoy }],
    ['30 días', { desde: sumarDias(hoy, -29), hasta: hoy }],
    ['Este mes', { desde: hoy.slice(0, 8) + '01', hasta: hoy }],
  ];

  const resumen = valor.desde
    ? `${bonita(valor.desde)}${valor.hasta ? ` → ${bonita(valor.hasta)}` : ' → …'}`
    : 'Cualquier fecha';

  return (
    // `name` agrupa todos los rangos de la pantalla: abrir uno cierra el otro, que si no se
    // solapan. Es progresivo — en un navegador que no lo soporte quedan los dos abiertos, que es
    // el comportamiento de siempre, no un fallo.
    <details className="relative" name="flit-rango-fechas">
      <summary
        className="flex h-10 cursor-pointer list-none items-center gap-2 rounded-lg border bg-white px-3 text-sm"
        style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-primary)' }}
        aria-label={etiqueta}
      >
        <span className="text-xs font-semibold" style={{ color: 'var(--flit-text-muted)' }}>{etiqueta}</span>
        <span className="tabular-nums">{resumen}</span>
      </summary>

      <div className="absolute z-30 mt-1 w-72 rounded-lg border bg-white p-3 shadow-lg"
        style={{ borderColor: 'var(--flit-border-input)' }}>
        <div className="mb-2 flex flex-wrap gap-1">
          {atajos.map(([txt, r]) => (
            <button key={txt} type="button" onClick={() => onCambio(r)}
              className="rounded-full border px-2 py-0.5 text-[11px]"
              style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-blue-text)' }}>
              {txt}
            </button>
          ))}
        </div>

        <div className="mb-1 flex items-center justify-between">
          <button type="button" aria-label="Mes anterior" className="px-2 text-sm" onClick={() => mover(-1)}>←</button>
          <span className="text-sm font-semibold">{MESES[ancla.m]} {ancla.y}</span>
          <button type="button" aria-label="Mes siguiente" className="px-2 text-sm" onClick={() => mover(1)}>→</button>
        </div>

        <div className="grid grid-cols-7 gap-0.5 text-center text-[10px]" style={{ color: 'var(--flit-text-muted)' }}>
          {DIAS.map((d) => <span key={d}>{d}</span>)}
        </div>
        <div className="grid grid-cols-7 gap-0.5">
          {celdas.map((d, i) => d === null
            ? <span key={`h${i}`} />
            : (
              <button key={d} type="button" onClick={() => elegir(d)}
                aria-label={d}
                aria-pressed={extremo(d) || undefined}
                className="rounded py-1 text-xs tabular-nums"
                style={{
                  backgroundColor: extremo(d) ? 'var(--flit-blue-text)' : dentro(d) ? 'var(--flit-blue-soft, #e8f0fe)' : undefined,
                  color: extremo(d) ? '#fff' : 'var(--flit-text-primary)',
                  fontWeight: d === hoy ? 700 : 400,
                }}>
                {Number(d.slice(8))}
              </button>
            ))}
        </div>

        {valor.desde && (
          <button type="button" className="mt-2 w-full text-xs underline"
            style={{ color: 'var(--flit-text-muted)' }}
            onClick={() => onCambio({ desde: '', hasta: '' })}>
            Quitar el rango
          </button>
        )}
      </div>
    </details>
  );
}
