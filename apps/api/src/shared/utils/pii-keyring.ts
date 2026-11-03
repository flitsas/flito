// Feature #13978, HU #14100 (ADR-0034 D1, D2, D8) — llaves de `PII_ENC_KEY` por versión.
//
// `PII_ENC_KEY` es la versión 1 para siempre; `PII_ENC_KEY_V<n>` son las versiones n ≥ 2. Se lee cada
// valor con la llave de su versión y se escribe con la vigente (`PII_ENC_KEY_CURRENT_VERSION`).
//
// Este archivo NO importa `config/env.ts`: `env.ts` usa `validarLlavesPii` mientras se evalúa, y un
// import de vuelta dejaría al primero de los dos que se cargue viendo al otro a medio inicializar.
// Quien llama le pasa la pasada de la versión 1.
import crypto from 'crypto';

type FuenteEnv = Record<string, string | undefined>;

const PREFIJO_VERSIONADA = 'PII_ENC_KEY_V';
/** Sin ceros a la izquierda: `V02` y `V2` serían dos nombres para la misma versión. */
const RE_VERSION_CANONICA = /^[1-9]\d*$/;
/** La versión se guarda en columnas `smallint`. */
const VERSION_MAXIMA = 32767;
const LARGO_MINIMO = 32;
/**
 * Bits por carácter. La salida de `openssl rand -hex 32` ronda 3,8: el corte queda lejos de ella para
 * no rechazar una llave buena por azar, y sigue dejando fuera repeticiones como `abcabc…`.
 */
const ENTROPIA_MINIMA = 3;

/** La sal de la versión 1 no se puede cambiar: dejaría de leer todo lo que ya está cifrado. */
export function salPii(version: number): string {
  return version === 1 ? 'kyverum-pii-2026' : `flito-pii-v${version}`;
}

/** Pasada de una versión, o `undefined` si no está configurada. Vacía cuenta como ausente. */
export function pasadaPii(
  version: number,
  pasadaV1: string | undefined,
  fuente: FuenteEnv = process.env,
): string | undefined {
  if (version === 1) return pasadaV1 || undefined;
  if (!Number.isInteger(version) || version < 2) return undefined;
  return fuente[`${PREFIJO_VERSIONADA}${version}`] || undefined;
}

/** Versiones configuradas, de menor a mayor. */
export function versionesPiiConfiguradas(pasadaV1: string | undefined, fuente: FuenteEnv = process.env): number[] {
  const versiones = pasadaV1 ? [1] : [];
  for (const [nombre, valor] of Object.entries(fuente)) {
    if (!nombre.startsWith(PREFIJO_VERSIONADA) || !valor) continue;
    const version = nombre.slice(PREFIJO_VERSIONADA.length);
    if (RE_VERSION_CANONICA.test(version) && Number(version) >= 2) versiones.push(Number(version));
  }
  return versiones.sort((a, b) => a - b);
}

/** Deriva sin guardar. Sirve para probar una pasada con la sal de otra versión, sin tocar el memo. */
export function derivarLlavePii(version: number, pasada: string): Buffer {
  return crypto.scryptSync(pasada, salPii(version), 32);
}

// Memo por versión Y pasada: scrypt cuesta decenas de ms y una fila de biometría pide tres descifrados
// por petición. Guardar la pasada junto a la llave es lo que hace que un cambio de la variable
// re-derive en vez de seguir descifrando con la llave anterior.
const memo = new Map<number, { pasada: string; llave: Buffer }>();

export function llavePiiMemoizada(version: number, pasada: string): Buffer {
  const guardada = memo.get(version);
  if (guardada?.pasada === pasada) return guardada.llave;
  const llave = derivarLlavePii(version, pasada);
  memo.set(version, { pasada, llave });
  return llave;
}

function entropiaPorCaracter(valor: string): number {
  const conteos = new Map<string, number>();
  for (const c of valor) conteos.set(c, (conteos.get(c) ?? 0) + 1);
  let entropia = 0;
  for (const n of conteos.values()) {
    const p = n / valor.length;
    entropia -= p * Math.log2(p);
  }
  return entropia;
}

export interface ProblemaLlavePii {
  variable: string;
  mensaje: string;
}

/**
 * Etapa estática (ADR-0034 D2): sin BD y sin derivar, para que corra en todo lo que importe `env`.
 * Los mensajes nombran variables y nunca llevan valores.
 *
 * La versión 1 solo pasa por el `min(32)` de su esquema: una regla de entropía nueva podría tumbar un
 * ambiente que ya funciona con su llave actual.
 */
export function validarLlavesPii(
  pasadaV1: string | undefined,
  versionVigente: number,
  fuente: FuenteEnv = process.env,
): ProblemaLlavePii[] {
  const problemas: ProblemaLlavePii[] = [];
  const nombrePorPasada = new Map<string, string>();
  const registrarPasada = (variable: string, pasada: string) => {
    const otra = nombrePorPasada.get(pasada);
    if (otra) problemas.push({ variable, mensaje: `${variable} y ${otra} tienen la misma llave: cada versión necesita la suya` });
    else nombrePorPasada.set(pasada, variable);
  };
  if (pasadaV1) registrarPasada('PII_ENC_KEY', pasadaV1);

  for (const [variable, valor] of Object.entries(fuente)) {
    if (!variable.startsWith(PREFIJO_VERSIONADA) || !valor) continue;
    const version = variable.slice(PREFIJO_VERSIONADA.length);
    if (version === '1') {
      problemas.push({ variable, mensaje: 'PII_ENC_KEY_V1 no se admite: la versión 1 es PII_ENC_KEY' });
      continue;
    }
    if (!RE_VERSION_CANONICA.test(version) || Number(version) > VERSION_MAXIMA) {
      problemas.push({ variable, mensaje: `${variable} no es un nombre válido: se espera PII_ENC_KEY_V<n> con n entre 2 y ${VERSION_MAXIMA}` });
      continue;
    }
    if (valor.length < LARGO_MINIMO) {
      problemas.push({ variable, mensaje: `${variable} debe tener al menos ${LARGO_MINIMO} caracteres` });
    } else if (entropiaPorCaracter(valor) < ENTROPIA_MINIMA) {
      problemas.push({ variable, mensaje: `${variable} tiene entropía insuficiente` });
    }
    registrarPasada(variable, valor);
  }

  if (!pasadaPii(versionVigente, pasadaV1, fuente)) {
    const falta = versionVigente === 1 ? 'PII_ENC_KEY' : `${PREFIJO_VERSIONADA}${versionVigente}`;
    problemas.push({
      variable: 'PII_ENC_KEY_CURRENT_VERSION',
      mensaje: `La versión vigente ${versionVigente} no tiene llave: falta ${falta}`,
    });
  }
  return problemas;
}
