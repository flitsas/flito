// FLITO comparendos — gestión de un comparendo: causal y observación (Feature #11495 17b,
// HU #11557, CF-05).
//
// Es el ÚNICO archivo del módulo que escribe en `flito_comparendos_registros` fuera del sync, y
// existe aparte de `flito-comparendos.registros.service.ts` a propósito: aquel es la lectura del
// consolidado y su cabecera promete, en su primera línea, que **no hay ni un INSERT, ni un UPDATE,
// ni un DELETE** en él. Esa promesa es lo que hace evidente de un vistazo que los campos de fuente
// no se editan desde el API (RN-04), y meter aquí el PATCH la borraría: quien abriera el archivo de
// lectura tendría que leerse un `UPDATE` entero para comprobar qué columnas toca.
//
// ── Reglas de negocio ────────────────────────────────────────────────────────────────────────────
//
// RN-37  **Solo `causal_id` y `observacion`.** Todo lo demás de la fila es dato de FUENTE —lo
//        escribe el sync leyendo a Verifik y a los UTS municipales— y no se edita (RN-04, CF-09).
//        Este servicio no recibe siquiera los otros campos: su entrada es un objeto de dos claves
//        y el `set()` que construye no puede nombrar una tercera. Lo único que toca además son las
//        dos columnas de auditoría de la gestión y `updated_at`, que no son dato de nadie.
//
// RN-38  **Gestionar SIEMPRE deja escrito quién y cuándo**, incluso cuando lo que se gestiona es
//        vaciar los dos campos. Limpiar una causal es una decisión igual que ponerla, y una fila
//        que vuelve a «sin gestión» sin dejar rastro sería indistinguible de una que nadie tocó
//        jamás. Por eso `gestion_actualizada_en` y `gestion_actualizada_por` se escriben en el
//        mismo `set()` que los campos, nunca condicionadas a que el valor nuevo no sea `null`; el
//        `CHECK` de la migración 0156 lo sostiene desde la base («o las dos puestas o las dos
//        nulas»).
//
// RN-39  **Cada PATCH deja un evento `gestion` en el timeline, con `sync_run_id` en `NULL`.** La
//        fila lleva el estado actual y el timeline lleva la historia (misma figura que `estado` /
//        `inactivado_en` con los eventos de inactivación, migración 0154). El `NULL` no es una
//        casilla sin rellenar: este evento no lo produce ninguna corrida, y además es lo que hace
//        que dos gestiones seguidas quepan bajo el único `(registro_id, tipo, sync_run_id)` —en
//        PostgreSQL dos `NULL` no son iguales entre sí, así que el índice no los ve como
//        duplicados—. De ahí que este INSERT NO lleve `onConflictDoNothing()`: el del sync lo lleva
//        porque re-ejecutar una corrida SÍ repetiría la tupla, y aquí tragarse un conflicto que no
//        puede ocurrir solo serviría para que el día que alguien pusiera ese índice en
//        `NULLS NOT DISTINCT` los eventos dejaran de escribirse en silencio.
//
// RN-40  **Una causal inexistente es 422 siempre; una desactivada, solo si se está CAMBIANDO a
//        ella.** El catálogo se puede desactivar (CF-04) y hay comparendos clasificados hace meses
//        con una causal que hoy ya no se ofrece. Rechazar el PATCH de quien solo venía a escribir
//        una observación sobre uno de ellos —porque el formulario reenvía la causal que la fila ya
//        tenía— sería obligarle a reclasificar lo que no venía a reclasificar, o a perder lo
//        escrito. La comparación es contra la causal que la fila tiene EN ESE MOMENTO, leída dentro
//        de la misma transacción y con la fila bloqueada.
//        La FILA se bloquea; la CAUSAL del catálogo se lee sin bloqueo, y eso está aceptado a
//        conciencia: entre la comprobación y el COMMIT cabe un `PATCH /causales/:id` que la
//        desactive, y el resultado sería un comparendo con una causal recién retirada. Bajo esta
//        misma RN eso es un estado LEGÍTIMO —el catálogo se desactiva sin tocar lo ya clasificado—,
//        así que lo que se ganaría con un `FOR SHARE` sobre el catálogo es evitar un estado que el
//        módulo admite por diseño, a cambio de que cada gestión bloquee una fila que leen todas las
//        demás. No compensa.
//
// RN-41  **La observación no sale de la columna.** Es el único texto libre que este módulo acepta,
//        lo escribe una persona mirando un caso concreto y puede contener lo que a esa persona le
//        parezca relevante —un nombre, un teléfono, el número de un radicado—. Así que no va al
//        log de la aplicación (`pino`), ni al `detail` de `audit_logs`, ni al `detalle` del evento
//        del timeline: de la gestión se registra QUE ocurrió y sobre qué campos, nunca el texto.
//        Lo que se responde al cliente es lo que él mismo acaba de mandar, y sale con
//        `Cache-Control: no-store` porque el registro que lo envuelve lleva NIT y placa.

import { eq } from 'drizzle-orm';
import type { ComparendoRegistroDetalle, ComparendosGestionPatch } from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import {
  flitoComparendosCausales,
  flitoComparendosEventos,
  flitoComparendosRegistros,
} from '../../db/schema.js';
import {
  ComparendosCausalInvalidaError,
  ComparendosNoEncontradoError,
} from './flito-comparendos.errors.js';
import { obtenerRegistro } from './flito-comparendos.registros.service.js';

/**
 * Qué campos tocó la petición. Se guarda en el evento (sin los valores) porque es lo que responde
 * «¿esta gestión cambió la clasificación o solo añadió una nota?» sin tener que comparar filas.
 */
type CampoGestion = 'causal' | 'observacion';

/**
 * Qué fue el acto, en el vocabulario CERRADO que publica el timeline.
 *
 * Va en `motivo` porque es una de las dos claves que el API proyecta del `detalle` (RN-35), y son
 * dos valores y no seis (uno por combinación de campos) porque lo que el timeline tiene que contar
 * es si sobre este comparendo se REGISTRÓ algo o se RETIRÓ lo que había; el desglose por campo va
 * al lado, en `campos`.
 */
type MotivoGestion = 'gestion_registrada' | 'gestion_retirada';

/**
 * Contexto del evento de gestión.
 *
 * **Nunca lleva la observación** (RN-41) ni ningún dato de fuente (RN-20): ni NIT, ni placa, ni
 * nada del proveedor. Lo que sí lleva, y hoy el API no publica, es el `causalId` que se puso y el
 * `actorId` que lo puso — `flito_comparendos_eventos` no tiene columna de autor y no tiene GRANT de
 * `UPDATE` ni de `DELETE` (migración 0150), así que esta es la única copia del «quién» que sobrevive
 * a la siguiente gestión: la fila solo guarda al ÚLTIMO. Que se guarde y no se publique es la
 * decisión de esta HU: la lista blanca de RN-35 sigue siendo `origen` y `motivo`, y ampliarla es una
 * decisión de la pantalla que necesite pintar la causal en el timeline, no un efecto colateral de
 * que la columna sea JSONB.
 */
interface DetalleGestion {
  motivo: MotivoGestion;
  campos: CampoGestion[];
  actorId: number;
  /** Solo cuando la petición tocó la causal. `null` = se retiró. */
  causalId?: string | null;
}

/**
 * Asigna o retira la causal y la observación de un comparendo, y deja el rastro de los dos sitios
 * (la fila y el timeline).
 *
 * Todo ocurre en UNA transacción: comprobar que el comparendo existe, comprobar que la causal sirve,
 * escribir la fila, escribir el evento y LEER lo que se devuelve. No es ceremonia — es lo que
 * sostiene tres promesas: que una causal inválida **no escribe nada** (si la comprobación y el
 * UPDATE no fueran atómicos, el evento podría quedar sin su fila o al revés), que la fila y su
 * timeline no se contradicen nunca, y que un endpoint que respondió 200 dejó sus dos rastros (con la
 * lectura fuera, la purga podía borrar la fila entre el COMMIT y ella y convertir un cambio ya
 * escrito en un 404 sin bitácora).
 *
 * El `patch` llega ya validado por la ruta (`zod`): las claves son como mucho esas dos, la
 * observación cabe en `COMPARENDOS_OBSERVACION_MAX` y el `causalId` tiene forma de UUID —lo cual
 * importa aquí y no es cosmético: `causal_id` es `uuid` en PostgreSQL y comparar contra algo que no
 * lo es revienta con un `22P02`, que saldría como 500 en vez de decir qué pasó—.
 *
 * @param id       UUID del comparendo.
 * @param patch    Lo que cambió, y solo eso: una clave AUSENTE deja la columna como estaba, una
 *                 clave en `null` la vacía.
 * @param actorId  `users.id` del token. Obligatorio: la auditoría de la gestión no admite «nadie».
 * @returns El registro con su timeline ya actualizado, en la misma forma que `GET /registros/:id`.
 * @throws ComparendosNoEncontradoError   el comparendo no existe (404).
 * @throws ComparendosCausalInvalidaError la causal no existe, o está inactiva y es distinta de la
 *                                        que la fila ya tenía (422).
 */
export async function gestionarComparendo(
  id: string,
  patch: ComparendosGestionPatch,
  actorId: number,
): Promise<ComparendoRegistroDetalle> {
  const ahora = new Date();
  const campos: CampoGestion[] = [];
  if (patch.causalId !== undefined) campos.push('causal');
  if (patch.observacion !== undefined) campos.push('observacion');

  return db.transaction(async (tx) => {
    // `FOR UPDATE` sobre la fila del comparendo, y no un SELECT pelado: la comprobación de RN-40
    // compara contra la causal que la fila tiene AHORA, así que sin el bloqueo dos gestiones
    // simultáneas podrían leer las dos el estado viejo y una de ellas colar una causal inactiva
    // apoyándose en una asignación que la otra acaba de quitar. Bloquea una fila por su llave
    // primaria durante lo que dura la transacción: no compite con el sync más que en ese registro.
    const [registro] = await tx.select({
      id: flitoComparendosRegistros.id,
      causalId: flitoComparendosRegistros.causalId,
    })
      .from(flitoComparendosRegistros)
      .where(eq(flitoComparendosRegistros.id, id))
      .limit(1)
      .for('update');

    // El mismo mensaje y el mismo error que la lectura: un id que no existe y un id que existe pero
    // es de otro NIT tienen que ser indistinguibles desde fuera. La respuesta no dice de quién es el
    // comparendo ni si lo hay — enumerar por prueba y error es la forma barata de mapear un módulo
    // de datos personales.
    if (!registro) throw new ComparendosNoEncontradoError('El comparendo no existe.');

    if (patch.causalId !== undefined && patch.causalId !== null) {
      const [causal] = await tx.select({
        id: flitoComparendosCausales.id,
        activo: flitoComparendosCausales.activo,
      })
        .from(flitoComparendosCausales)
        .where(eq(flitoComparendosCausales.id, patch.causalId))
        .limit(1);

      // Inexistente: 422 siempre, aunque coincidiera con lo que la fila dice tener (que no puede
      // pasar — hay FK — pero la comprobación no depende de eso para ser correcta).
      if (!causal) throw new ComparendosCausalInvalidaError();
      // Inactiva: 422 solo si se está CAMBIANDO a ella (RN-40). Reenviar la que la fila ya tenía
      // —que es lo que hace el formulario cuando solo se edita la observación— no es cambiarla.
      if (!causal.activo && causal.id !== registro.causalId) throw new ComparendosCausalInvalidaError();
    }

    await tx.update(flitoComparendosRegistros)
      .set({
        // Las dos claves se OMITEN cuando la petición no las trae, en vez de mandarse en `null`:
        // es la diferencia entre «no lo toques» y «vacíalo», y es todo el contrato del PATCH. Un
        // `causalId: patch.causalId ?? null` borraría la causal de quien solo escribió una
        // observación, en silencio y sin que ninguna aserción sobre la respuesta se enterase.
        ...(patch.causalId !== undefined ? { causalId: patch.causalId } : {}),
        ...(patch.observacion !== undefined ? { observacion: patch.observacion } : {}),
        // Sin condicionar a nada (RN-38): gestionar es un acto, y vaciar los campos también lo es.
        gestionActualizadaEn: ahora,
        gestionActualizadaPor: actorId,
        // La fila cambió de verdad, así que su `updated_at` se mueve. No sustituye a lo de arriba
        // —el sync lo reescribe en cada corrida—, pero mentirle sería peor que no tocarlo.
        updatedAt: ahora,
      })
      .where(eq(flitoComparendosRegistros.id, id));

    await tx.insert(flitoComparendosEventos).values({
      registroId: id,
      tipo: 'gestion',
      // `NULL` por construcción y no por antigüedad de la fila: esto no lo produjo ninguna corrida
      // (RN-39). Es además lo que deja pasar dos gestiones del mismo día bajo el índice único.
      syncRunId: null,
      detalle: detalleDe(patch, campos, actorId),
    });

    // La respuesta se construye con la lectura de siempre y DENTRO de la transacción, con `tx`.
    //
    // Con la lectura de siempre porque así el cuerpo del PATCH es EXACTAMENTE el de
    // `GET /registros/:id` —misma proyección por lista blanca (RN-31), mismo `detalle` de eventos
    // por lista blanca (RN-35), mismo mapeo de fechas—, y la pantalla puede reemplazar el registro
    // del panel sin comparar formas. Reconstruir aquí el DTO sería una segunda copia de esa
    // proyección, y las dos se separarían el día que alguien añadiera una columna sensible.
    //
    // Y dentro de la transacción por una ventana que existía de verdad: leyendo después del COMMIT,
    // la purga por retención (`flito-comparendos-purga.cron.ts`) puede borrar la fila entre las dos
    // operaciones, y entonces el endpoint respondería 404 **con el cambio ya escrito** y sin haber
    // llegado a dejar ni la bitácora ni el registro de acceso — el único camino por el que la
    // promesa «gestionar deja los dos rastros» no se cumpliría. Aquí la fila está bloqueada por el
    // `FOR UPDATE` de arriba, así que no puede desaparecer, y la lectura ve el UPDATE y el evento
    // que esta misma transacción acaba de escribir: el timeline que se devuelve ya trae la gestión.
    return obtenerRegistro(id, tx);
  });
}

/**
 * El `detalle` del evento: qué se hizo, sobre qué campos y quién.
 *
 * `motivo` es `gestion_retirada` solo cuando TODO lo que la petición tocó quedó vacío; si al menos
 * un campo se quedó con contenido, lo que hubo fue un registro. Se calcula sobre lo que la petición
 * mandó y no sobre el estado final de la fila a propósito: el evento cuenta el ACTO —lo que esa
 * persona hizo en ese momento—, y el estado final ya vive en la fila, que es quien tiene que
 * contarlo.
 */
function detalleDe(
  patch: ComparendosGestionPatch,
  campos: CampoGestion[],
  actorId: number,
): DetalleGestion {
  const valores = campos.map((c) => (c === 'causal' ? patch.causalId : patch.observacion));
  const motivo: MotivoGestion = valores.every((v) => v === null)
    ? 'gestion_retirada'
    : 'gestion_registrada';

  return {
    motivo,
    campos,
    actorId,
    // La causal solo aparece si la petición la tocó: presente-con-`null` significa «se retiró» y
    // ausente significa «no se habló de ella», la misma distinción que gobierna el `set()`.
    ...(patch.causalId !== undefined ? { causalId: patch.causalId } : {}),
  };
}
