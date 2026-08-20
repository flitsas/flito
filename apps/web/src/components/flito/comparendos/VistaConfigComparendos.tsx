// FLITO — Comparendos: la vista de Configuración (HU #11633, AC1, AC3, AC4 y AC5).
//
// Una pila de tarjetas, cada una con su petición, su estado y su reintento. El orden es el de la
// spec de UX y va de lo más operativo a lo más sensible:
//
//   1. NITs monitoreados — a quién se le pregunta.
//   2. Municipios fuente — dónde, además de SIMIT.
//   3. Causales de gestión — HU #11634.
//   4. Token SIMIT — HU #11634.
//
// Los bloques 3 y 4 **todavía no se montan**, y no se deja un hueco ni un «próximamente» por cada
// uno: una tarjeta vacía con el título de algo que no funciona invita a pulsarla. Lo que sí queda
// escrito es el orden, para que la HU #11634 los inserte donde van y no al final.
//
// Este componente no tiene estado propio: es la columna. Todo lo que se puede tocar vive dentro de
// cada bloque, que es lo que hace que un 500 de municipios no se lleve por delante la tabla de NITs
// (el `useCatalogoConfig` de cada uno es independiente).

import MunicipiosComparendos from './MunicipiosComparendos';
import NitsComparendos from './NitsComparendos';
import { MarcoComparendos, type NavComparendos } from './navegacionComparendos';

export default function VistaConfigComparendos({ nav }: { nav: NavComparendos }) {
  return (
    <MarcoComparendos nav={nav}>
      <NitsComparendos />
      <MunicipiosComparendos />
    </MarcoComparendos>
  );
}
