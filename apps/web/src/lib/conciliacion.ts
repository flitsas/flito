// FLITO — Conciliación de boletas SOAT: el vocabulario de la pantalla (Feature #11623, HU #11680).
//
// Aquí vive lo que las dos rutas —la bandeja y el cuadre— tienen que decir igual: quién entra, cómo
// se llama cada desenlace del cruce, cómo se redacta su motivo y qué texto sale por cada rechazo de
// la carga y del comprobante. Está fuera de los componentes por dos razones concretas:
//
//   · **El motivo de una línea lo compone el front, no el servidor.** `LineaBoletaDto.detalle` es el
//     respaldo persistido de por qué la línea quedó así; el texto que se pinta se arma aquí con los
//     campos estructurados, para que el dinero se formatee con `pesos()` y para que cambiar una
//     palabra del motivo no exija migrar datos (docs/ux/flito-conciliacion.md).
//   · **El mismo motivo tiene que leerse igual en las 500 filas** y en las dos rutas. Un mapa
//     `Record<ResultadoCruce, …>` exhaustivo es además lo que hace que añadir un octavo desenlace en
//     la base no compile aquí, que es la forma barata de enterarse.
//
// Roles: `admin` y `financiera`, calcado de `puedeVerBolsas`. Ni `auditor` ni `proveedor` — el
// router de `/api/flito/conciliacion` exige esos dos y nada más (ADR-0006 §7, CF-08).

import {
  ESTADO_SOAT_LABEL, EstadoBoleta, ResultadoCruce,
  type BoletaDetalleDto, type ConciliacionRealizadaDto, type EstadoSoat, type LineaBoletaDto,
  type UserRole,
} from '@operaciones/shared-types';
import { ApiError } from './api';
import type { AvisoConciliacion } from './conciliacionAviso';
import { pesos } from './bolsas';
import type { ChipTone } from '../components/flit/StatusChip';

/**
 * Quién ve la pantalla. Espejo del `requireRole('admin', 'financiera')` del router: sin este gate,
 * un rol con el slug concedido a mano entraría a soltar un 403 por cada petición en vez de leer que
 * no tiene acceso — que es justo lo que el AC1 prohíbe.
 */
export const ROLES_CONCILIACION: readonly UserRole[] = ['admin', 'financiera'];

export function puedeConciliar(role: string | undefined): boolean {
  // El rol llega como `string` desde `/auth/me`, no como `UserRole`: la lista se declara tipada
  // —para que renombrar un rol en shared-types rompa AQUÍ y no en producción— y la comparación se
  // hace contra strings, que es lo que de verdad viaja en el token.
  return role !== undefined && (ROLES_CONCILIACION as readonly string[]).includes(role);
}

// ─────────────────────────── El estado de una boleta ─────────────────────────────────────────────

export const ETIQUETA_ESTADO_BOLETA: Record<EstadoBoleta, string> = {
  cargada: 'Por conciliar',
  conciliada: 'Conciliada',
  descartada: 'Descartada',
};

/**
 * `cargada` es `active` y no `warning`: una boleta recién cargada no es un problema, es trabajo en
 * curso. Lo que sí avisa es el conteo de líneas sin cuadrar, que va en su propia columna.
 */
export const TONO_ESTADO_BOLETA: Record<EstadoBoleta, ChipTone> = {
  cargada: 'active',
  conciliada: 'success',
  descartada: 'neutral',
};

// ─────────────────────────── Los siete desenlaces del cruce ──────────────────────────────────────

/**
 * Son SIETE, no seis: el `CHECK` de la migración 0157 admite además `ya_conciliada`, que es lo que
 * impide conciliar el mismo SOAT en dos boletas. Y es `no_encontrada`, en femenino («la línea»),
 * que es como lo escriben el ADR y la base — la HU lo escribe en masculino y ahí manda el `CHECK`.
 */
export const ETIQUETA_RESULTADO: Record<ResultadoCruce, string> = {
  ok: 'Cuadra',
  no_encontrada: 'Sin SOAT',
  no_pagado: 'SOAT sin pagar',
  valor_distinto: 'Valor distinto',
  poliza_duplicada: 'Póliza repetida',
  otra_compania: 'Otro cliente',
  ya_conciliada: 'Ya conciliada',
};

/**
 * `no_pagado` y `poliza_duplicada` son `warning` y no `danger` a propósito.
 *
 * El primero es el único de los siete que **se resuelve solo con el paso del tiempo** —falta que el
 * gestor suba el comprobante—, y pintarlo igual que un error de datos mandaría a Financiera a buscar
 * un problema que no existe. El segundo tampoco es un dato malo de ESTA boleta: es un número mal
 * leído en uno de dos SOAT, y se arregla en otra pantalla.
 */
export const TONO_RESULTADO: Record<ResultadoCruce, ChipTone> = {
  ok: 'success',
  no_encontrada: 'danger',
  no_pagado: 'warning',
  valor_distinto: 'danger',
  poliza_duplicada: 'warning',
  otra_compania: 'danger',
  ya_conciliada: 'warning',
};

/** El motivo de una línea: qué pasó, y qué hacer. `null` en las que cuadran. */
export interface MotivoLinea {
  motivo: string;
  queHacer: string;
}

const estadoSoatLegible = (estado: string | null): string =>
  ESTADO_SOAT_LABEL[estado as EstadoSoat] ?? estado ?? 'sin estado';

/**
 * El motivo redactado de una línea que no cuadra.
 *
 * Quien lee esto es alguien de Financiera que no sabe qué es un `uuid` ni qué es `flito_soat`: cada
 * texto dice QUÉ PASÓ en la primera frase y QUÉ HACER en la segunda, nombra valores concretos en vez
 * de adjetivos, y no usa «registro», «entidad», «campo», «validación» ni «match».
 *
 * `companiaBoleta` es el cliente para el que se cargó la boleta, que solo hace falta en
 * `otra_compania` —el motivo tiene que nombrar a los DOS o no se entiende de qué se queja—.
 */
export function motivoDeLinea(linea: LineaBoletaDto, companiaBoleta: string | null): MotivoLinea | null {
  switch (linea.resultado) {
    case ResultadoCruce.OK:
      return null;
    case ResultadoCruce.NO_ENCONTRADA:
      return {
        motivo: 'No hay ningún SOAT en FLITO con este número de póliza.',
        queHacer: 'Puede ser que el gestor todavía no haya cargado el comprobante del SOAT, o que el '
          + 'número de la póliza quedara mal escrito al leerlo. Búscalo por la placa del vehículo y '
          + 'revisa el número antes de volver a cruzar.',
      };
    case ResultadoCruce.NO_PAGADO:
      return {
        motivo: `El SOAT existe en FLITO, pero todavía no está marcado como pagado: hoy está en `
          + `"${estadoSoatLegible(linea.soatEstado)}".`,
        queHacer: 'La financiera ya pagó esta boleta, así que falta que el gestor suba el comprobante '
          + 'y deje el SOAT en Pagado. Hasta entonces esta línea no se puede conciliar.',
      };
    case ResultadoCruce.VALOR_DISTINTO:
      return {
        motivo: diferenciaDeValor(linea),
        queHacer: 'Confirma cuál es el valor bueno. Si el correcto es el de la boleta, hay que '
          + 'corregir el valor pagado del SOAT; si el correcto es el del SOAT, la diferencia hay que '
          + 'reclamarla en el portal. La boleta no se puede conciliar mientras los dos números no '
          + 'sean el mismo.',
      };
    case ResultadoCruce.OTRA_COMPANIA:
      return {
        motivo: `Este SOAT es de ${linea.companiaSoatNombre ?? 'otro cliente'}, y esta boleta se `
          + `cargó para ${companiaBoleta ?? 'este cliente'}.`,
        queHacer: 'Una boleta solo puede tener SOAT de un mismo cliente. Revisa que elegiste el '
          + 'cliente correcto al cargarla; si el Excel de verdad mezcla vehículos de dos clientes, '
          + 'hay que pedir al portal una colilla por cliente.',
      };
    case ResultadoCruce.POLIZA_DUPLICADA:
      return {
        motivo: `Este número de póliza está en ${linea.candidatos ?? 2} SOAT distintos, así que no `
          + 'se puede saber a cuál corresponde esta línea de la boleta.',
        queHacer: 'Casi siempre es un número mal leído en uno de ellos. Abre esos SOAT, compara el '
          + 'número con el comprobante de cada uno y corrige el que esté mal: solo uno puede tener '
          + 'este número.',
      };
    case ResultadoCruce.YA_CONCILIADA:
      return {
        motivo: `Este SOAT ya se concilió en la boleta ${linea.boletaAnteriorRef ?? 'anterior'}`
          + `${linea.boletaAnteriorFecha ? ` el ${fechaCorta(linea.boletaAnteriorFecha)}` : ''}: su `
          + 'valor ya salió de la bolsa del cliente.',
        // No es adorno: el CF-07 y `corregirMovimiento` hacen que NO exista un botón de deshacer, y
        // esta es la primera pregunta que va a hacer Financiera. Mejor contestarla aquí que en una
        // llamada.
        queHacer: 'Un SOAT no se puede conciliar dos veces. Si esta boleta es la correcta y la '
          + 'anterior está mal, no se deshace desde aquí: hay que registrar un ajuste manual en la '
          + 'bolsa del cliente, con su motivo.',
      };
    default:
      return null;
  }
}

/** 'YYYY-MM-DD' → '30/7/2026', sin pasar por `new Date` (en Colombia retrocedería un día). */
function fechaCorta(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${Number(d)}/${Number(m)}/${y}`;
}

/**
 * «La boleta cobra $ X y el SOAT registrado vale $ Y: hay $ Z de diferencia.»
 *
 * La diferencia **se calcula y se muestra**: obligar a restar dos números de seis cifras a ojo, 500
 * veces, es exactamente el trabajo que esta pantalla existe para quitar. En valor absoluto, porque
 * la frase ya dice cuál es cuál sin necesidad de signo.
 */
function diferenciaDeValor(linea: LineaBoletaDto): string {
  if (linea.valorSoat === null) {
    return `La boleta cobra ${pesos(linea.valorDeclarado)} y el SOAT registrado en FLITO no tiene `
      + 'valor pagado, así que los dos números no se pueden comparar.';
  }
  const diferencia = Math.abs(linea.valorDeclarado - linea.valorSoat);
  return `La boleta cobra ${pesos(linea.valorDeclarado)} y el SOAT registrado en FLITO vale `
    + `${pesos(linea.valorSoat)}: hay ${pesos(diferencia)} de diferencia.`;
}

/**
 * Qué se pinta en la columna PLACA.
 *
 * El Excel del portal **no trae placa** (18 columnas, ninguna es la placa): la pone el SOAT cruzado,
 * así que hay filas que no pueden tenerla. Nunca se deja la celda en blanco ni con un guion suelto:
 * un guion se lee como «falta algo» y aquí lo que falta es otra cosa.
 */
export function textoPlaca(linea: LineaBoletaDto): { texto: string; esDato: boolean } {
  if (linea.placa) return { texto: linea.placa, esDato: true };
  if (linea.resultado === ResultadoCruce.POLIZA_DUPLICADA) {
    return { texto: `${linea.candidatos ?? 2} SOAT posibles`, esDato: false };
  }
  return { texto: 'Sin identificar', esDato: false };
}

/** Y lo mismo en VALOR SOAT. En ningún caso «$ 0»: un cero se suma en la cabeza de quien lee. */
export function textoValorSoat(linea: LineaBoletaDto): { texto: string; esDato: boolean } {
  if (linea.valorSoat !== null) return { texto: pesos(linea.valorSoat), esDato: true };
  if (linea.resultado === ResultadoCruce.POLIZA_DUPLICADA) {
    return { texto: 'No se puede saber', esDato: false };
  }
  return { texto: 'Sin SOAT', esDato: false };
}

/**
 * Nota bajo una línea que cuadra y cuyo SOAT ya salió de la bolsa al liquidar su trámite.
 *
 * No bloquea —la línea cuadra— y existe para que el aviso de éxito no anuncie un descuento que no
 * ocurrió. Es el «tres estados que se parecen y no son lo mismo» que el ADR encarga a UX.
 */
export const NOTA_YA_DESCONTADO =
  'Este SOAT ya se descontó de la bolsa cuando se liquidó su trámite. Al conciliar no se vuelve a cobrar.';

// ─────────────────────────── Contadores, en singular cuando toca ─────────────────────────────────

/**
 * El contador que encabeza la tabla. Sin «(s)» ni «línea/s»: el producto no habla así en ninguna
 * otra pantalla, y una boleta de una sola línea es un caso corriente.
 */
export function textoContador(total: number, sinCuadrar: number, conciliada: boolean): string {
  const lineas = (n: number) => (n === 1 ? '1 línea' : `${n} líneas`);
  if (sinCuadrar === 0) {
    if (total === 1) return conciliada ? 'La única línea cuadró.' : 'La única línea cuadra.';
    return conciliada ? `Las ${total} líneas cuadraron.` : `Las ${total} líneas cuadran.`;
  }
  const cuadran = total - sinCuadrar;
  const verbo = cuadran === 1 ? 'cuadra' : 'cuadran';
  const verboMal = sinCuadrar === 1 ? 'no cuadra' : 'no cuadran';
  return `${cuadran} de ${lineas(total)} ${verbo}. ${sinCuadrar} ${verboMal}.`;
}

/** El texto bloqueante del AC4, junto al botón. Mismo número que el contador, en singular si toca. */
export function textoBloqueante(total: number, sinCuadrar: number): string {
  const sujeto = sinCuadrar === 1
    ? `1 de ${total} líneas no cuadra. Resuélvela`
    : `${sinCuadrar} de ${total} líneas no cuadran. Resuelve cada una`;
  return `No se puede conciliar: ${sujeto} —la columna «Resultado» dice qué pasó y qué hacer— y usa `
    + '«Volver a cruzar».';
}

/** El nombre accesible del botón bloqueado. Sin él, quien lo alcanza con Tab no sabe por qué no va. */
export function nombreBotonBloqueado(total: number, sinCuadrar: number): string {
  const cola = sinCuadrar === 1
    ? `1 de ${total} líneas no cuadra`
    : `${sinCuadrar} de ${total} líneas no cuadran`;
  return `Conciliar boleta — no disponible: ${cola}`;
}

// ─────────────────────────── Los rechazos, con su motivo ─────────────────────────────────────────

/** El código de negocio del cuerpo del error, si lo trae. `rawDetails` es el cuerpo tal cual. */
export function codigoDe(e: unknown): string | null {
  if (!(e instanceof ApiError)) return null;
  const cuerpo = e.rawDetails as { codigo?: unknown } | null;
  return typeof cuerpo?.codigo === 'string' ? cuerpo.codigo : null;
}

/** Un campo cualquiera del cuerpo del error (`boletaId`, `referencia`, `boleta`, `sinCuadrar`). */
export function extraDe<T>(e: unknown, campo: string): T | null {
  if (!(e instanceof ApiError)) return null;
  const cuerpo = e.rawDetails as Record<string, unknown> | null;
  return (cuerpo?.[campo] as T | undefined) ?? null;
}

export interface Rechazo {
  titulo: string;
  detalle: string;
  /** La boleta que ya existe, cuando el rechazo es `boleta_duplicada`: la pantalla lleva a ella. */
  boletaId?: string;
  referencia?: string;
}

/** El mensaje del servidor, cuando lo hay y aporta algo más que el genérico. */
function mensajeServidor(e: unknown): string | null {
  if (!(e instanceof ApiError)) return null;
  return e.message && e.message.trim().length > 0 ? e.message : null;
}

/**
 * El copy de cada rechazo de la carga del Excel. Ninguno dice «Error 400».
 *
 * En `archivo_invalido` gana el mensaje del servidor cuando lo hay: el parser sabe decir cuál es la
 * hoja o la columna que falta, o en qué fila está el número ilegible, y eso es más útil que el texto
 * genérico. El genérico se queda como respaldo para cuando el servidor no dice nada.
 */
export function rechazoDeCarga(e: unknown): Rechazo {
  const codigo = codigoDe(e);
  const delServidor = mensajeServidor(e);
  switch (codigo) {
    case 'archivo_invalido':
      return {
        titulo: 'No pudimos leer el archivo.',
        detalle: delServidor
          ?? 'Tiene que ser el Excel que descargas del portal, con la hoja «Export» y las columnas '
            + '«Número de Póliza» y «Total a Pagar». Si lo abriste y lo volviste a guardar, '
            + 'descárgalo otra vez.',
      };
    case 'archivo_demasiado_grande':
      return {
        titulo: 'El archivo es demasiado grande por dentro.',
        detalle: delServidor
          ?? 'Descárgalo otra vez del portal, tal cual, sin abrirlo ni volverlo a guardar.',
      };
    case 'sin_filas':
      return {
        titulo: 'El archivo no trae ninguna fila de datos.',
        detalle: 'Solo tiene los encabezados. Descárgalo otra vez del portal.',
      };
    case 'demasiadas_filas': {
      const filas = extraDe<number>(e, 'filas');
      const maximo = extraDe<number>(e, 'maximo');
      return {
        titulo: filas && maximo
          ? `El archivo trae ${filas} líneas y el máximo son ${maximo}.`
          : 'El archivo trae más líneas de las que admite una boleta.',
        detalle: 'Divide la boleta en dos archivos y cárgalos por separado.',
      };
    }
    // No está en la tabla de docs/ux —el parser lo añadió después— y necesita su propio texto: es
    // la MISMA póliza en dos filas del mismo archivo, no una póliza en dos SOAT (`poliza_duplicada`).
    case 'poliza_repetida':
      return {
        titulo: 'El archivo cobra dos veces la misma póliza.',
        detalle: delServidor
          ?? 'Revisa la descarga del portal: una boleta no puede traer el mismo SOAT dos veces.',
      };
    case 'fecha_invalida':
      return {
        titulo: 'La fecha de pago no puede ser futura.',
        detalle: 'Pon el día en que se pagó en el portal.',
      };
    case 'compania_no_existe':
      return {
        titulo: 'El cliente que elegiste ya no está disponible.',
        detalle: 'Vuelve a elegirlo en la lista.',
      };
    case 'boleta_duplicada': {
      const referencia = extraDe<string>(e, 'referencia');
      return {
        titulo: referencia
          ? `Este mismo archivo ya se cargó como ${referencia}.`
          : 'Este mismo archivo ya se cargó.',
        detalle: 'No se carga dos veces la misma boleta.',
        boletaId: extraDe<string>(e, 'boletaId') ?? undefined,
        referencia: referencia ?? undefined,
      };
    }
    default:
      break;
  }
  if (e instanceof ApiError && e.status === 429) {
    return { titulo: 'Vas muy rápido.', detalle: 'Espera un minuto antes de cargar otra boleta.' };
  }
  if (e instanceof ApiError && e.status === 413) {
    return { titulo: 'El archivo pesa más de lo que admite la carga.', detalle: 'El máximo son 10 MB.' };
  }
  return {
    titulo: 'No se pudo cargar la boleta.',
    detalle: 'Revisa la conexión y vuelve a intentarlo.',
  };
}

/** El copy de cada rechazo del comprobante PSE (AC6). El del servidor gana cuando nombra el motivo. */
export function rechazoDeComprobante(e: unknown): Rechazo {
  const codigo = codigoDe(e);
  const delServidor = mensajeServidor(e);
  if (codigo === 'comprobante_ya_existe') {
    return {
      titulo: 'Esta boleta ya tiene un comprobante.',
      detalle: 'Usa «Reemplazar» si el nuevo es el bueno.',
    };
  }
  if (codigo === 'boleta_no_conciliada') {
    return {
      titulo: 'El comprobante se adjunta después de conciliar la boleta.',
      detalle: 'Concilia primero y vuelve a subirlo.',
    };
  }
  // `archivo_invalido` cubre los tres rechazos del archivo —tipo fuera de la lista, tamaño y magic
  // number— y el servidor es quien sabe cuál de los tres fue: su mensaje NOMBRA el motivo («El
  // archivo dice ser un PDF pero no lo es», «El archivo pesa más de 15 MB»).
  if (codigo === 'archivo_invalido') {
    return {
      titulo: delServidor ?? 'Ese archivo no sirve como comprobante.',
      detalle: 'El comprobante tiene que ser PDF, JPG o PNG y pesar menos de 15 MB.',
    };
  }
  if (e instanceof ApiError && e.status === 429) {
    return { titulo: 'Vas muy rápido.', detalle: 'Espera un minuto antes de subir otro comprobante.' };
  }
  return {
    titulo: 'No se pudo subir el comprobante.',
    detalle: 'Revisa la conexión y vuelve a intentarlo.',
  };
}

// ─────────────────────────── El aviso del AC5, que sobrevive a la recarga ────────────────────────

/**
 * El aviso guardado —su forma, su clave y su barrido— vive en `conciliacionAviso.ts` y se re-exporta
 * aquí para que las pantallas sigan importando todo el vocabulario de conciliación de un solo sitio.
 *
 * **Está en su propio archivo por peso, no por gusto:** `lib/auth.tsx` necesita `limpiarAvisos()` al
 * cerrar sesión, y `auth.tsx` va en el chunk de entrada —el que descarga /login—. Importarlo de este
 * módulo arrastraba al entry las 500 líneas de copy de la conciliación y sus dependencias: +7,1 KB
 * gzip medidos, con el presupuesto de `check:bundle` en 32 KB sobre una línea base de 26,8.
 */
export {
  guardarAviso, leerAviso, limpiarAvisos, IMPORTE_DESCONOCIDO, type AvisoConciliacion,
} from './conciliacionAviso';

export function avisoDeRespuesta(r: ConciliacionRealizadaDto): AvisoConciliacion {
  return {
    soatConciliados: r.soatConciliados,
    totalConciliado: r.totalConciliado,
    cliente: {
      nombre: r.cliente.nombre,
      descontado: r.cliente.descontado,
      saldoResultante: r.cliente.saldoResultante,
    },
    // Una línea por BOLSA de tránsito, no por organismo: el saldo pertenece a la bolsa, y una bolsa
    // puede cubrir varios organismos. Si no hubo consumo de tránsito, el array viene vacío y no se
    // anuncia ningún «− $ 0» de un movimiento que no existe.
    transito: r.transito.map((t) => ({
      nombre: t.nombre, descontado: t.descontado, saldoResultante: t.saldoResultante,
    })),
    adoptados: r.adoptados.length,
  };
}

/**
 * El aviso reconstruido del detalle, para quien abre la boleta ya conciliada desde otra pestaña,
 * otro navegador u otro día.
 *
 * Dice lo que el detalle SABE —cuántos SOAT y por cuánto— y **calla lo que no**: los saldos de las
 * bolsas no viajan en el detalle y no se inventan. Quien necesite el saldo lo mira en Bolsas, que es
 * el libro.
 */
export function avisoReconstruido(boleta: BoletaDetalleDto): AvisoConciliacion | null {
  if (boleta.estado !== EstadoBoleta.CONCILIADA) return null;
  const conciliadas = boleta.lineas.filter((l) => l.conciliadaEn !== null);
  const lineas = conciliadas.length > 0 ? conciliadas : boleta.lineas;
  return {
    soatConciliados: lineas.length,
    totalConciliado: lineas.reduce((suma, l) => suma + (l.valorSoat ?? 0), 0),
    cliente: { nombre: boleta.companiaNombre, descontado: -1, saldoResultante: -1 },
    transito: [],
    adoptados: 0,
  };
}
