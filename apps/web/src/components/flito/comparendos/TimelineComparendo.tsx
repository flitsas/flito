// FLITO — Comparendos: el historial del comparendo (HU #11562, AC2).
//
// Tres reglas y las tres son sobre lo que este componente NO hace:
//
//   1. **No itera `Object.entries(detalle)`.** `detalle` es una columna JSONB y el API la proyecta
//      por lista blanca de `origen` y `motivo` (RN-35); aquí se enumeran las MISMAS dos claves. Con
//      un `entries()`, cualquier clave que un proceso futuro escriba en esa columna se pintaría
//      sola en pantalla sin que nadie lo hubiera decidido — y este módulo trata datos personales.
//   2. **No deja huecos.** Un `tipo` que el navegador no conoce —porque el backend añadió uno y la
//      pestaña lleva una semana abierta— se pinta con su valor crudo y tono neutro. Un evento sin
//      `detalle`, o con un `detalle` de claves que no están en la lista, se pinta igual: su
//      etiqueta y su fecha. Un timeline con huecos es peor que uno con una etiqueta fea, porque el
//      hueco no se ve.
//   3. **No pliega.** Es la diferencia con `HistorialEstados`, y no es cosmética: allí el historial
//      es una consulta aparte que se paga al abrir; aquí los eventos ya vinieron dentro de la misma
//      respuesta, así que plegarlos solo escondería algo que ya está en memoria. Lo que sí hace es
//      RECORTAR a los 8 más recientes: un comparendo con años de historial deja el panel ilegible.
//
// La causal y el autor **por evento** no se pintan, y esto está decidido, no pendiente: el API
// publica del `detalle` solo `origen` y `motivo`, y `causalId`/`actorId` se guardan a propósito sin
// publicarse (hay un test del backend que lo congela). Pintarlos exigiría ampliar la lista blanca
// de RN-35 con el nombre de una persona identificable — es PII y la decisión es que no. El wireframe
// de la spec que los dibujaba se corrigió en esta HU. El «quién y cuándo» de la ÚLTIMA gestión sí
// se muestra, en la cabecera de la sección de gestión, que es de donde el AC5 lo pide y donde el
// contrato sí lo da (`gestionActualizadaEn` / `gestionActualizadaPor`).

import { useState } from 'react';
import type { ComparendoEvento, ComparendosEventoTipo } from '@operaciones/shared-types';
import StatusChip, { type ChipTone } from '../../flit/StatusChip';
import { flitBtnSecondarySm, flitBtnSecondaryStyle } from '../../flit/flitPageKit';
import { fechaHoraColombia } from './formato';

/**
 * Los cuatro tipos, su etiqueta y su tono.
 *
 * Es un `Record<ComparendosEventoTipo, …>` a propósito: el día que el contrato añada un quinto
 * tipo, este archivo **no compila** hasta que alguien le escriba su texto. Ese es el mecanismo que
 * evita que un tipo nuevo llegue a pantalla en `snake_case`; la disciplina no lo evita.
 *
 * «Dejó de reportarse» y no «Inactivado»: `inactivo` NO significa pagado, y la etiqueta es el sitio
 * más barato donde impedir esa lectura.
 */
const TIPO: Record<ComparendosEventoTipo, { etiqueta: string; tono: ChipTone }> = {
  primera_llegada: { etiqueta: 'Primera vez que se vio', tono: 'active' },
  inactivacion: { etiqueta: 'Dejó de reportarse', tono: 'draft' },
  reaparicion: { etiqueta: 'Reapareció en las fuentes', tono: 'warning' },
  gestion: { etiqueta: 'Gestión del comparendo', tono: 'success' },
};

/**
 * `detalle.motivo` legible.
 *
 * Solo se traduce el `motivo` y no el `origen`, y la asimetría tiene motivo: los valores de
 * `origen` («simit», «municipal», «ambos») ya se leen en español, mientras que los de `motivo` son
 * identificadores en `snake_case` que ningún operador tiene por qué descifrar. Lo que no esté en
 * este mapa se pinta CRUDO —nunca se oculta—: un motivo nuevo del backend es información, aunque
 * llegue fea.
 *
 * Los dos de gestión están aquí porque son también la ETIQUETA del evento: es lo único que
 * distingue «se registró una gestión» de «se retiró», y es exactamente la etiqueta legible en
 * español que pide el AC2.
 */
const MOTIVO: Record<string, string> = {
  ausente_en_todas_las_fuentes: 'ausente en todas las fuentes con cobertura completa',
  gestion_registrada: 'Gestión registrada',
  gestion_retirada: 'Gestión retirada',
};

/** Lee una clave de la lista blanca. Cualquier otra cosa —número, objeto, ausente— no es texto. */
function texto(detalle: ComparendoEvento['detalle'], clave: 'origen' | 'motivo'): string | null {
  const v = detalle?.[clave];
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

/**
 * Etiqueta y tono de un evento.
 *
 * Para `gestion`, el `motivo` MANDA sobre la etiqueta del tipo: «Gestión registrada» y «Gestión
 * retirada» son dos hechos distintos y el usuario acaba de provocar uno de los dos. Si el motivo no
 * es ninguno de los dos conocidos, queda la etiqueta genérica del tipo — sin hueco.
 */
export function rotuloEvento(e: ComparendoEvento): { etiqueta: string; tono: ChipTone } {
  // El `as … | undefined` no es defensivo por gusto: el tipo del contrato dice que la clave existe,
  // pero el valor viene de la RED. Un backend un paso por delante del navegador manda un `tipo` que
  // esta versión no conoce, y sin esto el evento se pintaría con `undefined` de etiqueta.
  const base = TIPO[e.tipo] as { etiqueta: string; tono: ChipTone } | undefined;
  if (!base) return { etiqueta: e.tipo, tono: 'neutral' };
  if (e.tipo !== 'gestion') return base;
  const motivo = texto(e.detalle, 'motivo');
  const propia = motivo === 'gestion_registrada' || motivo === 'gestion_retirada'
    ? MOTIVO[motivo]
    : null;
  return { etiqueta: propia ?? base.etiqueta, tono: base.tono };
}

/** Las líneas de contexto del evento, por lista blanca. Vacío = el evento se pinta sin ellas. */
function contexto(e: ComparendoEvento): string[] {
  const lineas: string[] = [];
  const origen = texto(e.detalle, 'origen');
  if (origen) lineas.push(`Origen: ${origen}`);
  const motivo = texto(e.detalle, 'motivo');
  // En los eventos de gestión el motivo YA es la etiqueta: repetirlo debajo sería pintar dos veces
  // el mismo hecho y, encima, en `snake_case` si el mapa no lo conoce.
  if (motivo && e.tipo !== 'gestion') lineas.push(`Motivo: ${MOTIVO[motivo] ?? motivo}`);
  return lineas;
}

/** Cuántos eventos se ven sin desplegar. Con más, el panel deja de poder leerse de un vistazo. */
export const TIMELINE_VISIBLES = 8;

/**
 * Ordena del más reciente al más antiguo (AC2).
 *
 * El API ya los devuelve así, y aun así se ordena aquí: es la pantalla la que tiene que garantizar
 * el AC, y el timeline se repinta también con el cuerpo del `PATCH`. El desempate es el orden de
 * llegada —`sort` es estable en todos los motores desde ES2019— porque dos eventos escritos en la
 * misma transacción comparten `ocurridoEn` al milisegundo y ahí el orden del servidor es el bueno.
 */
function masRecientePrimero(eventos: ComparendoEvento[]): ComparendoEvento[] {
  return [...eventos].sort((a, b) => Date.parse(b.ocurridoEn) - Date.parse(a.ocurridoEn));
}

export default function TimelineComparendo({ eventos }: { eventos: ComparendoEvento[] }) {
  const [todos, setTodos] = useState(false);

  if (eventos.length === 0) {
    // El mismo texto que ya usa `HistorialEstados`: no se inventa copy para un caso que el producto
    // ya sabe nombrar. No debería pasar —todo registro nace con su `primera_llegada`— pero un panel
    // sin la sección sería un hueco sin explicación.
    return (
      <p className="text-sm" style={{ color: 'var(--flit-text-muted)' }}>Sin movimientos registrados.</p>
    );
  }

  const ordenados = masRecientePrimero(eventos);
  const ocultos = ordenados.length - TIMELINE_VISIBLES;
  const visibles = todos || ocultos <= 0 ? ordenados : ordenados.slice(0, TIMELINE_VISIBLES);

  return (
    <div className="space-y-3">
      {/* `<ol>` y no `<div>`: un lector de pantalla anuncia «lista de N elementos» y numera al
          recorrerla, que es lo que hace legible una línea de tiempo sin verla. */}
      <ol className="space-y-3" aria-label="Historial del comparendo">
        {visibles.map((e) => {
          const { etiqueta, tono } = rotuloEvento(e);
          const lineas = contexto(e);
          return (
            <li key={e.id} className="flex flex-col gap-1 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <StatusChip tone={tono}>{etiqueta}</StatusChip>
                {/* `<time>` con el instante ISO en `dateTime`: lo legible va en el texto y lo
                    exacto en el atributo, sin pedirle al usuario que lea un ISO-8601. */}
                <time dateTime={e.ocurridoEn} className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
                  {fechaHoraColombia(e.ocurridoEn)}
                </time>
              </div>
              {lineas.map((linea) => (
                <p key={linea} className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{linea}</p>
              ))}
            </li>
          );
        })}
      </ol>

      {ocultos > 0 && !todos && (
        <button
          type="button"
          className={flitBtnSecondarySm}
          style={flitBtnSecondaryStyle}
          onClick={() => setTodos(true)}
        >
          {`Ver los ${ocultos} anteriores`}
        </button>
      )}
    </div>
  );
}
