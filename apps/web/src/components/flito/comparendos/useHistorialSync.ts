// FLITO — Comparendos · Sincronización: las corridas anteriores (HU #11636, AC1 y AC3).
//
// ══════════════════════════════════════════════════════════════════════════════════════════════
// ESTE HOOK NO SONDEA. Y esa es su decisión de diseño principal.
//
// Es lo primero que pide el cuerpo al escribirlo —«si la corrida está viva, refresca la lista cada
// pocos segundos y ya»— y es justo lo que la enmienda de UX del 20 ago 2026 (decisión 13, § «Qué
// cambia para las HU pendientes») prohíbe, por dos razones que no se ven desde esta pantalla:
//
//   · La consola de arriba YA sondea `GET /sync/runs` mientras hay una corrida viva. Un segundo
//     sondeo aquí duplicaría exactamente las mismas peticiones sobre el mismo dato, contra un
//     limitador que cuenta 500 por 15 min **y por IP** —la de toda la oficina detrás del NAT—.
//   · Cada lectura de `/sync/runs` escribe una fila de `pii_access_log` (el `scope_nits` de una
//     corrida son NIT, HU #11511). Duplicar el sondeo es duplicar la bitácora de accesos a datos
//     personales, que existe para poder auditar quién miró qué y deja de servir en cuanto el grueso
//     de sus filas es una pantalla mirándose a sí misma.
//
// El historial se refresca en exactamente tres momentos, los tres provocados por un hecho:
//
//   1. Al montar la vista.
//   2. Cuando la consola publica el DESENLACE de una corrida (`desenlace`, abajo).
//   3. Cuando el operador pulsa «Reintentar» o «Cargar más».
//
// ── La primera fila es superficie de desenlace, no archivo ──────────────────────────────────────
//
// Al descartarse los toasts de sincronización (decisión 14), la primera fila de esta tabla es —junto
// con la tarjeta de resultado— donde queda visible cómo acabó la corrida. Tiene que traer el chip
// correcto **en el mismo instante** en que la tarjeta aparece arriba: una fila que dice «En curso»
// durante los cinco segundos que tarda el refresco, al lado de una tarjeta que ya dice «Completada»,
// es la pantalla contradiciéndose a sí misma sobre el mismo hecho.
//
// Por eso el desenlace se FUNDE en la lista al renderizar (`fusionar`, sin esperar a la respuesta) y
// además dispara el refresco. No es una suposición optimista: `desenlace` es la corrida que el
// servidor acaba de devolver —el mismo objeto que pinta la tarjeta de resultado—, así que la fila
// enseña dato del servidor, nunca un estado adivinado por el cliente.
//
// ── El refresco del desenlace es SILENCIOSO ─────────────────────────────────────────────────────
//
// Nadie lo pidió: llega solo, cuando la corrida termina. Si mostrara el esqueleto, la tabla que el
// operador está leyendo se vaciaría sola —y borraría de paso la fila del desenlace que se acaba de
// fundir—. Y si fallara, tampoco puede tumbar la lista: lo que ya se ve son corridas confirmadas por
// el servidor, y cambiarlas por un error rojo por una petición de fondo sería castigar al operador
// por algo que no hizo. Un refresco silencioso que falla deja las cosas como estaban.
//
// La carga que SÍ pidió el operador (montaje, «Reintentar», «Cargar más») se comporta al revés y
// como el resto del módulo: vacía la lista al fallar (`bloqueConfigComparendos.tsx`), porque dejar
// filas viejas bajo un mensaje de error enseña como cierto un historial que no se pudo confirmar.
//
// ── El silencio tiene un límite: no callar si no había nada que proteger ────────────────────────
//
// «Un refresco silencioso que falla deja las cosas como estaban» es cierto solo cuando hay algo
// que dejar. Hay una secuencia —y es la que este diseño hace MÁS probable, no menos— en la que no
// lo hay: se entra a la vista con una corrida viva, la carga de montaje todavía va por la red, la
// corrida termina y el desenlace dispara su refresco. Ese refresco incrementa `turno`, con lo que
// la respuesta del montaje queda descartada cuando llegue; si además el refresco falla y se limita
// a volver, `estado` se queda en `cargando` PARA SIEMPRE: `aria-busy` puesto, esqueleto eterno,
// tabla que nunca se pinta —el render vive bajo `ok`—, la fila del desenlace fundida pero invisible
// y ni un «Reintentar» que tocar. Solo se sale cambiando de pestaña.
//
// Así que la rama silenciosa mira el estado antes de callarse: si el bloque estaba en `cargando`,
// publica el error con su reintento. Se elige el error y no un `ok` con la lista fundida —que
// también desatascaría— porque esa lista sería UNA fila presentada bajo el rótulo «las últimas
// corridas»: un historial de una sola entrada que nadie podría distinguir del real. Preferimos la
// misma regla que el resto del módulo —si la consulta falló, no se afirma qué hay— y el desenlace
// sigue estando a la vista arriba, en la tarjeta de resultado.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ComparendosSyncResultado, ComparendosSyncRun } from '@operaciones/shared-types';
import { api } from '../../../lib/api';
import { RUTA_COMPARENDOS, type EstadoBloque } from './bloqueConfigComparendos';

const RUTA_RUNS = `${RUTA_COMPARENDOS}/sync/runs`;

/**
 * Los tres tamaños de lista, en el orden en que «Cargar más» los recorre.
 *
 * No hay paginación de verdad porque el API no tiene cursor en este endpoint: se vuelve a pedir la
 * misma lista más larga y se reemplaza. 100 es el tope del servidor (`limit` máx.), así que pedir
 * más sería un 400 seguro.
 */
export const LIMITES = [20, 50, 100] as const;

export interface HistorialSync {
  /** Las corridas a pintar, con el desenlace ya fundido si lo hay. */
  corridas: ComparendosSyncRun[];
  estado: EstadoBloque;
  /** Cuántas se están pidiendo ahora mismo. Se enseña junto a «Cargar más». */
  limite: number;
  /** Hay más que pedir: la lista viene llena y todavía queda peldaño por encima. */
  hayMas: boolean;
  recargar: () => void;
  cargarMas: () => void;
}

/**
 * Mete (o actualiza) una corrida en la lista sin duplicarla.
 *
 * Si ya estaba se REEMPLAZA en su sitio: la fila `running` que la consola venía siguiendo pasa a
 * `completed` sin moverse de donde el operador la está mirando. Si no estaba, va la primera, que es
 * donde le toca —el listado viene por `iniciadoEn` descendente y no puede haber empezado ninguna
 * corrida después de una que seguía viva hasta hace un instante: el lock del backend (409
 * `sync_en_curso`) impide justamente eso—.
 *
 * No se reordena la lista por fecha: comparar instantes exigiría parsear cadenas del servidor para
 * decidir un orden que el servidor ya decidió, y equivocarse ahí desordena el historial entero para
 * arreglar un caso que no existe.
 */
function fusionar(previas: ComparendosSyncRun[], corrida: ComparendosSyncRun): ComparendosSyncRun[] {
  const indice = previas.findIndex((r) => r.runId === corrida.runId);
  if (indice < 0) return [corrida, ...previas];
  const copia = [...previas];
  copia[indice] = corrida;
  return copia;
}

/** Lo que no se pinta y por eso no vive en `useState`. */
interface Control {
  vigente: boolean;
  /** Descarta respuestas viejas: manda siempre la última petición lanzada, no la última en volver. */
  turno: number;
  limite: number;
  /** La carga de montaje ya se pidió. Ver el comentario del efecto. */
  montado: boolean;
  /**
   * Espejo del `estado` publicado, para poder LEERLO desde dentro de una petición en vuelo.
   *
   * `pedir` no se recrea nunca (`useCallback` sin dependencias) y su `catch` corre segundos después
   * de lanzarse: el `estado` que vería por cierre sería el de cuando se creó la función, no el de
   * ahora. Y justo esa lectura es la que decide si el bloque puede quedarse colgado.
   */
  estado: EstadoBloque;
}

/**
 * @param desenlace La corrida que la consola acaba de confirmar como terminal, o `null`.
 *   Es la ÚNICA atadura entre las dos piezas y va en esta dirección a propósito: el historial se
 *   entera de que hubo un desenlace, y el hook de la consola no sabe que existe un historial. Al
 *   revés —el historial dentro de `useComparendosSync`— habría acabado con una máquina de estados
 *   que además pagina, y con la lista recargándose en cada transición de fase.
 */
export function useHistorialSync(desenlace: ComparendosSyncResultado | null): HistorialSync {
  const [corridas, setCorridas] = useState<ComparendosSyncRun[]>([]);
  const [estado, setEstado] = useState<EstadoBloque>('cargando');
  const [limite, setLimite] = useState<number>(LIMITES[0]);
  const ctrl = useRef<Control>({
    vigente: true, turno: 0, limite: LIMITES[0], montado: false, estado: 'cargando',
  });

  /** Único punto por el que se publica el estado: deja el espejo del `ref` siempre al día. */
  const ponerEstado = useCallback((siguiente: EstadoBloque) => {
    ctrl.current.estado = siguiente;
    setEstado(siguiente);
  }, []);

  const pedir = useCallback(async (cuantas: number, silencioso: boolean) => {
    const c = ctrl.current;
    c.turno += 1;
    const turno = c.turno;
    c.limite = cuantas;
    if (!silencioso) ponerEstado('cargando');
    try {
      const lista = await api.get<ComparendosSyncRun[]>(`${RUTA_RUNS}?limit=${cuantas}`);
      if (!c.vigente || turno !== c.turno) return;
      // `Array.isArray` y no `?? []`: un 200 con algo que no es una lista reventaría en el `.map()`
      // del render y se llevaría por delante la consola de arriba, que es justo lo que el AC3
      // prohíbe. Un cuerpo inesperado se trata como lista vacía.
      setCorridas(Array.isArray(lista) ? lista : []);
      ponerEstado('ok');
    } catch {
      if (!c.vigente || turno !== c.turno) return;
      // El refresco que nadie pidió no tumba lo que ya se ve... salvo que no hubiera nada que
      // tumbar. Ver «El silencio tiene un límite» en la cabecera: si el bloque sigue en `cargando`,
      // este refresco acaba de descartar (por `turno`) la única carga que iba a sacarlo de ahí, y
      // callarse ahora deja un esqueleto eterno con `aria-busy` y sin ningún botón que pulsar.
      if (silencioso && c.estado !== 'cargando') return;
      setCorridas([]);
      ponerEstado('error');
    }
  }, [ponerEstado]);

  /**
   * Montaje: UNA lectura por instancia del hook, aunque el efecto corra dos veces.
   *
   * En desarrollo `StrictMode` monta, limpia y vuelve a montar sobre la MISMA instancia —las refs
   * sobreviven, que es lo que hace fiable la bandera—. Sin ella, entrar a la pestaña dispara dos
   * `GET /sync/runs` y esa lectura no es gratis: escribe una fila de `pii_access_log` con los NIT
   * del alcance de cada corrida listada. Mismo cuidado, y por el mismo motivo, que la hidratación
   * de `useComparendosSync`.
   */
  useEffect(() => {
    const c = ctrl.current;
    c.vigente = true;
    if (!c.montado) {
      c.montado = true;
      void pedir(c.limite, false);
    }
    return () => { c.vigente = false; };
  }, [pedir]);

  /**
   * El desenlace: se funde en la lista (para que sobreviva a un `desenlace` que vuelva a `null`) y
   * se pide la lista otra vez, **una sola vez y en silencio**.
   *
   * La dependencia es la identidad del objeto, que el hook de la consola crea una vez por corrida
   * terminada. Volver a lanzar una sincronización lo pone a `null` y no dispara nada.
   */
  useEffect(() => {
    if (!desenlace) return;
    setCorridas((previas) => fusionar(previas, desenlace));
    void pedir(ctrl.current.limite, true);
  }, [desenlace, pedir]);

  const recargar = useCallback(() => { void pedir(ctrl.current.limite, false); }, [pedir]);

  const cargarMas = useCallback(() => {
    const siguiente = LIMITES.find((n) => n > ctrl.current.limite);
    if (siguiente === undefined) return;
    setLimite(siguiente);
    void pedir(siguiente, false);
  }, [pedir]);

  /**
   * El desenlace se funde también AL RENDERIZAR, no solo en el efecto de arriba.
   *
   * Es lo que hace que la fila salga con su chip definitivo en el mismo fotograma en que aparece la
   * tarjeta de resultado: un efecto pinta primero el estado viejo y lo corrige después, y ese
   * parpadeo es exactamente la contradicción que la obligación 2 de UX prohíbe. `fusionar` es
   * idempotente, así que cuando el refresco silencioso traiga la misma corrida no se duplica nada.
   */
  const conDesenlace = useMemo(
    () => (desenlace ? fusionar(corridas, desenlace) : corridas),
    [corridas, desenlace],
  );

  return {
    corridas: conDesenlace,
    estado,
    limite,
    // Se mide sobre lo que TRAJO el servidor, no sobre la lista fundida: el desenlace añade una fila
    // que no vino de este `limit` y ofrecería «Cargar más» sobre una lista que no está llena.
    hayMas: corridas.length >= limite && limite < LIMITES[LIMITES.length - 1],
    recargar,
    cargarMas,
  };
}
