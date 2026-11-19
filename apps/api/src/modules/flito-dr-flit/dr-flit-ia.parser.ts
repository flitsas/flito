// Dr. Flit IA — parser estricto de la salida del modelo (HU #13856, Feature #13696, IA-4).
// Diseño: docs/diseno/feature-13696-dr-flit-ia.md («Parser estricto (servidor)»). La salida estructurada
// nativa de la API ayuda, pero la GARANTÍA es este parser: nada del modelo llega al cliente sin pasar aquí.
//
// Reglas, en orden (RN-DRF-IA1..IA8):
//   1. JSON no parseable, campo extra, intent fuera del enum, tipos erróneos → `respuesta-invalida`.
//   2. Cita con `clave` fuera de las fichas enviadas en el contexto (índice incluido) → `respuesta-invalida`.
//   3. Cita con `ancla` que no existe en esa ficha → se conserva SIN ancla (enlaza a la ficha).
//   4. `duda` + `enManuales=true` sin ninguna cita válida → `respuesta-invalida`.
//   5. `gestion` → `reply=null`; `gestionTarget` obligatorio; `gestionRef` solo si es un token de la
//      petición y del tipo de `gestionTarget` (placa→PLACA, vin→VIN, tramite→TRAMITE, cliente→DOC); si no, null.
//   6. `soporte` → `reply=null`.
//   7. `reply` como texto plano: sin URLs ni etiquetas HTML.
//   8. Fuera de `gestion`, `gestionTarget` y `gestionRef` → null.
import { z } from 'zod';
import {
  GESTION_TARGETS_DRFLIT, INTENTS_DRFLIT, LIMITES_CHAT_DRFLIT, tipoDeTokenMascara,
  type CitaDrFlit, type GestionTargetDrFlit, type IntentDrFlit, type TipoMascara,
} from '@operaciones/shared-types';
import type { FichaAyudaApi } from './dr-flit-ia.contexto.js';

const salidaSchema = z.object({
  intent: z.enum(INTENTS_DRFLIT),
  reply: z.string().max(LIMITES_CHAT_DRFLIT.replyMax),
  enManuales: z.boolean(),
  citas: z.array(z.object({
    clave: z.string().max(100),
    ancla: z.string().max(200).nullable(),
  }).strict()).max(LIMITES_CHAT_DRFLIT.citasMax),
  gestionTarget: z.enum(GESTION_TARGETS_DRFLIT).nullable(),
  gestionRef: z.string().max(40).nullable(),
}).strict();

const nulo = <T extends Record<string, unknown>>(t: T) => ({ anyOf: [t, { type: 'null' }] });

/**
 * El mismo contrato como JSON Schema para `output_config.format` de la Messages API. Sin restricciones
 * de longitud/cantidad (la salida estructurada no las admite): esas las aplica `salidaSchema`.
 */
export const ESQUEMA_JSON_SALIDA_IA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['intent', 'reply', 'enManuales', 'citas', 'gestionTarget', 'gestionRef'],
  properties: {
    intent: { type: 'string', enum: [...INTENTS_DRFLIT] },
    reply: { type: 'string' },
    enManuales: { type: 'boolean' },
    citas: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['clave', 'ancla'],
        properties: { clave: { type: 'string' }, ancla: nulo({ type: 'string' }) },
      },
    },
    gestionTarget: nulo({ type: 'string', enum: [...GESTION_TARGETS_DRFLIT] }),
    gestionRef: nulo({ type: 'string' }),
  },
});

const TIPO_TOKEN_POR_TARGET: Readonly<Record<GestionTargetDrFlit, TipoMascara>> = Object.freeze({
  placa: 'PLACA', vin: 'VIN', tramite: 'TRAMITE', cliente: 'DOC',
});

export interface SalidaIaNormalizada {
  intent: IntentDrFlit;
  reply: string | null;
  enManuales: boolean;
  citas: CitaDrFlit[];
  citedSlugs: string[];
  gestionTarget: GestionTargetDrFlit | null;
  gestionRef: string | null;
}

export type ResultadoParserIa = { ok: true; salida: SalidaIaNormalizada } | { ok: false };

export interface ContextoParser {
  /** Fichas cuyo índice/secciones se enviaron al modelo (las visibles del usuario). */
  fichas: readonly FichaAyudaApi[];
  /** Tokens de máscara presentes en la petición (mensaje + historial, ya re-enmascarados). */
  tokensPeticion: readonly string[];
}

const RE_URL = /\b(?:https?:\/\/|www\.)\S+/gi;
const RE_ETIQUETA = /<\/?[A-Za-z!][^<>]*>/g;

/** Regla 7: texto plano, sin URLs ni etiquetas HTML; espacios colapsados. */
export function textoPlano(s: string): string {
  return s.replace(RE_ETIQUETA, ' ').replace(RE_URL, ' ').replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n').trim();
}

const INVALIDA: ResultadoParserIa = Object.freeze({ ok: false });

/** Aplica las reglas 1..8 al texto crudo del modelo. Nunca lanza. */
export function parsearSalidaIa(crudo: string, ctx: ContextoParser): ResultadoParserIa {
  let json: unknown;
  try {
    json = JSON.parse(crudo.trim());
  } catch {
    return INVALIDA;
  }
  const r = salidaSchema.safeParse(json);
  if (!r.success) return INVALIDA;
  const s = r.data;

  const porClave = new Map(ctx.fichas.map((f) => [f.clave, f]));
  const citas: CitaDrFlit[] = [];
  const vistas = new Set<string>();
  for (const c of s.citas) {
    const ficha = porClave.get(c.clave);
    if (!ficha) return INVALIDA; // regla 2
    const seccion = c.ancla === null ? undefined : ficha.secciones.find((x) => x.ancla === c.ancla);
    const ancla = seccion ? seccion.ancla : null; // regla 3
    const llave = `${ficha.clave}#${ancla ?? ''}`;
    if (vistas.has(llave)) continue;
    vistas.add(llave);
    citas.push({ clave: ficha.clave, ancla, tituloFicha: ficha.etiqueta, tituloSeccion: seccion?.titulo ?? null });
  }
  if (s.intent === 'duda' && s.enManuales && citas.length === 0) return INVALIDA; // regla 4

  let gestionTarget: GestionTargetDrFlit | null = null;
  let gestionRef: string | null = null;
  if (s.intent === 'gestion') {
    if (s.gestionTarget === null) return INVALIDA; // regla 5: obligatorio
    gestionTarget = s.gestionTarget;
    const ref = s.gestionRef;
    gestionRef = ref !== null && ctx.tokensPeticion.includes(ref)
      && tipoDeTokenMascara(ref) === TIPO_TOKEN_POR_TARGET[gestionTarget] ? ref : null;
  } // regla 8: fuera de gestion quedan null

  const reply = s.intent === 'gestion' || s.intent === 'soporte' ? null : textoPlano(s.reply); // reglas 5, 6, 7
  return {
    ok: true,
    salida: {
      intent: s.intent,
      reply,
      enManuales: s.enManuales,
      citas,
      citedSlugs: [...new Set(citas.map((c) => c.clave))],
      gestionTarget,
      gestionRef,
    },
  };
}
