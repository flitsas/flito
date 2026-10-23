// Dr. Flit — enmascaramiento de PII antes de enviar texto a la IA (HU #13855, Feature #13696 IA-3).
// Diseño: docs/diseno/feature-13696-dr-flit-ia.md §Enmascaramiento (navegador) y restauración.
//
// PURO y sin imports: lo usan el web (enmascara el envío; `apps/web/src/lib/drFlitIa.ts`) y el API
// (re-enmascara como defensa, IA-4). También es la ÚNICA fuente de los patrones de valor de gestión
// de F6 (`apps/web/src/lib/drFlitGestion.ts` los importa de aquí).
//
// El mapa `token → valor` vive solo en memoria de quien llama: son `Map`, así que un
// `JSON.stringify` accidental lo vuelca como `{}` (AC5). Nada aquí escribe en consola.
//
// Formatos cubiertos (decisión humana 2026-10-23): además de los valores «limpios», cédula/NIT y
// teléfono con separadores (`1 020 304 050`, `1,020,304,050`, `300-123-4567`, `+57 300 123 4567`),
// NIT con DV separado (`900123456 - 7`), placa con guion o espacio (`ABC-123`, `ABC 123`) y dígitos
// de ancho completo (se normaliza con NFKC antes de detectar).
//
// REGLA DE AGRUPACIÓN DE DÍGITOS (para no fusionar números independientes de una frase):
//   un primer grupo de 1–4 dígitos, seguido de grupos de EXACTAMENTE 3 dígitos (el último puede
//   tener 4, forma de teléfono 3-3-4), todos separados por UN MISMO separador de un carácter
//   (espacio, guion, coma o punto), sin letra ni dígito pegado a los bordes. Se une si:
//     · separador espacio/guion/coma → al menos 3 grupos; con punto (miles) → al menos 2 grupos;
//     · y el total queda en 6–12 dígitos (un DV ` - 7` al final no cuenta y se conserva).
//   Así «2026 y 30», «2025 2026», «el 2026 300», «2026-10-23» o «123 456» NO cambian.
//   Sobre-enmascarado aceptado: montos con 3+ grupos (`1 000 000`, `1,500,000`) salen como DOC.
//   Límite: dos números pegados por un solo separador que en total pasan de 12 dígitos no se unen
//   ni se parten (quedan como están si ninguno es un documento limpio).
// Placa con ESPACIO solo en mayúsculas (`ABC 123`): en minúsculas «son 500» o «con 100» son frases.
//
// LÍMITES DECLARADOS (no se enmascaran): direcciones y nombres de personas. No hay patrón fiable
// sin falsos positivos masivos; la defensa es que el usuario no los necesita para preguntar.

// ── Patrones por token (anclados, sin bandera `g`: `test` no arrastra `lastIndex`) ────────────────
// Se evalúan sobre el token ya normalizado a mayúsculas (F6 hace lo mismo).

/** Placa de carro `ABC123`. */
export const PLACA_CARRO = /^[A-Z]{3}\d{3}$/;
/** Placa de moto `ABC12D`. */
export const PLACA_MOTO = /^[A-Z]{3}\d{2}[A-Z]$/;
/** VIN: 17 caracteres sin I/O/Q. Quien lo usa exige además al menos una letra y un dígito. */
export const VIN = /^[A-HJ-NPR-Z0-9]{17}$/;
/** Id FLIT: FLIT 1 `FLIT-0132456`, FLIT 2 `FT2-0000180` (sin distinguir mayúsculas). */
export const ID_FLIT = /^(FLIT|FT2)-\d+$/i;
/** Cédula, otro documento o teléfono: 6–12 dígitos ya normalizados (sin separadores ni `+57`). */
export const DOCUMENTO = /^\d{6,12}$/;
/** NIT con dígito de verificación `900123456-7` (los puntos se quitan antes de probar). */
export const NIT_DV = /^\d{6,10}-\d$/;
/** Placa con guion (`ABC-123`, `ABC-12D`), ya en mayúsculas. Su valor normalizado es sin guion. */
export const PLACA_CON_GUION = /^[A-Z]{3}-(?:\d{3}|\d{2}[A-Z])$/;
/** Correo electrónico. */
export const CORREO = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;

/** `true` si el token (en mayúsculas) es un VIN: patrón + al menos una letra y un dígito. */
export function esVin(token: string): boolean {
  return VIN.test(token) && /[A-Z]/.test(token) && /\d/.test(token);
}

// ── Tokens de máscara ─────────────────────────────────────────────────────────────────────────────

export const TIPOS_MASCARA = ['PLACA', 'VIN', 'DOC', 'CORREO', 'TRAMITE'] as const;
export type TipoMascara = (typeof TIPOS_MASCARA)[number];

/** Estado de un envío: mismo valor → mismo token en todo el payload (AC4). Solo en memoria. */
export interface MapaMascara {
  /** `TIPO|valor normalizado` → token. */
  readonly porValor: Map<string, string>;
  /** token → valor normalizado. */
  readonly porToken: Map<string, string>;
  readonly contadores: Map<TipoMascara, number>;
}

export function crearMapaMascara(): MapaMascara {
  return { porValor: new Map(), porToken: new Map(), contadores: new Map() };
}

function tokenPara(tipo: TipoMascara, valor: string, mapa: MapaMascara): string {
  const clave = `${tipo}|${valor}`;
  const existente = mapa.porValor.get(clave);
  if (existente) return existente;
  const n = (mapa.contadores.get(tipo) ?? 0) + 1;
  mapa.contadores.set(tipo, n);
  const token = `[${tipo}_${n}]`;
  mapa.porValor.set(clave, token);
  mapa.porToken.set(token, valor);
  return token;
}

// Regex globales: solo se usan con `String.prototype.replace` / `matchAll`, que no dependen del
// `lastIndex` previo (replace lo reinicia; matchAll clona la regex).
const RE_TOKEN_MASCARA = /\[(?:PLACA|VIN|DOC|CORREO|TRAMITE)_\d+\]/g;
const RE_CORREO = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
/** Bordes: ni letra/dígito pegado ni continuación `separador + dígito` (no empezar a mitad de un número). */
const INI = String.raw`(?<![A-Za-z0-9]|\d[ ,.\-])`;
const FIN = String.raw`(?![A-Za-z0-9]|[ ,.\-]\d)`;
/** Teléfono con prefijo `+57` (con o sin separadores 3-3-4). El valor guarda solo los 10 dígitos. */
const RE_TEL_57 = new RegExp(String.raw`(?<![A-Za-z0-9+])\+57[ .\-]?(\d{3}([ .\-]?)\d{3}\2\d{4})` + FIN, 'g');
/** Dígitos agrupados (ver REGLA DE AGRUPACIÓN arriba), con DV opcional ` - 7`. */
const RE_NUM_AGRUPADO = new RegExp(
  INI + String.raw`(\d{1,4})([ ,.\-])\d{3}(?:\2\d{3})*(?:\2\d{4})?(?: ?- ?(\d))?` + FIN, 'g',
);
/** NIT de 6–10 dígitos con DV separado por espacios (`900123456 - 7`). */
const RE_NIT_DV_ESPACIADO = new RegExp(INI + String.raw`(\d{6,10}) ?- ?(\d)` + FIN, 'g');
/** Placa con guion (cualquier caja) o con espacio (solo mayúsculas). */
const RE_PLACA_SEPARADA = /(?<![A-Za-z0-9])(?:([A-Za-z]{3})-(\d{3}|\d{2}[A-Za-z])|([A-Z]{3}) (\d{3}|\d{2}[A-Z]))(?![A-Za-z0-9])/g;
/** Candidato a token de valor (letras, dígitos y guion interior), como el detector de F6. */
const RE_CANDIDATO = /[A-Za-z0-9-]+/g;

/** Tipo del token (sin guiones al borde) o `null`. Orden: id FLIT y NIT antes que número; VIN antes que placa. */
function tipoDeCandidato(core: string): { tipo: TipoMascara; valor: string } | null {
  const up = core.toUpperCase();
  if (ID_FLIT.test(up)) return { tipo: 'TRAMITE', valor: up };
  if (NIT_DV.test(up)) return { tipo: 'DOC', valor: up };
  if (esVin(up)) return { tipo: 'VIN', valor: up };
  if (PLACA_CARRO.test(up) || PLACA_MOTO.test(up)) return { tipo: 'PLACA', valor: up };
  if (DOCUMENTO.test(up)) return { tipo: 'DOC', valor: up };
  return null;
}

function enmascararTramo(tramo: string, mapa: MapaMascara): string {
  // 1) Correo primero: su parte local puede contener números o algo con forma de placa.
  let s = tramo.replace(RE_CORREO, (c) => tokenPara('CORREO', c.toLowerCase(), mapa));
  // 2) Teléfono con +57: el prefijo no forma parte del valor.
  s = s.replace(RE_TEL_57, (_m, tel: string) => tokenPara('DOC', tel.replace(/\D/g, ''), mapa));
  // 3) Dígitos agrupados (cédula/NIT/teléfono con separadores), con DV opcional.
  s = s.replace(RE_NUM_AGRUPADO, (m, _g1: string, sep: string, dv: string | undefined) => {
    const cuerpo = dv === undefined ? m : m.replace(/ ?- ?\d$/, '');
    const grupos = cuerpo.split(sep).length;
    const digitos = cuerpo.replace(/\D/g, '');
    if (grupos < (sep === '.' ? 2 : 3) || !DOCUMENTO.test(digitos)) return m;
    if (dv === undefined) return tokenPara('DOC', digitos, mapa);
    return digitos.length <= 10 ? tokenPara('DOC', `${digitos}-${dv}`, mapa) : m;
  });
  // 4) NIT con DV separado por espacios: un solo DOC con el DV (no queda el DV suelto).
  s = s.replace(RE_NIT_DV_ESPACIADO, (_m, nit: string, dv: string) => tokenPara('DOC', `${nit}-${dv}`, mapa));
  // 5) Placa con guion o espacio → valor normalizado sin separador (`ABC123`).
  s = s.replace(RE_PLACA_SEPARADA, (_m, l1?: string, n1?: string, l2?: string, n2?: string) =>
    tokenPara('PLACA', `${l1 ?? l2}${n1 ?? n2}`.toUpperCase(), mapa));
  // 6) Resto por token: id FLIT, NIT con DV, VIN, placa, documento. Los tokens ya puestos van entre
  //    corchetes y sus partes (`PLACA`, `1`) no casan con ningún patrón.
  return s.replace(RE_CANDIDATO, (crudo) => {
    const ini = crudo.match(/^-*/)?.[0] ?? '';
    const fin = crudo.slice(ini.length).match(/-*$/)?.[0] ?? '';
    const core = crudo.slice(ini.length, crudo.length - fin.length);
    if (!core) return crudo;
    const hallado = tipoDeCandidato(core);
    return hallado ? `${ini}${tokenPara(hallado.tipo, hallado.valor, mapa)}${fin}` : crudo;
  });
}

/**
 * Cambia placa, VIN, documento/NIT/teléfono (6–12 dígitos), correo e id FLIT por `[TIPO_n]`
 * (AC1/AC2), también con separadores (ver cabecera). Menos de 6 dígitos no se toca (AC3).
 * El texto se normaliza con NFKC antes de detectar (dígitos/letras de ancho completo). Pasar el mismo `mapa` a
 * todos los textos de un envío numera de forma consistente (AC4). Un token ya presente se respeta.
 */
export function enmascarar(crudo: string, mapa: MapaMascara = crearMapaMascara()): string {
  const texto = crudo.normalize('NFKC');
  let salida = '';
  let desde = 0;
  for (const m of texto.matchAll(RE_TOKEN_MASCARA)) {
    const idx = m.index ?? 0;
    salida += enmascararTramo(texto.slice(desde, idx), mapa) + m[0];
    desde = idx + m[0].length;
  }
  return salida + enmascararTramo(texto.slice(desde), mapa);
}

/** Tokens de máscara presentes en el texto, sin repetir y en orden de aparición. */
export function tokensDe(texto: string): string[] {
  return [...new Set([...texto.matchAll(RE_TOKEN_MASCARA)].map((m) => m[0]))];
}

/** Tipo de un token de máscara (`[PLACA_2]` → `PLACA`) o `null` si no tiene esa forma. */
export function tipoDeTokenMascara(token: string): TipoMascara | null {
  const m = /^\[(PLACA|VIN|DOC|CORREO|TRAMITE)_\d+\]$/.exec(token);
  return m ? (m[1] as TipoMascara) : null;
}

/** Valor (normalizado) del token en este envío; `null` si el token no existe (AC6). */
export function restaurar(token: string, mapa: MapaMascara): string | null {
  return mapa.porToken.get(token) ?? null;
}

/** Cambia en el texto los tokens conocidos por su valor (solo para mostrar); los desconocidos quedan. */
export function restaurarTexto(texto: string, mapa: MapaMascara): string {
  return texto.replace(RE_TOKEN_MASCARA, (t) => mapa.porToken.get(t) ?? t);
}
