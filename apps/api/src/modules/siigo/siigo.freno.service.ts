// Siigo API — freno por proporción de errores (HU #11341, Feature #11244).
//
// Siigo bloquea temporalmente el usuario API si durante siete días más del 80 % de las peticiones
// son errores (`docs/integraciones/siigo-api.md` §1). Ese bloqueo no tumba una petición: tumba la
// facturación de la empresa entera, y se levanta cuando Siigo quiere, no cuando nosotros
// arreglamos la causa. Este módulo mide esa proporción y deja de insistir ANTES de llegar ahí.
//
// Decisiones que sostienen el archivo:
//
//   1. **TERCER EJE, NO SUSTITUTO** (AC5). `siigo.resiliencia.ts` ya protege dos cosas y ninguna es
//      esta: la CUOTA (100 peticiones/minuto, por empresa) con el limitador de tasa, y la SALUD DE
//      UN ENDPOINT con el cortacircuitos. Aquí se mide la PROPORCIÓN ACUMULADA de la empresa, que
//      es lo único que Siigo penaliza con bloqueo. Fusionarlos sería el error clásico: un endpoint
//      caído abre su cortacircuitos y no tiene por qué frenar la integración entera, y una
//      integración frenada no dice nada sobre si un endpoint concreto está sano. Este módulo NO
//      llama al cortacircuitos ni al limitador, y ellos no llaman a este.
//
//   2. **LOS ERRORES DE DATOS NO CUENTAN, NI ARRIBA NI ABAJO DE LA FRACCIÓN** (AC3). Un
//      `parameter_required` significa que NUESTRO payload está mal, no que Siigo esté caído — la
//      misma distinción que ya hace el cortacircuitos y por la que un error de datos no lo abre.
//      Dejarlos fuera del numerador es obvio; dejarlos fuera del DENOMINADOR también hace falta, y
//      es menos evidente: con 90 errores de datos y 10 fallos técnicos sobre 10 intentos sanos, el
//      denominador inflado daría 10 % y el freno no se activaría pese a que el servicio está roto
//      de arriba abajo. La fracción responde «de las operaciones cuyo desenlace dependía de la
//      salud del servicio, ¿cuántas fallaron?». Los errores de datos se informan aparte
//      (`erroresDeDatos`) y siguen enteros en la bitácora, que es de donde lee la bandeja de
//      fallidos: el freno no los cuenta, pero no los esconde.
//
//   3. **NO HAY ESTADO EN MEMORIA.** El freno se deriva de `siigo_operaciones`, que ya es una
//      bitácora inalterable con el índice que hace barata la consulta. Sin tabla nueva ni contador
//      paralelo (AC1). Como consecuencia el veredicto sobrevive a un reinicio y es el mismo en
//      todas las instancias, cosa que un contador en memoria no consigue.
//
//   4. **REACTIVAR = ADELANTAR EL INICIO DE LA VENTANA** (AC4). La reactivación se escribe como una
//      operación más en la bitácora, y la medición arranca en la más reciente. Así el «quién y
//      cuándo» que pide el AC queda en una tabla que nadie puede editar ni borrar, y las
//      operaciones vuelven a permitirse sin esperar a que la ventana expire por su cuenta.
//
//   5. **EL FRENO SE MIDE, NO SE CACHEA.** Igual que la compuerta de emisión: un veredicto guardado
//      es un permiso para operar con una foto vieja de la salud de la integración.

import type {
  EstadoFrenoSiigo,
  MedicionFrenoSiigo,
  ReactivacionFrenoSiigo,
} from '@operaciones/shared-types';
import { env } from '../../config/env.js';
import type { SiigoAmbiente } from './credenciales.service.js';
import { modoSiigo } from './siigo.mock.js';
import {
  contarPorResultado,
  marcaDeOperacion,
  registrarOperacion,
  type ResultadoOperacion,
} from './siigo.operaciones.repo.js';

/** Rechazo del freno, tal como queda en la bitácora. */
export const OPERACION_FRENO = 'freno_integracion';
/** Reactivación manual, tal como queda en la bitácora. */
export const OPERACION_REACTIVACION = 'freno_reactivado';

/**
 * Operaciones internas que nunca salieron a la red.
 *
 * Excluirlas del conteo es lo que impide que el freno se realimente: el rechazo se registra como
 * `error_negocio`, y contarlo haría que un freno activo produjera exactamente los errores que lo
 * mantienen activo. La reactivación se registra como `ok` y contarla diluiría la proporción justo
 * después de levantarla, que es cuando más falta hace medir limpio.
 */
const OPERACIONES_INTERNAS = [OPERACION_FRENO, OPERACION_REACTIVACION] as const;

/**
 * Resultados que sí hablan de la salud del servicio.
 *
 * `error_negocio` queda deliberadamente fuera: es el resultado con el que se registra un rechazo de
 * Siigo por un dato nuestro (AC3).
 */
const FALLOS_DE_SERVICIO: readonly ResultadoOperacion[] = ['error_tecnico', 'timeout'];
const DESENLACES_MEDIBLES: readonly ResultadoOperacion[] = ['ok', ...FALLOS_DE_SERVICIO];
const ERRORES_DE_DATOS: readonly ResultadoOperacion[] = ['error_negocio'];

const MS_POR_HORA = 3_600_000;

export interface OpcionesFreno {
  /** Por omisión, el ambiente configurado en el servidor. */
  ambiente?: SiigoAmbiente;
  /**
   * Inyectables para poder medir un escenario sin esperar horas ni tocar la configuración del
   * despliegue, igual que `ahora` y `dormir` en `siigo.resiliencia.ts`.
   *
   * NUNCA se alimentan desde la petición HTTP: dejar que quien llama elija el umbral sería dejarle
   * apagar el freno con `?umbral=1`. El router no los reenvía y hay un test que lo comprueba.
   */
  ahora?: () => number;
  ventanaHoras?: number;
  umbral?: number;
  minimoOperaciones?: number;
}

/** Parámetros vigentes de la medición, ya resueltos. */
interface Parametros {
  ambiente: string;
  modo: string;
  ventanaHoras: number;
  umbral: number;
  minimoOperaciones: number;
  desde: Date;
  hasta: Date;
  reactivacion: ReactivacionFrenoSiigo | null;
}

async function resolverParametros(o: OpcionesFreno): Promise<Parametros> {
  const ambiente = o.ambiente ?? env.SIIGO_AMBIENTE;
  const modo = modoSiigo();
  const ventanaHoras = o.ventanaHoras ?? env.SIIGO_FRENO_VENTANA_HORAS;
  const umbral = o.umbral ?? env.SIIGO_FRENO_UMBRAL;
  const minimoOperaciones = o.minimoOperaciones ?? env.SIIGO_FRENO_MIN_OPERACIONES;

  const hasta = new Date((o.ahora ?? Date.now)());
  const inicioVentana = new Date(hasta.getTime() - ventanaHoras * MS_POR_HORA);

  // Una reactivación DENTRO de la ventana adelanta su inicio: lo anterior ya se dio por revisado y
  // seguir contándolo volvería a frenar por los mismos fallos que alguien acaba de dar por
  // resueltos. Una anterior a la ventana no aporta nada, porque ya quedó fuera por antigüedad.
  const marca = await marcaDeOperacion({
    operacion: OPERACION_REACTIVACION, ambiente, modo, desde: inicioVentana, orden: 'ultima',
  });
  const desde = marca && marca.createdAt > inicioVentana ? marca.createdAt : inicioVentana;

  return {
    ambiente,
    modo,
    ventanaHoras,
    umbral,
    minimoOperaciones,
    desde,
    hasta,
    reactivacion: marca
      ? { fecha: marca.createdAt.toISOString(), usuarioId: marca.createdBy }
      : null,
  };
}

function sumar(
  conteos: Array<{ resultado: ResultadoOperacion; total: number }>,
  resultados: readonly ResultadoOperacion[],
): number {
  return conteos
    .filter((c) => resultados.includes(c.resultado))
    .reduce((acc, c) => acc + c.total, 0);
}

async function medirCon(p: Parametros): Promise<MedicionFrenoSiigo> {
  const conteos = await contarPorResultado({
    ambiente: p.ambiente,
    modo: p.modo,
    desde: p.desde,
    hasta: p.hasta,
    excluir: OPERACIONES_INTERNAS,
  });

  const total = sumar(conteos, DESENLACES_MEDIBLES);
  const errores = sumar(conteos, FALLOS_DE_SERVICIO);
  const erroresDeDatos = sumar(conteos, ERRORES_DE_DATOS);
  const proporcion = total > 0 ? errores / total : 0;
  const muestraSuficiente = total >= p.minimoOperaciones;

  return {
    ambiente: p.ambiente,
    modo: p.modo,
    ventanaHoras: p.ventanaHoras,
    umbral: p.umbral,
    minimoOperaciones: p.minimoOperaciones,
    desde: p.desde.toISOString(),
    hasta: p.hasta.toISOString(),
    total,
    errores,
    erroresDeDatos,
    proporcion,
    muestraSuficiente,
    // Estrictamente mayor: el AC dice «supera el umbral». Con `>=`, un umbral de 1 frenaría con el
    // 100 % de fallos, que es justo el caso en que ya no hay nada que proteger porque no pasa nada.
    superaUmbral: muestraSuficiente && proporcion > p.umbral,
  };
}

/** AC1 — Proporción de errores de la ventana vigente, sin decidir nada todavía. */
export async function medirIntegracion(opciones: OpcionesFreno = {}): Promise<MedicionFrenoSiigo> {
  return medirCon(await resolverParametros(opciones));
}

function porcentaje(v: number): string {
  return `${(v * 100).toFixed(1)} %`;
}

/** Texto accionable: qué se midió, contra qué, y qué hacer para levantarlo. */
function redactarMotivo(m: MedicionFrenoSiigo): string {
  return 'La integración con Siigo está frenada. En la ventana de '
    + `${m.ventanaHoras} h, ${m.errores} de ${m.total} operaciones fallaron por un problema del `
    + `servicio (${porcentaje(m.proporcion)}), por encima del umbral de ${porcentaje(m.umbral)}. `
    + 'Siigo bloquea temporalmente el usuario API cuando la proporción de errores se sostiene, y ese '
    + 'bloqueo deja sin facturar a toda la empresa, así que se deja de insistir. Corrige la causa y '
    + 'reactiva la integración, o espera a que la ventana se limpie sola.';
}

/**
 * AC6 — Estado del freno para un ambiente: si frena, cuánto midió, con qué ventana y umbral, y
 * desde cuándo.
 */
export async function estadoFreno(opciones: OpcionesFreno = {}): Promise<EstadoFrenoSiigo> {
  const p = await resolverParametros(opciones);
  const medicion = await medirCon(p);

  // En simulado no sale nada hacia Siigo, así que no hay usuario API que se pueda bloquear y frenar
  // solo estorbaría al desarrollo. La medición se publica igual —misma decisión que la compuerta de
  // emisión— para que el simulador no aparente que todo está bien.
  const frenoActivo = p.modo === 'real';
  const frenada = frenoActivo && medicion.superaUmbral;

  // Se fecha por el primer rechazo REGISTRADO dentro de la ventana vigente, que es un hecho escrito
  // y no una reconstrucción: calcular el instante exacto en que la proporción cruzó el umbral
  // obligaría a traer la ventana entera a memoria, y con 100 peticiones por minuto permitidas eso
  // son cientos de miles de filas para responder a una pantalla de administración.
  const primerRechazo = frenada
    ? await marcaDeOperacion({
      operacion: OPERACION_FRENO,
      ambiente: p.ambiente,
      modo: p.modo,
      desde: p.desde,
      orden: 'primera',
    })
    : null;

  return {
    ...medicion,
    frenoActivo,
    frenada,
    frenadaDesde: primerRechazo?.createdAt.toISOString() ?? null,
    ultimaReactivacion: p.reactivacion,
    motivo: frenada ? redactarMotivo(medicion) : null,
  };
}

/**
 * La integración está frenada. La lanza `exigirIntegracionNoFrenada` para que quien emita no tenga
 * que inspeccionar un booleano y decidir por su cuenta qué hacer con él.
 *
 * Lleva el estado completo para que el mensaje al operador diga la proporción medida y la ventana,
 * no un «no se puede» sin recurso.
 */
export class SiigoIntegracionFrenadaError extends Error {
  readonly estado: EstadoFrenoSiigo;

  constructor(estado: EstadoFrenoSiigo) {
    super(estado.motivo ?? 'La integración con Siigo está frenada.');
    this.name = 'SiigoIntegracionFrenadaError';
    this.estado = estado;
  }
}

/**
 * AC2 — Lanza si la integración está frenada. Es lo que llamará el flujo de emisión.
 *
 * Se ejecuta ANTES de cualquier llamada a Siigo, igual que `exigirCompuertaAbierta`: el AC pide que
 * la operación se rechace sin salir a la red, y una petición condenada al rechazo tampoco debe
 * gastar cuota de las 100 por minuto.
 *
 * El flujo de emisión todavía no existe (Feature #11242), así que esto queda listo para que lo
 * llame cuando exista. No se engancha aquí a la compuerta de emisión a propósito: son dos preguntas
 * distintas —«¿está parametrizado?» y «¿está sana la integración?»— y responderlas juntas obligaría
 * a consultar la bitácora en pantallas de parametrización que no van a emitir nada.
 */
export async function exigirIntegracionNoFrenada(
  opciones: OpcionesFreno & { usuarioId?: number | null } = {},
): Promise<EstadoFrenoSiigo> {
  const estado = await estadoFreno(opciones);
  if (!estado.frenada) return estado;

  // El rechazo queda en la bitácora (AC2). `registrarOperacion` no lanza nunca: si la bitácora
  // fallara, el freno tiene que seguir frenando igual — perder el rastro es malo, dejar salir la
  // operación es peor.
  await registrarOperacion({
    operacion: OPERACION_FRENO,
    ambiente: estado.ambiente,
    modo: estado.modo,
    resultado: 'error_negocio',
    codigo: 'integracion_frenada',
    mensaje: estado.motivo,
    createdBy: opciones.usuarioId ?? null,
  });

  throw new SiigoIntegracionFrenadaError(estado);
}

/**
 * AC4 — Levanta el freno a mano, con la causa ya corregida.
 *
 * No hay ningún interruptor que apagar: se escribe la reactivación en la bitácora y la medición
 * pasa a arrancar ahí, con lo que la ventana queda vacía y las operaciones vuelven a permitirse sin
 * esperar a que expire. Quién y cuándo quedan en una tabla que nadie puede editar ni borrar.
 *
 * Devuelve el estado RECALCULADO después de escribir, y no un `{ ok: true }`: como
 * `registrarOperacion` se traga sus errores para no tumbar operaciones de negocio, un `ok` fijo
 * podría estar mintiendo. Si la escritura falló, el estado devuelto sigue diciendo `frenada: true`.
 */
export async function reactivarIntegracion(args: {
  usuarioId: number | null;
  ambiente?: SiigoAmbiente;
  nota?: string;
}): Promise<EstadoFrenoSiigo> {
  const ambiente = args.ambiente ?? env.SIIGO_AMBIENTE;
  const modo = modoSiigo();

  await registrarOperacion({
    operacion: OPERACION_REACTIVACION,
    ambiente,
    modo,
    // `ok` y no un resultado de error: la reactivación no es un fallo, y además el conteo la excluye
    // por nombre de operación, así que no altera ninguna proporción.
    resultado: 'ok',
    codigo: 'freno_reactivado',
    mensaje: args.nota?.trim()
      ? `Integración reactivada manualmente. ${args.nota.trim()}`
      : 'Integración reactivada manualmente.',
    createdBy: args.usuarioId,
  });

  return estadoFreno({ ambiente });
}
