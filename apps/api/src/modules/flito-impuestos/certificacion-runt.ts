/**
 * Motor de comparación de la certificación de impuestos contra el RUNT (HU #11164).
 *
 * PURO: sin red y sin base de datos, igual que `derivePreflightChecks` en `tramites/preflight.ts`.
 * Toda la orquestación (consultar el RUNT, persistir, auditar) vive en el servicio; aquí solo se
 * decide, dados dos juegos de datos, si el impuesto es certificable y por qué. Eso permite cubrir
 * las reglas con Vitest sin tocar el RUNT, que es lento, tiene captcha de pago en modo directo y no
 * se puede invocar desde CI.
 *
 * Qué se compara y qué no: ver `flito-certificacion.ts` en shared-types. En corto — el RUNT no
 * devuelve al propietario, así que la propiedad se valida por construcción (la consulta se autentica
 * con placa + documento) y solo placa y VIN se contrastan campo a campo.
 */

import {
  CAMPOS_BLOQUEANTES,
  CampoCertificacion,
  ResultadoCampo,
  type ComparacionCampo,
  type DatosVehiculoFlito,
  type DatosVehiculoRunt,
  type VeredictoComparacion,
} from '@operaciones/shared-types';

/**
 * Normaliza un identificador para compararlo: mayúsculas y solo alfanuméricos.
 *
 * Mismo criterio con el que `runt.service.ts` construye la consulta (`toUpperCase()` +
 * `replace(/[^A-Z0-9]/g, '')`). Debe ser el mismo: si normalizáramos distinto, una placa que el RUNT
 * aceptó para consultar podría luego «no coincidir» consigo misma.
 */
export function normalizarIdentificador(v: unknown): string | null {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const s = String(v).toUpperCase().replace(/[^A-Z0-9]/g, '');
  return s.length > 0 ? s : null;
}

/** Texto libre (marca, línea…): mayúsculas, sin tildes, sin espacios repetidos. */
export function normalizarTexto(v: unknown): string | null {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const s = String(v)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toUpperCase().replace(/\s+/g, ' ').trim();
  return s.length > 0 ? s : null;
}

/** Primer alias con valor útil. El RUNT no es consistente con los nombres de sus campos. */
function primero(fuente: Record<string, unknown> | null | undefined, claves: readonly string[]): string | null {
  if (!fuente) return null;
  for (const k of claves) {
    const v = fuente[k];
    if (v === null || v === undefined) continue;
    const s = String(v).trim();
    if (s.length > 0 && s.toLowerCase() !== 'null') return s;
  }
  return null;
}

/**
 * Extrae los datos comparables de la respuesta cruda del RUNT.
 *
 * Verificado contra una consulta REAL (placa QIU744, 2026-07-31). `data.vehiculo` trae:
 *
 *   placa "QIU744" · vin "3KPFF51ABTE156687" · numChasis (mismo valor) · numSerie null
 *   marca "KIA" · linea "K3 CROSS" · modelo "2026" · clase "CAMIONETA" · clasificacion "AUTOMOVIL"
 *   cilindraje · color · tipoServicio · organismoTransito · numMotor · idAutomotor · …
 *
 * Es decir: `vin` viene con ese nombre exacto y dentro de `vehiculo`, y la clase es `clase` —no
 * `claseVehiculo`—, aunque el repo ya contemplaba las dos (`soat/batch.routes.ts:107-109`). Las
 * cadenas de alias se conservan igualmente: el payload varía por tipo de vehículo (una moto o un
 * remolque no traen los mismos campos) y un alias de más no cuesta nada.
 *
 * Ojo con `clase` frente a `clasificacion`: son campos distintos con valores distintos
 * ("CAMIONETA" y "AUTOMOVIL" para el mismo vehículo). Se toma `clase`, y como es informativo no
 * bloquea aunque no cuadre con lo que FLITO tenga.
 *
 * El VIN se busca además en `datosTecnicos` por si algún tipo de vehículo lo publica solo ahí. Si no
 * aparece por ninguna vía se devuelve `null` y el campo se marca NO_VERIFICABLE: no bloquea (AC4).
 * Preferimos no certificar el VIN a inventarnos que coincide.
 */
export function extraerVehiculoRunt(data: unknown): DatosVehiculoRunt {
  const d = (data ?? {}) as Record<string, unknown>;
  const veh = (d.vehiculo ?? {}) as Record<string, unknown>;
  const tec = (d.datosTecnicos ?? {}) as Record<string, unknown>;

  return {
    placa: primero(veh, ['placa', 'noPlaca', 'numeroPlaca', 'nroPlaca']),
    vin: primero(veh, ['vin', 'noVin', 'numeroVin', 'nroVin', 'serie', 'noSerie', 'numeroSerie', 'chasis', 'noChasis'])
      ?? primero(tec, ['vin', 'noVin', 'numeroVin', 'nroVin', 'serie', 'noSerie', 'numeroSerie', 'chasis', 'noChasis']),
    marca: primero(veh, ['marca', 'nombreMarca']) ?? primero(tec, ['marca', 'nombreMarca']),
    linea: primero(veh, ['linea', 'nombreLinea']) ?? primero(tec, ['linea', 'nombreLinea']),
    modelo: primero(veh, ['modelo', 'anioModelo', 'anoModelo']) ?? primero(tec, ['modelo', 'anioModelo', 'anoModelo']),
    clase: primero(veh, ['claseVehiculo', 'clase', 'nombreClase']) ?? primero(tec, ['claseVehiculo', 'clase', 'nombreClase']),
  };
}

/** Campos que se comparan como identificador (exacto tras normalizar) y no como texto libre. */
const CAMPOS_IDENTIFICADOR: readonly CampoCertificacion[] = [CampoCertificacion.PLACA, CampoCertificacion.VIN];

const ORDEN_CAMPOS: readonly CampoCertificacion[] = [
  CampoCertificacion.PLACA,
  CampoCertificacion.VIN,
  CampoCertificacion.MARCA,
  CampoCertificacion.LINEA,
  CampoCertificacion.MODELO,
  CampoCertificacion.CLASE,
];

function compararCampo(
  campo: CampoCertificacion,
  valorFlito: string | null,
  valorRunt: string | null,
): ComparacionCampo {
  const bloqueante = CAMPOS_BLOQUEANTES.includes(campo);
  const norm = CAMPOS_IDENTIFICADOR.includes(campo) ? normalizarIdentificador : normalizarTexto;
  const a = norm(valorFlito);
  const b = norm(valorRunt);

  // El orden importa: «el RUNT no lo reportó» y «FLITO no lo tiene» son diagnósticos distintos y
  // ninguno de los dos es una discrepancia. Colapsarlos en DIFIERE haría fallar certificaciones
  // correctas por un dato que simplemente no existe en ninguno de los dos lados.
  let resultado: ResultadoCampo;
  if (b === null) resultado = ResultadoCampo.NO_VERIFICABLE;
  else if (a === null) resultado = ResultadoCampo.SIN_DATO_FLITO;
  else resultado = a === b ? ResultadoCampo.COINCIDE : ResultadoCampo.DIFIERE;

  return { campo, resultado, bloqueante, valorFlito: valorFlito ?? null, valorRunt: valorRunt ?? null };
}

/**
 * Compara los datos de FLITO con los del RUNT y decide si el impuesto es certificable.
 *
 * Certificable = ningún campo bloqueante DIFIERE. Un bloqueante NO_VERIFICABLE o SIN_DATO_FLITO no
 * impide certificar: la prueba de propiedad (RN-02) ya se obtuvo al responder el RUNT, y un VIN que
 * el RUNT no publica no es motivo para frenar un pago correcto. El certificado deja constancia de
 * qué se pudo verificar y qué no, que es lo que una auditoría necesita saber.
 */
export function compararConRunt(flito: DatosVehiculoFlito, runt: DatosVehiculoRunt): VeredictoComparacion {
  const campos = ORDEN_CAMPOS.map((c) => compararCampo(c, flito[c], runt[c]));
  const diferenciasBloqueantes = campos.filter((c) => c.bloqueante && c.resultado === ResultadoCampo.DIFIERE);
  return { certificable: diferenciasBloqueantes.length === 0, campos, diferenciasBloqueantes };
}

/**
 * ¿El RUNT rechazó la consulta porque el traspaso aún está sincronizando? (RN-08)
 *
 * Tras un traspaso el RUNT tarda 24-72 horas hábiles en reconocer al nuevo propietario y hasta
 * entonces rechaza la consulta placa + documento con un mensaje que menciona al propietario. No es
 * un fallo del servicio ni un dato mal digitado: basta reintentar más tarde. `soat/refresh.service`
 * ya distingue este caso con la misma prueba; se replica aquí en vez de importarla porque aquel
 * módulo la aplica sobre su propio flujo y acoplarlos ataría dos ciclos de vida sin necesidad.
 */
export function esTraspasoEnSincronizacion(mensaje: string | null | undefined): boolean {
  return /propietari/i.test(mensaje ?? '');
}
