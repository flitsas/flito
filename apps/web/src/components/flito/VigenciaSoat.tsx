// FLITO — Las dos superficies de la vigencia del SOAT frente al RUNT (HU #12097, Feature #12075).
//
// Salen de `pages/FlitoSoat.tsx` porque esa página cruzó el techo de `max-lines` (800 contables) y
// porque el reparto ya estaba hecho a medias: la lógica de decisión vive desde el principio en
// `lib/vigenciaSoatCola.ts`, función pura y probada con la fecha inyectada. Lo que quedaba en la
// página era presentación, y es lo que hay aquí. **Este archivo no decide nada**: no compara
// fechas, no deriva `vencido` y no mira el `estado` para elegir texto. Si alguna vez se ve un `if`
// sobre `vigencia.estado` en este archivo, la regla de precedencia —manda `verificadaEn`, no
// `estado`— se estará resolviendo en dos sitios, que es exactamente el fallo que la HU persigue.
//
// Las dos van detrás de `!esCliente` en quien las usa: son el estado de un proceso INTERNO de
// FLITO. El backend ya le quita el campo y le ignora el filtro; la pantalla no se apoya en eso.

import { FILTROS_VIGENCIA_COLA, esFiltroVigenciaCola, type FiltroVigenciaCola } from '@operaciones/shared-types';
import StatusChip from '../flit/StatusChip';
import { flitInp } from '../flit/flitPageKit';
import { pintarVigenciaSoat, type VigenciaSoatCola } from '../../lib/vigenciaSoatCola';

/**
 * La vigencia dentro de la celda «Estado» de la cola (AC1 y AC3).
 *
 * Va DENTRO de esa celda y no en una columna propia: la tabla sigue en 10/9/10 columnas, que es el
 * centinela que dejaron escrito la HU #11905 y la #11906 para que no vuelva el desborde a 1280 px.
 *
 * Devuelve `null` —nada, ni un «—»— cuando la fila no entra en la verificación diaria. Los tres
 * «vacíos por dato» de esta celda se distinguen SIN LEER: nada (sin comprobante), una línea gris
 * (nunca ha habido respuesta) y una pastilla azul con su línea (hoy se intentó y no salió).
 *
 * **Ninguna acción**: el chip es un `<span>` y la línea es texto, así que la fila no gana ni una
 * parada de tabulador. No hay «verificar ahora» y el dato no se edita (AC4, RN-D1): la verificación
 * es del proceso de las 00:10, con su candado y sus reintentos, y un botón que la disparara a mano
 * convertiría eso en N consultas sin control a un registro nacional.
 *
 * Sin `title`: no lo ve quien navega con teclado ni quien está en una tableta, y el AC1 dice que la
 * fila MUESTRA la fecha. La absoluta con hora vive en el modal.
 */
export function CeldaVigenciaSoat({ vigencia }: { vigencia?: VigenciaSoatCola | null }) {
  const pintada = pintarVigenciaSoat(vigencia);
  if (!pintada) return null;
  return (
    <>
      {pintada.chip && <StatusChip tone={pintada.chip.tono}>{pintada.chip.etiqueta}</StatusChip>}
      {/* Sin color propio: el dato viejo se lee en el texto, y teñirlo sería otro criterio que
          depende del color — justo lo que el AC3 combate. */}
      <span className="text-xs tabular-nums" style={{ color: 'var(--flit-text-muted)' }}>{pintada.linea}</span>
    </>
  );
}

/**
 * Los rótulos de las tres opciones del filtro (AC2).
 *
 * `Record<FiltroVigenciaCola, string>` y no una lista de literales: el día que el vocabulario
 * compartido gane un cuarto valor, esto no compila — que es justo lo que se quiere, porque una
 * opción sin rótulo se pintaría como un nombre de columna.
 *
 * **Dos de los tres dicen exactamente lo mismo que su chip** para no obligar a traducir en cada
 * barrido. El tercero, «Sin verificar», nombra al CONJUNTO y no a uno de sus miembros: esa lista
 * trae a la vez las filas que dicen «No se pudo consultar» y las que dicen «Sin verificar», así que
 * llamarla «No se pudo consultar» sería falso para la mitad de lo que devuelve. Es además la
 * palabra que usa el AC2.
 */
const VIGENCIA_FILTRO_LABEL: Record<FiltroVigenciaCola, string> = {
  vencido: 'Vencido',
  sin_registro: 'Sin SOAT en el RUNT',
  no_verificado: 'Sin verificar',
};

/**
 * El filtro «Vigencia» de la barra (AC2). **Uno**, no tres chips: la barra ya lleva nueve controles.
 *
 * Calcado del `select` de «Gestiona» que está justo al lado —mismo `<label>` envolvente con el
 * rótulo visible, que es además su nombre accesible, mismo `flitInp`, mismo `max-w`—: cero patrones
 * nuevos. Las tres opciones son excluyentes por construcción, que es lo que hace verdadero el
 * «cada uno devuelve exactamente su conjunto» del AC2.
 *
 * Lo que sale por `onCambio` es el valor MÁQUINA validado con la guarda compartida, nunca el rótulo
 * visible: el esquema del endpoint es `.strict()`, así que mandar «Vencido» no sería un filtro
 * ignorado sino un 400. Un valor desconocido se degrada a «Cualquiera» en vez de viajar.
 */
export function FiltroVigenciaSoat({ valor, onCambio }: {
  valor: '' | FiltroVigenciaCola; onCambio: (v: '' | FiltroVigenciaCola) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-xs font-semibold" style={{ color: 'var(--flit-text-secondary)' }}>
      Vigencia
      <select className={`${flitInp} max-w-[11rem]`} value={valor}
        onChange={(e) => onCambio(esFiltroVigenciaCola(e.target.value) ? e.target.value : '')}>
        <option value="">Cualquiera</option>
        {FILTROS_VIGENCIA_COLA.map((v) => (
          <option key={v} value={v}>{VIGENCIA_FILTRO_LABEL[v]}</option>
        ))}
      </select>
    </label>
  );
}
