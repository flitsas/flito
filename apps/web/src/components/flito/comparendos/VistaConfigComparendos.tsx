// FLITO — Comparendos: la vista de Configuración (HU #11633 AC1/AC3/AC4/AC5, HU #11634 AC1–AC4).
//
// Una pila de tarjetas, cada una con su petición, su estado y su reintento. El orden es el de la
// spec de UX y va de lo más operativo a lo más sensible:
//
//   1. NITs monitoreados — a quién se le pregunta.
//   2. Municipios fuente — dónde, además de SIMIT.
//   3. Causales de gestión — con qué se cierra cada comparendo en el visor.
//   4. Token SIMIT — la credencial, al final por lo mismo que en cualquier ficha: es lo que menos se
//      toca y lo que más cuesta si se toca mal.
//
// Los cuatro están montados desde la HU #11634. El orden lo dejó escrito la #11633 y se respeta tal
// cual: los bloques nuevos se insertaron donde les tocaba, no al final.
//
// Este componente no tiene estado propio: es la columna. Todo lo que se puede tocar vive dentro de
// cada bloque, que es lo que hace que un 500 de municipios no se lleve por delante la tabla de NITs
// —ni el catálogo de causales el estado del token—: cada bloque tiene su propia petición.

import CausalesComparendos from './CausalesComparendos';
import MunicipiosComparendos from './MunicipiosComparendos';
import NitsComparendos from './NitsComparendos';
import TokenSimitComparendos from './TokenSimitComparendos';
import { MarcoComparendos, type NavComparendos } from './navegacionComparendos';

export default function VistaConfigComparendos({ nav }: { nav: NavComparendos }) {
  return (
    <MarcoComparendos nav={nav}>
      <NitsComparendos />
      <MunicipiosComparendos />
      <CausalesComparendos />
      <TokenSimitComparendos />
    </MarcoComparendos>
  );
}
