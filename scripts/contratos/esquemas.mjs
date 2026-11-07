// Conversión a JSON Schema de lo que el verificador de TypeScript sabe de un esquema de Zod o de un tipo de TS. La usa
// generar-openapi.mjs. Regla de la casa: si el tipo no dice nada (any, unknown, un genérico opaco), el nodo sale con
// `[por verificar]` en la descripción y se cuenta; NUNCA se inventa un campo.

import ts from 'typescript';

export const POR_VERIFICAR = '[por verificar]';
const TOPE_NODOS = 250;
const TOPE_PROFUNDIDAD = 7;

/** Contexto de una conversión: cuenta nodos y lo que quedó sin derivar. */
export function nuevoContexto(checker) {
  return { checker, nodos: 0, dudas: 0 };
}

function duda(ctx, motivo) {
  ctx.dudas += 1;
  return { description: `${POR_VERIFICAR} ${motivo}` };
}

const nombreDe = (t) => t.aliasSymbol?.name ?? t.symbol?.name ?? '';
const argsDe = (ctx, t) => {
  if (t.aliasTypeArguments?.length && !t.symbol?.name?.startsWith('Zod')) return t.aliasTypeArguments;
  if (t.objectFlags & ts.ObjectFlags.Reference) return ctx.checker.getTypeArguments(t);
  return t.aliasTypeArguments ?? [];
};

export function esTipoZod(checker, tipo) {
  if (!tipo) return false;
  const nombre = nombreDe(tipo);
  if (nombre.startsWith('Zod')) return true;
  return Boolean(tipo.getProperty?.('_zod') && tipo.getProperty?.('safeParse'));
}

const FORMATOS_TEXTO = {
  ZodString: undefined, ZodCoercedString: undefined, ZodCUID: undefined, ZodCUID2: undefined, ZodULID: undefined, ZodNanoID: undefined,
  ZodEmail: 'email', ZodUUID: 'uuid', ZodGUID: 'uuid', ZodURL: 'uri', ZodISODateTime: 'date-time', ZodISODate: 'date', ZodISOTime: 'time',
  ZodIPv4: 'ipv4', ZodIPv6: 'ipv6', ZodBase64: 'byte', ZodStringFormat: undefined,
};

function conNulo(esquema) {
  const enumConNulo = esquema.enum ? { enum: [...new Set([...esquema.enum, null])] } : {};
  if (Array.isArray(esquema.type)) return esquema.type.includes('null') ? { ...esquema, ...enumConNulo } : { ...esquema, type: [...esquema.type, 'null'], ...enumConNulo };
  if (typeof esquema.type === 'string') return { ...esquema, type: esquema.type === 'null' ? 'null' : [esquema.type, 'null'], ...enumConNulo };
  if (esquema.enum) return { ...esquema, ...enumConNulo };
  if (esquema.anyOf) return { ...esquema, anyOf: [...esquema.anyOf, { type: 'null' }] };
  if (Object.keys(esquema).every((k) => k === 'description')) return esquema;
  return { anyOf: [esquema, { type: 'null' }] };
}

function literalesDe(ctx, t) {
  const partes = t.isUnion?.() ? t.types : [t];
  const valores = [];
  for (const p of partes) {
    if (p.isStringLiteral?.() || p.isNumberLiteral?.()) valores.push(p.value);
    else if (p.flags & ts.TypeFlags.BooleanLiteral) valores.push(ctx.checker.typeToString(p) === 'true');
    else if (p.flags & ts.TypeFlags.Null) valores.push(null);
    else return null;
  }
  return valores;
}

function tipoDeLiteral(valores) {
  const tipos = [...new Set(valores.map((v) => (v === null ? 'null' : typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'boolean' : 'string')))];
  return tipos.length === 1 ? tipos[0] : tipos;
}

/** Ajustes de un Zod `.min()/.max()/.email()...` leídos del AST de su inicializador, si lo hay a la vista. */
export function restriccionesDe(expr) {
  const r = {};
  let nodo = expr;
  while (nodo && ts.isCallExpression(nodo) && ts.isPropertyAccessExpression(nodo.expression)) {
    const metodo = nodo.expression.name.text;
    const a = nodo.arguments[0];
    const n = a && ts.isNumericLiteral(a) ? Number(a.text) : undefined;
    if (metodo === 'min' && n !== undefined) r.min = n;
    if (metodo === 'max' && n !== undefined) r.max = n;
    if (metodo === 'length' && n !== undefined) { r.min = n; r.max = n; }
    if (metodo === 'positive') r.exclusiveMinimum = 0;
    if (metodo === 'nonnegative') r.minimum = 0;
    if (metodo === 'int') r.int = true;
    if (metodo === 'email') r.format = 'email';
    if (metodo === 'uuid' || metodo === 'guid') r.format = 'uuid';
    if (metodo === 'url') r.format = 'uri';
    if (metodo === 'datetime') r.format = 'date-time';
    if (metodo === 'date') r.format = 'date';
    if (metodo === 'regex' && a && ts.isRegularExpressionLiteral(a)) {
      const m = /^\/(.*)\/[a-z]*$/s.exec(a.text);
      if (m) r.pattern = m[1];
    }
    nodo = nodo.expression.expression;
  }
  return r;
}

function aplicarRestricciones(esquema, r) {
  const tipos = Array.isArray(esquema.type) ? esquema.type : [esquema.type];
  const salida = { ...esquema };
  if (tipos.includes('string')) {
    if (r.min !== undefined) salida.minLength = r.min;
    if (r.max !== undefined) salida.maxLength = r.max;
    if (r.format) salida.format = r.format;
    if (r.pattern) salida.pattern = r.pattern;
  }
  if (tipos.includes('number') || tipos.includes('integer')) {
    if (r.min !== undefined) salida.minimum = r.min;
    if (r.max !== undefined) salida.maximum = r.max;
    if (r.minimum !== undefined) salida.minimum = r.minimum;
    if (r.exclusiveMinimum !== undefined) salida.exclusiveMinimum = r.exclusiveMinimum;
    if (r.int) salida.type = Array.isArray(esquema.type) ? esquema.type.map((t) => (t === 'number' ? 'integer' : t)) : 'integer';
  }
  if (tipos.includes('array')) {
    if (r.min !== undefined) salida.minItems = r.min;
    if (r.max !== undefined) salida.maxItems = r.max;
  }
  return salida;
}

const ENVOLTURAS = new Set(['ZodOptional', 'ZodExactOptional', 'ZodNullable', 'ZodDefault', 'ZodPrefault', 'ZodCatch', 'ZodReadonly', 'ZodNonOptional', 'ZodLazy', 'ZodPromise']);
const OPCIONALES = new Set(['ZodOptional', 'ZodExactOptional', 'ZodDefault', 'ZodPrefault', 'ZodCatch']);

function propiedadesDeZodObject(ctx, tipo, expr, prof) {
  const [forma] = argsDe(ctx, tipo);
  if (!forma) return duda(ctx, 'objeto de Zod sin forma visible para el verificador.');
  const properties = {};
  const required = [];
  const inicial = expresionObjeto(ctx, expr);
  for (const prop of ctx.checker.getPropertiesOfType(forma)) {
    const decl = prop.valueDeclaration ?? prop.declarations?.[0] ?? expr;
    const tipoProp = ctx.checker.getTypeOfSymbolAtLocation(prop, decl);
    const subExpr = inicial?.get(prop.name);
    properties[prop.name] = zodASchema(ctx, tipoProp, subExpr, prof + 1);
    if (!esZodOpcional(ctx, tipoProp)) required.push(prop.name);
  }
  const salida = { type: 'object', properties };
  if (required.length) salida.required = required;
  return salida;
}

/** Si el esquema se ve como `z.object({...})` (aunque lleve .strict() u otros), las expresiones de cada campo. */
function expresionObjeto(ctx, expr) {
  let nodo = resolverInicializador(ctx, expr);
  while (nodo && ts.isCallExpression(nodo) && ts.isPropertyAccessExpression(nodo.expression)) {
    const metodo = nodo.expression.name.text;
    if ((metodo === 'object' || metodo === 'strictObject' || metodo === 'looseObject') && nodo.arguments[0] && ts.isObjectLiteralExpression(nodo.arguments[0])) {
      const mapa = new Map();
      for (const p of nodo.arguments[0].properties) {
        if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) mapa.set(p.name.text, p.initializer);
      }
      return mapa;
    }
    nodo = resolverInicializador(ctx, nodo.expression.expression);
  }
  return null;
}

function resolverInicializador(ctx, expr, vueltas = 0) {
  if (!expr || vueltas > 4 || !ts.isIdentifier(expr)) return expr;
  let s = ctx.checker.getSymbolAtLocation(expr);
  if (s && s.flags & ts.SymbolFlags.Alias) s = ctx.checker.getAliasedSymbol(s);
  const d = s?.valueDeclaration;
  return d && ts.isVariableDeclaration(d) && d.initializer ? resolverInicializador(ctx, d.initializer, vueltas + 1) : expr;
}

function esZodOpcional(ctx, tipo) {
  const n = nombreDe(tipo);
  if (OPCIONALES.has(n)) return true;
  if (n === 'ZodNullable' || n === 'ZodReadonly' || n === 'ZodLazy') { const [a] = argsDe(ctx, tipo); return a ? esZodOpcional(ctx, a) : false; }
  if (n === 'ZodPipe') {
    const [a, b] = argsDe(ctx, tipo);
    return a && nombreDe(a) === 'ZodTransform' ? (b ? esZodOpcional(ctx, b) : false) : (a ? esZodOpcional(ctx, a) : false);
  }
  return false;
}

/** Esquema de Zod (por su TIPO, que resuelve .extend, .pick, spreads e imports) → JSON Schema de lo que ENTRA. */
export function zodASchema(ctx, tipo, expr, prof = 0) {
  ctx.nodos += 1;
  if (!tipo) return duda(ctx, 'esquema sin tipo.');
  if (prof > TOPE_PROFUNDIDAD + 3 || ctx.nodos > TOPE_NODOS * 2) return duda(ctx, 'esquema recortado por tamaño.');
  const n = nombreDe(tipo);
  const args = argsDe(ctx, tipo);
  const r = expr ? restriccionesDe(expr) : {};
  const fin = (e) => aplicarRestricciones(e, r);
  if (n in FORMATOS_TEXTO) return fin(FORMATOS_TEXTO[n] ? { type: 'string', format: FORMATOS_TEXTO[n] } : { type: 'string' });
  if (n === 'ZodNumber' || n === 'ZodCoercedNumber' || n === 'ZodFloat32' || n === 'ZodFloat64' || n === 'ZodNumberFormat') return fin({ type: 'number' });
  if (n === 'ZodInt' || n === 'ZodInt32' || n === 'ZodBigInt' || n === 'ZodCoercedBigInt') return fin({ type: 'integer' });
  if (n === 'ZodBoolean' || n === 'ZodCoercedBoolean' || n === 'ZodStringBool') return { type: 'boolean' };
  if (n === 'ZodDate' || n === 'ZodCoercedDate') return { type: 'string', format: 'date-time' };
  if (n === 'ZodNull') return { type: 'null' };
  if (n === 'ZodAny' || n === 'ZodUnknown' || n === 'ZodCustom' || n === 'ZodTypeAny' || n === 'ZodType') return duda(ctx, `el esquema acepta cualquier valor (${n}).`);
  if (n === 'ZodLiteral' || n === 'ZodEnum') {
    const a = args[0];
    if (!a) return duda(ctx, `${n} sin valores visibles.`);
    if (n === 'ZodLiteral') {
      const v = literalesDe(ctx, a);
      return v ? { type: tipoDeLiteral(v), enum: v } : duda(ctx, 'literal no resoluble.');
    }
    // `z.enum([...])` llega como { a: 'a' }; `z.enum(ObjetoOEnumDeTs)`, con el valor en el tipo de la propiedad.
    const valores = ctx.checker.getPropertiesOfType(a).map((p) => literalesDe(ctx, ctx.checker.getTypeOfSymbol(p))?.[0] ?? p.name);
    return valores.length ? { type: tipoDeLiteral(valores), enum: valores } : duda(ctx, 'enumeración cuyos valores no resuelve el verificador.');
  }
  if (n === 'ZodObject') return propiedadesDeZodObject(ctx, tipo, expr, prof);
  if (n === 'ZodArray' || n === 'ZodSet') return fin({ type: 'array', items: args[0] ? zodASchema(ctx, args[0], elementoDeArray(ctx, expr), prof + 1) : duda(ctx, 'arreglo sin tipo de elemento.') });
  if (n === 'ZodTuple') {
    const elementos = args[0] ? ctx.checker.getTypeArguments(args[0]) : [];
    return { type: 'array', prefixItems: elementos.map((e) => zodASchema(ctx, e, undefined, prof + 1)) };
  }
  if (n === 'ZodRecord' || n === 'ZodMap') return { type: 'object', additionalProperties: args[1] ? zodASchema(ctx, args[1], undefined, prof + 1) : true };
  if (n === 'ZodUnion' || n === 'ZodDiscriminatedUnion' || n === 'ZodXor') {
    const elementos = args[0] ? (ctx.checker.isTupleType(args[0]) ? ctx.checker.getTypeArguments(args[0]) : [args[0]]) : [];
    if (!elementos.length) return duda(ctx, 'unión sin miembros visibles.');
    return { anyOf: elementos.map((e) => zodASchema(ctx, e, undefined, prof + 1)) };
  }
  if (n === 'ZodIntersection') return { allOf: args.slice(0, 2).map((e) => zodASchema(ctx, e, undefined, prof + 1)) };
  if (n === 'ZodPipe') {
    // z.preprocess y .transform: lo que entra es el primero, salvo que el primero sea la transformación (preprocess).
    const [entra, sale] = args;
    if (entra && nombreDe(entra) === 'ZodTransform') return sale ? zodASchema(ctx, sale, undefined, prof + 1) : duda(ctx, 'preprocess sin esquema de salida.');
    return entra ? zodASchema(ctx, entra, expr, prof + 1) : duda(ctx, 'pipe sin entrada.');
  }
  if (ENVOLTURAS.has(n)) {
    if (!args[0]) return duda(ctx, `${n} sin tipo interno visible.`);
    const interno = zodASchema(ctx, args[0], envueltoDe(expr), prof + 1);
    return n === 'ZodNullable' ? conNulo(interno) : interno;
  }
  return duda(ctx, `tipo de Zod no reconocido (${n || ctx.checker.typeToString(tipo).slice(0, 60)}).`);
}

function elementoDeArray(ctx, expr) {
  let nodo = resolverInicializador(ctx, expr);
  while (nodo && ts.isCallExpression(nodo) && ts.isPropertyAccessExpression(nodo.expression)) {
    if (nodo.expression.name.text === 'array' && ts.isIdentifier(nodo.expression.expression) && nodo.arguments[0]) return nodo.arguments[0];
    nodo = nodo.expression.expression;
  }
  return undefined;
}

// `z.string().min(1).optional()`: las restricciones siguen en la cadena, así que el mismo nodo sirve para el interno.
const envueltoDe = (expr) => expr;

/** Tipo de TypeScript (lo que un handler pasa a res.json) → JSON Schema. */
export function tipoASchema(ctx, tipo, prof = 0, pila = new Set()) {
  ctx.nodos += 1;
  const { checker } = ctx;
  if (!tipo) return duda(ctx, 'sin tipo.');
  if (ctx.nodos > TOPE_NODOS || prof > TOPE_PROFUNDIDAD) return duda(ctx, 'respuesta recortada por tamaño.');
  const f = tipo.flags;
  if (f & ts.TypeFlags.Any) return duda(ctx, 'el código la tipa como `any`.');
  if (f & ts.TypeFlags.Unknown) return duda(ctx, 'el código la tipa como `unknown`.');
  if (f & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) return {};
  if (f & ts.TypeFlags.Null) return { type: 'null' };
  if (f & ts.TypeFlags.StringLike && !tipo.isStringLiteral?.() && !tipo.isUnion?.()) return { type: 'string' };
  if (f & ts.TypeFlags.NumberLike && !tipo.isNumberLiteral?.() && !tipo.isUnion?.()) return { type: 'number' };
  if (f & ts.TypeFlags.BigIntLike) return { type: 'integer' };
  if (tipo.isStringLiteral?.()) return { type: 'string', enum: [tipo.value] };
  if (tipo.isNumberLiteral?.()) return { type: 'number', enum: [tipo.value] };
  if (f & ts.TypeFlags.BooleanLike) return { type: 'boolean' };
  if (tipo.isUnion?.()) {
    const sinVacios = tipo.types.filter((t) => !(t.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)));
    const conNull = sinVacios.some((t) => t.flags & ts.TypeFlags.Null);
    const resto = sinVacios.filter((t) => !(t.flags & ts.TypeFlags.Null));
    let salida;
    const literales = resto.every((t) => t.isStringLiteral?.() || t.isNumberLiteral?.()) && resto.length;
    if (resto.every((t) => t.flags & ts.TypeFlags.BooleanLiteral) && resto.length) salida = { type: 'boolean' };
    else if (literales) { const v = resto.map((t) => t.value); salida = { type: tipoDeLiteral(v), enum: v }; }
    else if (resto.length === 1) salida = tipoASchema(ctx, resto[0], prof, pila);
    else {
      const vistos = new Map();
      for (const t of resto) { const e = tipoASchema(ctx, t, prof + 1, pila); vistos.set(JSON.stringify(e), e); }
      salida = vistos.size === 1 ? [...vistos.values()][0] : { anyOf: [...vistos.values()] };
    }
    return conNull ? conNulo(salida) : salida;
  }
  if (tipo.isIntersection?.()) {
    return { allOf: tipo.types.map((t) => tipoASchema(ctx, t, prof + 1, pila)) };
  }
  const nombre = tipo.symbol?.name;
  if (nombre === 'Date') return { type: 'string', format: 'date-time' };
  if (nombre === 'Buffer' || nombre === 'Uint8Array') return { type: 'string', format: 'binary' };
  if (nombre === 'Promise') return tipoASchema(ctx, checker.getTypeArguments(tipo)[0], prof, pila);
  if (checker.isArrayType(tipo)) return { type: 'array', items: tipoASchema(ctx, checker.getTypeArguments(tipo)[0], prof + 1, pila) };
  if (checker.isTupleType(tipo)) return { type: 'array', prefixItems: checker.getTypeArguments(tipo).map((t) => tipoASchema(ctx, t, prof + 1, pila)) };
  if (f & ts.TypeFlags.Object) {
    if (pila.has(tipo)) return duda(ctx, 'tipo recursivo.');
    const siguiente = new Set(pila).add(tipo);
    const props = checker.getPropertiesOfType(tipo).filter((p) => !(p.flags & ts.SymbolFlags.Method));
    const indice = checker.getIndexInfoOfType(tipo, ts.IndexKind.String);
    if (!props.length && !indice) return checker.getSignaturesOfType(tipo, ts.SignatureKind.Call).length ? duda(ctx, 'función.') : { type: 'object' };
    const properties = {};
    const required = [];
    for (const p of props) {
      const decl = p.valueDeclaration ?? p.declarations?.[0];
      const t = decl ? checker.getTypeOfSymbolAtLocation(p, decl) : checker.getTypeOfSymbol(p);
      properties[p.name] = tipoASchema(ctx, t, prof + 1, siguiente);
      if (!(p.flags & ts.SymbolFlags.Optional)) required.push(p.name);
    }
    const salida = { type: 'object' };
    if (props.length) salida.properties = properties;
    if (required.length) salida.required = required;
    if (indice) salida.additionalProperties = tipoASchema(ctx, indice.type, prof + 1, siguiente);
    return salida;
  }
  return duda(ctx, `tipo no reconocido (${checker.typeToString(tipo).slice(0, 60)}).`);
}

/** ¿El esquema resultante dice algo útil? Si no, el cuerpo cuenta como no derivado. */
export function tieneDuda(esquema) {
  return JSON.stringify(esquema).includes(POR_VERIFICAR);
}
