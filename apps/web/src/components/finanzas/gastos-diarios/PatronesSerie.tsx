// Los cinco patrones de relleno de la gráfica de Gastos diarios (HU #12625, AC1): el color es
// secundario y cada categoría se distingue también sin él —sólido, rayas, puntos, líneas, cruz—
// además del rótulo. Se trazan con `var(--flit-serie-*)`, que sigue el tema; ningún hex aquí.
// Van en un `<defs>` del svg de la gráfica; la leyenda los referencia por `url(#…)`.

import { CATEGORIAS, type GastosDiariosCategoria, type PatronSerie } from './tiposGastosDiarios';

export const idPatron = (clave: GastosDiariosCategoria) => `gastos-patron-${clave}`;
export const colorSerie = (token: string) => `var(${token})`;

const LADO = 8;

/** El trazo de cada patrón, en una celda de 8×8 que se repite. */
function Trazo({ patron, color }: { patron: PatronSerie; color: string }) {
  switch (patron) {
    case 'solido':
      return <rect width={LADO} height={LADO} fill={color} />;
    case 'rayas':
      // Diagonal con sus dos esquinas para que la celda encaje al repetirse.
      return <path d={`M0 ${LADO} L${LADO} 0 M-2 2 L2 -2 M${LADO - 2} ${LADO + 2} L${LADO + 2} ${LADO - 2}`} stroke={color} strokeWidth={3} fill="none" />;
    case 'puntos':
      return (
        <>
          <circle cx={2} cy={2} r={1.8} fill={color} />
          <circle cx={6} cy={6} r={1.8} fill={color} />
        </>
      );
    case 'lineas':
      return <rect width={LADO} height={3} y={1} fill={color} />;
    case 'cruz':
      return <path d={`M0 4 H${LADO} M4 0 V${LADO}`} stroke={color} strokeWidth={2} fill="none" />;
  }
}

export default function PatronesSerie() {
  return (
    <defs>
      {CATEGORIAS.map((c) => (
        <pattern key={c.clave} id={idPatron(c.clave)} patternUnits="userSpaceOnUse" width={LADO} height={LADO}>
          <Trazo patron={c.serie.patron} color={colorSerie(c.serie.token)} />
        </pattern>
      ))}
    </defs>
  );
}
