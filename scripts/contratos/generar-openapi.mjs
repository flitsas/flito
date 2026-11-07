// Genera contracts/openapi/flito-api.v1.yaml desde el código real de apps/api (rutas, Zod y tipos), sin ejecutar nada de
// lo que toca datos:
//   1. El inventario de rutas sale del Express real (inventario-rutas.mts).
//   2. El análisis estático (API de TypeScript con su verificador) relaciona cada ruta con sus middlewares y handlers y de
//      ahí lee: autenticación, funciones/roles exigidos, esquema Zod de cuerpo y query, multipart, estados y forma de
//      la respuesta (el tipo de lo que se pasa a res.json).
//   3. Lo que no se puede derivar sale marcado `[por verificar]`. Nada se inventa.
//
// Uso (desde la raíz): npm run contrato:generar
// Salida secundaria en stderr: conteos y rutas que el análisis estático no pudo relacionar.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { POR_VERIFICAR, esTipoZod, nuevoContexto, tieneDuda, tipoASchema, zodASchema } from './esquemas.mjs';
import { aYaml } from './yaml.mjs';
import { aRutaOpenApi, identificadorDe, parametrosDeRuta } from './rutas-openapi.mjs';

const RAIZ = path.resolve(import.meta.dirname, '../..');
const API = path.join(RAIZ, 'apps/api');
const SALIDA = path.join(RAIZ, 'contracts/openapi/flito-api.v1.yaml');
const METODOS = new Set(['get', 'post', 'put', 'patch', 'delete']);
const VERSION_CONTRATO = '1.0.0';

// ── Programa de TypeScript ───────────────────────────────────────────────────────────────────────────────────────────
const config = ts.getParsedCommandLineOfConfigFile(path.join(API, 'tsconfig.json'), {}, {
  ...ts.sys,
  onUnRecoverableConfigFileDiagnostic: (d) => { throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n')); },
});
const programa = ts.createProgram({ rootNames: config.fileNames, options: { ...config.options, noEmit: true } });
const checker = programa.getTypeChecker();
const relativa = (archivo) => path.relative(RAIZ, archivo).replaceAll('\\', '/');
const delProyecto = (archivo) => relativa(archivo).startsWith('apps/api/src/');

function simboloDe(nodo) {
  let s = checker.getSymbolAtLocation(nodo);
  if (s && s.flags & ts.SymbolFlags.Alias) s = checker.getAliasedSymbol(s);
  return s;
}

function declaracionDe(nodo) {
  const s = simboloDe(nodo);
  return s?.valueDeclaration ?? s?.declarations?.[0];
}

const desenvolver = (e) => {
  let n = e;
  while (n && (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isNonNullExpression(n) || ts.isSatisfiesExpression?.(n))) n = n.expression;
  return n;
};

const textoLiteral = (e) => {
  const n = desenvolver(e);
  if (n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n))) return n.text;
  if (n) {
    const t = checker.getTypeAtLocation(n);
    if (t.isStringLiteral?.()) return t.value;
  }
  return null;
};

// ── Routers: de un `app.use('/x', X)` al conjunto de rutas ───────────────────────────────────────────────────────────
function creaRouter(init) {
  const n = desenvolver(init);
  if (!n || !ts.isCallExpression(n)) return false;
  const c = n.expression;
  return (ts.isIdentifier(c) && c.text === 'Router') || (ts.isPropertyAccessExpression(c) && c.name.text === 'Router');
}

/** Devuelve { simbolo, ambito } del router que representa la expresión, o null si no es un router. */
function resolverRouter(expr, vueltas = 0) {
  const n = desenvolver(expr);
  if (!n || vueltas > 6) return null;
  if (creaRouter(n)) return { simbolo: null, ambito: n.getSourceFile(), crea: n };
  if (ts.isIdentifier(n) || ts.isPropertyAccessExpression(n)) {
    const d = declaracionDe(ts.isIdentifier(n) ? n : n.name);
    if (!d) return null;
    if (ts.isExportAssignment(d)) return resolverRouter(d.expression, vueltas + 1);
    if (ts.isVariableDeclaration(d)) {
      if (d.initializer && creaRouter(d.initializer)) {
        return { simbolo: checker.getSymbolAtLocation(d.name), ambito: ambitoDe(d) };
      }
      if (d.initializer) return resolverRouter(d.initializer, vueltas + 1);
    }
    return null;
  }
  if (ts.isCallExpression(n)) {
    // Fábrica: una función del proyecto que crea su Router adentro y lo devuelve.
    const d = ts.isIdentifier(n.expression) || ts.isPropertyAccessExpression(n.expression)
      ? declaracionDe(ts.isIdentifier(n.expression) ? n.expression : n.expression.name) : null;
    const cuerpo = d && (ts.isFunctionDeclaration(d) || ts.isArrowFunction(d) || ts.isFunctionExpression(d)) ? d
      : d && ts.isVariableDeclaration(d) && d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer)) ? d.initializer : null;
    if (cuerpo?.body) {
      let encontrado = null;
      const visitar = (x) => {
        if (encontrado) return;
        if (ts.isVariableDeclaration(x) && x.initializer && creaRouter(x.initializer)) {
          encontrado = { simbolo: checker.getSymbolAtLocation(x.name), ambito: cuerpo.body };
          return;
        }
        ts.forEachChild(x, visitar);
      };
      visitar(cuerpo.body);
      if (encontrado) return encontrado;
    }
    // Envoltura: conAlcance('modulo', router) y similares.
    for (const a of [...n.arguments].reverse()) {
      const r = resolverRouter(a, vueltas + 1);
      if (r) return r;
    }
  }
  return null;
}

function ambitoDe(decl) {
  let n = decl.parent;
  while (n && !ts.isSourceFile(n) && !ts.isFunctionLike(n)) n = n.parent;
  return n && ts.isFunctionLike(n) ? n.body : decl.getSourceFile();
}

const rutasEstaticas = new Map();

function unirRutas(a, b) {
  const unida = `${a}/${b}`.replace(/\/{2,}/g, '/').replace(/\/+$/, '');
  return unida || '/';
}

/** Recorre, en orden de código, las llamadas `router.get|post|use(...)` de ese router. */
function escanearRouter(router, prefijo, heredados, pila = new Set()) {
  const clave = router.simbolo ?? router.crea;
  if (pila.has(clave)) return;
  const siguiente = new Set(pila).add(clave);
  const middlewares = [...heredados];
  const llamadas = [];
  const visitar = (n) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ts.isIdentifier(n.expression.expression)) {
      const nombre = n.expression.name.text;
      if ((METODOS.has(nombre) || nombre === 'use') && checker.getSymbolAtLocation(n.expression.expression) === router.simbolo) llamadas.push(n);
    }
    ts.forEachChild(n, visitar);
  };
  visitar(router.ambito);
  for (const llamada of llamadas) procesarLlamada(llamada, prefijo, middlewares, siguiente);
}

function procesarLlamada(llamada, prefijo, middlewares, pila) {
  const metodo = llamada.expression.name.text;
  const args = [...llamada.arguments];
  const primero = textoLiteral(args[0]);
  const ruta = primero !== null && primero.startsWith('/') ? primero : null;
  const resto = ruta !== null ? args.slice(1) : args;
  if (metodo === 'use') {
    const base = ruta !== null ? unirRutas(prefijo, ruta) : prefijo;
    for (const a of resto) {
      const sub = resolverRouter(a);
      if (sub) escanearRouter(sub, base, middlewares, pila);
      else if (ruta === null) middlewares.push(a);
      // Un `use('/x', fn)` sin router es un middleware de esa subruta: no es una ruta del contrato.
    }
    return;
  }
  if (ruta === null) return;
  const completa = unirRutas(prefijo, ruta);
  const clave = `${metodo} ${completa}`;
  if (!rutasEstaticas.has(clave)) rutasEstaticas.set(clave, { metodo, ruta: completa, llamada, cadena: [...middlewares, ...resto] });
}

function cargarRutasDeApp() {
  const archivo = programa.getSourceFile(path.join(API, 'src/app.ts'));
  let crear;
  ts.forEachChild(archivo, (n) => { if (ts.isFunctionDeclaration(n) && n.name?.text === 'createApp') crear = n; });
  const appSimbolo = (() => {
    let s;
    const v = (n) => { if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === 'app') s = checker.getSymbolAtLocation(n.name); else ts.forEachChild(n, v); };
    v(crear.body);
    return s;
  })();
  const raiz = { simbolo: appSimbolo, ambito: crear.body };
  escanearRouter(raiz, '', []);
}

// ── Análisis de la cadena de una ruta ────────────────────────────────────────────────────────────────────────────────
function funcionDe(expr, vueltas = 0) {
  const n = desenvolver(expr);
  if (!n || vueltas > 5) return null;
  if (ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n)) return n;
  if (ts.isIdentifier(n) || ts.isPropertyAccessExpression(n)) {
    const d = declaracionDe(ts.isIdentifier(n) ? n : n.name);
    if (!d || !delProyecto(d.getSourceFile().fileName)) return null;
    if (ts.isFunctionDeclaration(d) || ts.isFunctionExpression(d) || ts.isArrowFunction(d) || ts.isMethodDeclaration(d)) return d;
    if (ts.isVariableDeclaration(d) && d.initializer) return funcionDe(d.initializer, vueltas + 1);
    if (ts.isPropertyAssignment(d)) return funcionDe(d.initializer, vueltas + 1);
  }
  return null;
}

function nombreLlamada(n) {
  const c = desenvolver(n)?.expression;
  if (!c) return '';
  return ts.isIdentifier(c) ? c.text : ts.isPropertyAccessExpression(c) ? c.name.text : '';
}

function nuevoAnalisis() {
  return {
    auth: false, autenticadores: new Set(), funciones: new Set(), roles: new Set(),
    esquemaCuerpo: null, esquemaQuery: null, camposCuerpo: new Set(), cuerpoIndirecto: false, tipoCuerpo: null,
    queryCampos: new Set(), multipart: new Set(), multipartAny: false, usaArchivo: false, cabeceras: new Set(),
    respuestas: new Map(), binaria: false, redirige: false, opaco: false, visitadas: new Set(),
  };
}

const AUTENTICA = new Set(['authMiddleware', 'metricsAuth']);
const FUNCION_PERMISO = new Set(['exigirFuncion', 'exigirCualquierFuncion', 'exigirAlguna', 'exigirFunciones']);

function analizarMiddleware(arg, a, profundidad) {
  const n = desenvolver(arg);
  if (!n) return;
  if (ts.isSpreadElement(n)) {
    const d = desenvolver(n.expression);
    if (ts.isArrayLiteralExpression(d)) d.elements.forEach((e) => analizarMiddleware(e, a, profundidad));
    else if (ts.isIdentifier(d)) {
      const v = declaracionDe(d);
      if (v && ts.isVariableDeclaration(v) && v.initializer && ts.isArrayLiteralExpression(desenvolver(v.initializer))) desenvolver(v.initializer).elements.forEach((e) => analizarMiddleware(e, a, profundidad));
      else a.opaco = true;
    } else a.opaco = true;
    return;
  }
  if (ts.isArrayLiteralExpression(n)) { n.elements.forEach((e) => analizarMiddleware(e, a, profundidad)); return; }
  if (ts.isIdentifier(n) && AUTENTICA.has(n.text)) { a.auth = true; a.autenticadores.add(n.text); return; }
  if (ts.isCallExpression(n)) {
    const nombre = nombreLlamada(n);
    if (nombre === 'requireRole') { n.arguments.forEach((x) => { const t = textoLiteral(x); if (t) a.roles.add(t); }); return; }
    if (FUNCION_PERMISO.has(nombre) || nombre.startsWith('exigirFuncion')) { n.arguments.forEach((x) => { const t = textoLiteral(x); if (t) a.funciones.add(t); }); }
    if (ts.isPropertyAccessExpression(n.expression) && ['single', 'array', 'fields', 'any', 'none'].includes(nombre)) {
      const t = textoLiteral(n.arguments[0]);
      if (nombre === 'fields' && n.arguments[0] && ts.isArrayLiteralExpression(desenvolver(n.arguments[0]))) {
        for (const el of desenvolver(n.arguments[0]).elements) {
          if (ts.isObjectLiteralExpression(el)) for (const p of el.properties) if (ts.isPropertyAssignment(p) && p.name.getText() === 'name') { const v = textoLiteral(p.initializer); if (v) a.multipart.add(v); }
        }
      } else if (t) a.multipart.add(t);
      else a.multipartAny = true;
      return;
    }
    // Middleware con el esquema de Zod como argumento: validar(Esquema), validarLt(Esquema), asyncHandler(fn)...
    for (const x of n.arguments) {
      const interno = desenvolver(x);
      if (interno && !ts.isStringLiteralLike(interno) && !ts.isObjectLiteralExpression(interno) && esTipoZod(checker, checker.getTypeAtLocation(interno))) a.esquemaMiddleware ??= interno;
      const f = funcionDe(interno);
      if (f) analizarFuncion(f, a, profundidad + 1);
    }
    const f = funcionDe(n.expression);
    if (f) analizarFabrica(f, a, profundidad + 1);
    else if (delProyectoCallee(n)) a.opaco = true;
    return;
  }
  if (ts.isIdentifier(n) || ts.isPropertyAccessExpression(n)) {
    const d = declaracionDe(ts.isIdentifier(n) ? n : n.name);
    // De una librería (rateLimit, multer...): no lee nada que el contrato deba declarar.
    if (d && !delProyecto(d.getSourceFile().fileName)) return;
    const inicial = d && ts.isVariableDeclaration(d) && d.initializer ? desenvolver(d.initializer) : null;
    if (inicial && (ts.isCallExpression(inicial) || ts.isArrayLiteralExpression(inicial)) && profundidad < 5) {
      analizarMiddleware(inicial, a, profundidad + 1);
      return;
    }
  }
  const f = funcionDe(n);
  if (f) analizarFuncion(f, a, profundidad);
  else a.opaco = true;
}

const delProyectoCallee = (llamada) => {
  const c = llamada.expression;
  const d = ts.isIdentifier(c) || ts.isPropertyAccessExpression(c) ? declaracionDe(ts.isIdentifier(c) ? c : c.name) : null;
  return d ? delProyecto(d.getSourceFile().fileName) : false;
};

/** Fábrica de middleware (`const m = (x) => (req, res, next) => {...}`): se analiza lo que devuelve. */
function analizarFabrica(f, a, profundidad) {
  if (!f.body) return;
  if (ts.isArrowFunction(f.body) || ts.isFunctionExpression(f.body)) { analizarFuncion(f.body, a, profundidad); return; }
  const v = (n) => {
    if (ts.isReturnStatement(n) && n.expression) {
      const fn = funcionDe(n.expression);
      if (fn) analizarFuncion(fn, a, profundidad);
    }
    if (!ts.isFunctionLike(n)) ts.forEachChild(n, v);
  };
  ts.forEachChild(f.body, v);
}

const esReqPropiedad = (n, reqs, prop) => {
  const m = desenvolver(n);
  return m && (ts.isPropertyAccessExpression(m)) && ts.isIdentifier(m.expression) && reqs.has(m.expression.text) && m.name.text === prop;
};

function contieneReq(n, reqs, prop) {
  let si = false;
  const v = (x) => { if (si) return; if (esReqPropiedad(x, reqs, prop)) si = true; else ts.forEachChild(x, v); };
  v(n);
  return si;
}

function analizarFuncion(f, a, profundidad) {
  if (!f?.body || a.visitadas.has(f) || profundidad > 4) return;
  a.visitadas.add(f);
  const [pReq, pRes] = f.parameters;
  const reqs = new Set(pReq && ts.isIdentifier(pReq.name) ? [pReq.name.text] : []);
  const ress = new Set(pRes && ts.isIdentifier(pRes.name) ? [pRes.name.text] : []);
  recorrerCuerpo(f.body, reqs, ress, a, profundidad);
}

function recorrerCuerpo(cuerpo, reqs, ress, a, profundidad) {
  const v = (n) => {
    if (ts.isCallExpression(n)) visitarLlamada(n, reqs, ress, a, profundidad);
    if (!a.enMiddleware && ts.isVariableDeclaration(n) && n.initializer && ts.isObjectBindingPattern(n.name)) {
      if (esReqPropiedad(n.initializer, reqs, 'body') || (ts.isBinaryExpression(n.initializer) && contieneReq(n.initializer, reqs, 'body'))) for (const e of n.name.elements) a.camposCuerpo.add((e.propertyName ?? e.name).getText());
      if (esReqPropiedad(n.initializer, reqs, 'query')) for (const e of n.name.elements) a.queryCampos.add((e.propertyName ?? e.name).getText());
    }
    if (!a.enMiddleware && ts.isPropertyAccessExpression(n) && !ts.isIdentifier(n.expression)) {
      if (esReqPropiedad(n.expression, reqs, 'body')) a.camposCuerpo.add(n.name.text);
      if (esReqPropiedad(n.expression, reqs, 'query')) a.queryCampos.add(n.name.text);
    }
    if (!a.enMiddleware && ts.isElementAccessExpression(n) && ts.isStringLiteralLike(n.argumentExpression)) {
      if (esReqPropiedad(n.expression, reqs, 'query')) a.queryCampos.add(n.argumentExpression.text);
      if (esReqPropiedad(n.expression, reqs, 'body')) a.camposCuerpo.add(n.argumentExpression.text);
    }
    if (esReqPropiedad(n, reqs, 'file') || esReqPropiedad(n, reqs, 'files')) a.usaArchivo = true;
    if (!a.enMiddleware && esReqPropiedad(n, reqs, 'body')) a.leeCuerpo = true;
    ts.forEachChild(n, v);
  };
  v(cuerpo);
}

function registrarRespuesta(a, estado, tipo) {
  if (!a.respuestas.has(estado)) a.respuestas.set(estado, []);
  if (tipo) a.respuestas.get(estado).push(tipo);
}

/** Si la expresión es `res` o `res.status(N)...`, devuelve el estado (200 por defecto), o null si no es `res`. */
function estadoDeCadena(expr, ress) {
  let n = desenvolver(expr);
  let estado = 200;
  let es = false;
  while (n) {
    if (ts.isIdentifier(n)) { es = ress.has(n.text); break; }
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      if (n.expression.name.text === 'status') {
        const a0 = desenvolver(n.arguments[0]);
        const t = a0 ? checker.getTypeAtLocation(a0) : null;
        if (a0 && ts.isNumericLiteral(a0)) estado = Number(a0.text);
        else if (t?.isNumberLiteral?.()) estado = t.value;
        else estado = 'default';
      }
      n = desenvolver(n.expression.expression);
      continue;
    }
    if (ts.isPropertyAccessExpression(n)) { n = desenvolver(n.expression); continue; }
    break;
  }
  return es ? estado : null;
}

/** `req.body` o `req.body ?? {}`: el cuerpo entero, no un campo suyo. */
function esEntero(arg, reqs, prop) {
  const n = desenvolver(arg);
  if (esReqPropiedad(n, reqs, prop)) return true;
  return Boolean(n && ts.isBinaryExpression(n) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(n.operatorToken.kind) && esReqPropiedad(n.left, reqs, prop));
}

function visitarLlamada(n, reqs, ress, a, profundidad) {
  const c = n.expression;
  if (ts.isPropertyAccessExpression(c)) {
    const metodo = c.name.text;
    // multer dentro de un envoltorio: `upload.single('archivo')(req, res, cb)`.
    if (['single', 'array', 'fields', 'any'].includes(metodo) && checker.typeToString(checker.getTypeAtLocation(c.expression)).includes('Multer')) {
      const t = textoLiteral(n.arguments[0]);
      if (t) a.multipart.add(t); else a.multipartAny = true;
    }
    // Zod: Esquema.parse(req.body) / safeParse / parseAsync
    if (['parse', 'safeParse', 'parseAsync', 'safeParseAsync'].includes(metodo) && n.arguments[0]) {
      const receptor = desenvolver(c.expression);
      if (esTipoZod(checker, checker.getTypeAtLocation(receptor))) {
        if (esEntero(n.arguments[0], reqs, 'body') && !a.esquemaCuerpo) a.esquemaCuerpo = receptor;
        if (esEntero(n.arguments[0], reqs, 'query') && !a.esquemaQuery) a.esquemaQuery = receptor;
      }
    }
    // Respuestas
    if (['json', 'send', 'end', 'sendStatus', 'download', 'sendFile', 'redirect'].includes(metodo)) {
      const estado = estadoDeCadena(c.expression, ress);
      if (estado !== null) {
        const arg = n.arguments[0];
        if (metodo === 'sendStatus') {
          const t = arg && desenvolver(arg);
          registrarRespuesta(a, t && ts.isNumericLiteral(t) ? Number(t.text) : 'default');
        } else if (metodo === 'redirect') { a.redirige = true; registrarRespuesta(a, 302); }
        else if (metodo === 'download' || metodo === 'sendFile') { a.binaria = true; registrarRespuesta(a, estado); }
        else if (metodo === 'json') registrarRespuesta(a, estado, arg ? checker.getTypeAtLocation(arg) : null);
        else {
          const tipo = arg ? checker.getTypeAtLocation(arg) : null;
          if (tipo?.symbol?.name === 'Buffer' || tipo?.symbol?.name === 'Uint8Array') a.binaria = true;
          registrarRespuesta(a, estado === 200 && !arg && metodo === 'end' ? 200 : estado);
        }
      }
    }
    if (metodo === 'pipe' && n.arguments[0] && ts.isIdentifier(n.arguments[0]) && ress.has(n.arguments[0].text)) { a.binaria = true; registrarRespuesta(a, 200); }
    if (metodo === 'status' && estadoDeCadena(c.expression, ress) !== null && n.parent && ts.isExpressionStatement(n.parent)) {
      const a0 = desenvolver(n.arguments[0]);
      if (a0 && ts.isNumericLiteral(a0)) a.estadoPrevio = Number(a0.text);
    }
  }
  // Delegación: quien recibe req o res se analiza con el nombre de SU parámetro (hasta 4 niveles).
  const idxReq = n.arguments.findIndex((x) => ts.isIdentifier(desenvolver(x)) && reqs.has(desenvolver(x).text));
  const idxRes = n.arguments.findIndex((x) => ts.isIdentifier(desenvolver(x)) && ress.has(desenvolver(x).text));
  const pasaCuerpo = n.arguments.some((x) => contieneReq(x, reqs, 'body'));
  // Zod como argumento de un ayudante: validar(Esquema, req.body) o validar(Esquema, req, res).
  if (idxReq >= 0 || pasaCuerpo) {
    for (const x of n.arguments) {
      const d = desenvolver(x);
      if (d && !ts.isIdentifier(d) === false && esTipoZod(checker, checker.getTypeAtLocation(d)) && !a.esquemaCuerpo) a.esquemaCuerpo = d;
      if (d && ts.isCallExpression(d) && esTipoZod(checker, checker.getTypeAtLocation(d)) && !a.esquemaCuerpo) a.esquemaCuerpo = d;
    }
  }
  if ((idxReq >= 0 || idxRes >= 0) && (ts.isIdentifier(c) || ts.isPropertyAccessExpression(c))) {
    const f = funcionDe(c);
    if (f?.body && !a.visitadas.has(f) && profundidad < 4) {
      a.visitadas.add(f);
      const nombreParam = (i) => (i >= 0 && f.parameters[i] && ts.isIdentifier(f.parameters[i].name) ? f.parameters[i].name.text : null);
      const r = nombreParam(idxReq);
      const s = nombreParam(idxRes);
      recorrerCuerpo(f.body, new Set(r ? [r] : []), new Set(s ? [s] : []), a, profundidad + 1);
    } else if (!f && idxReq >= 0 && delProyectoCallee(n)) a.opaco = true;
  }
  if (pasaCuerpo && !a.esquemaCuerpo && !a.enMiddleware) {
    // El cuerpo entero (o parte) se entrega a otro: se intenta leer el tipo del parámetro receptor.
    a.cuerpoIndirecto = true;
    const f = funcionDe(c);
    const i = n.arguments.findIndex((x) => contieneReq(x, reqs, 'body'));
    if (f && f.parameters[i]) {
      const t = checker.getTypeAtLocation(f.parameters[i]);
      if (!(t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) && !a.tipoCuerpo) a.tipoCuerpo = t;
    }
  }
}

// ── De análisis a operación OpenAPI ──────────────────────────────────────────────────────────────────────────────────
const conteo = { cuerposDerivados: 0, cuerposPorVerificar: 0, respuestasPorVerificar: 0, sinRelacionar: [] };

const ERROR = { type: 'object', properties: { error: { type: 'string' } }, required: ['error'] };
const JSON_ERROR = { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } };

function descripcionDe(entrada) {
  const { llamada } = entrada;
  const fuente = llamada.getSourceFile();
  const previos = ts.getLeadingCommentRanges(fuente.text, llamada.getFullStart()) ?? [];
  const texto = previos.map((r) => fuente.text.slice(r.pos, r.end)).join('\n')
    .replace(/^\s*(\/\/+|\/\*+|\*\/|\*)/gm, '').replace(/\*\/\s*$/gm, '').replace(/\s+/g, ' ').trim();
  const sano = texto.replace(/\b\d{1,3}(\.\d{1,3}){3}\b/g, '<ip>').slice(0, 500);
  return sano || null;
}

function requestBodyDe(metodo, a) {
  const permite = metodo !== 'get';
  const zodNodo = a.esquemaCuerpo ?? (permite ? a.esquemaMiddleware : null);
  const hayMultipart = a.multipart.size > 0 || a.multipartAny || a.usaArchivo;
  const ctx = nuevoContexto(checker);
  let esquema = null;
  let nota = null;
  if (zodNodo) esquema = zodASchema(ctx, checker.getTypeAtLocation(zodNodo), zodNodo);
  else if (!permite) return null;
  else if (a.tipoCuerpo) { esquema = tipoASchema(ctx, a.tipoCuerpo); nota = 'Forma tomada del tipo del parámetro que recibe el cuerpo; sin validación Zod en la ruta.'; }
  else if (a.camposCuerpo.size) {
    esquema = { type: 'object', properties: Object.fromEntries([...a.camposCuerpo].sort().map((c) => [c, { description: `${POR_VERIFICAR} campo leído en el código; su tipo no se valida con un esquema.` }])) };
    nota = `${POR_VERIFICAR} La ruta lee estos campos de req.body sin esquema de Zod; pueden faltar otros.`;
  } else if (a.leeCuerpo || a.cuerpoIndirecto) {
    esquema = {};
    nota = `${POR_VERIFICAR} El handler usa req.body, pero su forma no se puede derivar del código.`;
  }
  if (hayMultipart) {
    const properties = {};
    for (const campo of a.multipart) properties[campo] = { type: 'string', format: 'binary' };
    if (a.multipartAny || (!a.multipart.size && a.usaArchivo)) nota = `${POR_VERIFICAR} Carga de archivos con nombres de campo que no se leen del código.`;
    const base = esquema && esquema.type === 'object' ? esquema : { type: 'object' };
    const unido = { ...base, properties: { ...(base.properties ?? {}), ...properties } };
    return empaquetarCuerpo('multipart/form-data', unido, nota, ctx);
  }
  if (!esquema) {
    if (permite && a.opaco && metodo !== 'delete') {
      return empaquetarCuerpo('application/json', {}, `${POR_VERIFICAR} La cadena de la ruta tiene funciones que el análisis no pudo seguir; no se sabe si lee cuerpo.`, ctx);
    }
    return null;
  }
  return empaquetarCuerpo('application/json', esquema, nota, ctx);
}

function empaquetarCuerpo(tipo, esquema, nota, _ctx) {
  const duda = tieneDuda(esquema) || (nota?.includes(POR_VERIFICAR) ?? false);
  if (duda) conteo.cuerposPorVerificar += 1; else conteo.cuerposDerivados += 1;
  const body = { content: { [tipo]: { schema: esquema } } };
  if (nota) body.description = nota;
  else if (duda) body.description = `${POR_VERIFICAR} Parte del esquema no se pudo derivar del código.`;
  else body.description = tipo === 'multipart/form-data' ? 'Formulario con los archivos que recibe la ruta.' : 'Cuerpo que valida la ruta con su esquema de Zod.';
  return body;
}

function parametrosQuery(a, metodo) {
  const salida = [];
  const nodoQuery = a.esquemaQuery ?? (metodo === 'get' ? a.esquemaMiddleware : null);
  if (nodoQuery) {
    const ctx = nuevoContexto(checker);
    const esquema = zodASchema(ctx, checker.getTypeAtLocation(nodoQuery), nodoQuery);
    if (esquema.properties) {
      for (const [name, schema] of Object.entries(esquema.properties)) {
        const p = { name, in: 'query', required: esquema.required?.includes(name) ?? false, schema };
        p.description = tieneDuda(schema) ? schema.description : `Parámetro ${name}, validado con el esquema de Zod de la ruta.`;
        salida.push(p);
      }
      return salida;
    }
  }
  for (const name of [...a.queryCampos].sort()) {
    salida.push({ name, in: 'query', required: false, description: `${POR_VERIFICAR} Parámetro leído de req.query sin esquema; tipo y obligatoriedad sin confirmar.`, schema: { type: 'string' } });
  }
  return salida;
}

function respuestasDe(a, ruta) {
  const responses = {};
  const dudaResp = { v: false };
  const estados = [...a.respuestas.keys()];
  for (const estado of estados) {
    const tipos = a.respuestas.get(estado);
    const clave = String(estado);
    if (!tipos.length) {
      responses[clave] = { description: descripcionEstado(estado) };
      if (a.binaria && (estado === 200 || estado === 'default')) responses[clave].content = { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } };
      continue;
    }
    const ctx = nuevoContexto(checker);
    const vistos = new Map();
    for (const t of tipos) { const e = tipoASchema(ctx, t); vistos.set(JSON.stringify(e), e); if (ctx.nodos > 300) break; }
    const esquema = vistos.size === 1 ? [...vistos.values()][0] : { anyOf: [...vistos.values()] };
    if (tieneDuda(esquema)) dudaResp.v = true;
    responses[clave] = { description: descripcionEstado(estado), content: { 'application/json': { schema: esquema } } };
  }
  if (!Object.keys(responses).some((k) => k.startsWith('2') || k.startsWith('3'))) {
    responses['200'] = { description: `${POR_VERIFICAR} Respuesta exitosa: la forma no se pudo derivar del código.` };
    dudaResp.v = true;
  }
  if (dudaResp.v) conteo.respuestasPorVerificar += 1;
  if (a.auth) {
    responses['401'] ??= { description: 'Token ausente, inválido o revocado.', content: JSON_ERROR };
    if (a.funciones.size || a.roles.size) responses['403'] ??= { description: 'Sin permisos para esta operación.', content: JSON_ERROR };
  }
  if (ruta.startsWith('/api') || ruta === '/metrics') {
    // express-rate-limit responde 429 con `{ error }` (apiLimiter de app.ts y los limitadores propios) y `Retry-After`.
    responses['429'] = {
      description: 'Límite de peticiones superado.',
      headers: { 'Retry-After': { description: 'Segundos que hay que esperar antes de reintentar.', schema: { type: 'integer' } } },
      content: JSON_ERROR,
    };
  }
  responses['500'] ??= { description: 'Error interno del servidor.', content: JSON_ERROR };
  return responses;
}

function descripcionEstado(estado) {
  const n = Number(estado);
  if (estado === 'default') return 'Estado calculado en tiempo de ejecución.';
  if (n >= 200 && n < 300) return 'Respuesta exitosa.';
  if (n >= 300 && n < 400) return 'Redirección.';
  return { 400: 'Petición inválida.', 401: 'No autenticado.', 403: 'Sin permisos.', 404: 'No encontrado.', 409: 'Conflicto con el estado actual.', 410: 'Ya no disponible.', 412: 'Precondición no cumplida.', 413: 'Cuerpo demasiado grande.', 415: 'Tipo de contenido no admitido.', 422: 'No se puede procesar.', 423: 'Recurso bloqueado.', 429: 'Límite de peticiones superado.', 500: 'Error interno.', 502: 'Falla del servicio externo.', 503: 'Servicio no disponible.', 504: 'El servicio externo no respondió a tiempo.' }[n] ?? `Respuesta con estado ${estado}.`;
}

function etiquetaDe(archivo, ruta) {
  const m = /apps\/api\/src\/modules\/([^/]+)\//.exec(archivo);
  if (m) return m[1];
  return ruta === '/metrics' || ruta.startsWith('/api/health') ? 'salud' : 'plataforma';
}

function operacionDe(inv, entrada) {
  const { metodo, ruta } = inv;
  const parametros = parametrosDeRuta(ruta);
  const operationId = identificadorDe(metodo, ruta);
  if (!entrada) {
    conteo.sinRelacionar.push(`${metodo} ${ruta}`);
    conteo.cuerposPorVerificar += ['post', 'put', 'patch'].includes(metodo) ? 1 : 0;
    conteo.respuestasPorVerificar += 1;
    return {
      operationId, tags: ['plataforma'],
      description: `${POR_VERIFICAR} La ruta existe en Express, pero el análisis estático no pudo relacionarla con su handler.`,
      ...(parametros.length ? { parameters: parametros } : {}),
      responses: { 200: { description: `${POR_VERIFICAR} Respuesta sin derivar.` }, 429: { description: 'Límite de peticiones superado.', headers: { 'Retry-After': { description: 'Segundos de espera.', schema: { type: 'integer' } } }, content: JSON_ERROR } },
    };
  }
  const a = nuevoAnalisis();
  entrada.cadena.forEach((m, i) => {
    a.enMiddleware = i < entrada.cadena.length - 1; // Lo que un middleware lea suelto (audit...) no define el cuerpo de la ruta.
    analizarMiddleware(m, a, 0);
  });
  const archivo = relativa(entrada.llamada.getSourceFile().fileName);
  const query = parametrosQuery(a, metodo);
  const cuerpo = requestBodyDe(metodo, a);
  const notas = [];
  const comentario = descripcionDe(entrada);
  if (comentario) notas.push(comentario);
  notas.push(`Fuente: ${archivo}.`);
  if (a.funciones.size) notas.push(`Exige la función: ${[...a.funciones].sort().join(', ')}.`);
  if (a.roles.size) notas.push(`Exige el rol: ${[...a.roles].sort().join(', ')}.`);
  if (!a.auth) notas.push('Sin authMiddleware en su cadena: pública o con autenticación propia (token, HMAC o magic link); ver la fuente.');
  const op = {
    operationId,
    tags: [etiquetaDe(archivo, ruta)],
    summary: `${metodo.toUpperCase()} ${ruta}`,
    description: notas.join(' '),
    security: a.auth ? [{ bearerAuth: [] }] : [],
  };
  if (a.funciones.size) op['x-flit-funciones'] = [...a.funciones].sort();
  if (a.roles.size) op['x-flit-roles'] = [...a.roles].sort();
  const todos = [...parametros, ...query];
  if (todos.length) op.parameters = todos;
  if (cuerpo) op.requestBody = cuerpo;
  op.responses = respuestasDe(a, ruta);
  return op;
}

// ── Principal ────────────────────────────────────────────────────────────────────────────────────────────────────────
function inventario() {
  const salida = execFileSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', '--tsconfig', 'apps/api/tsconfig.json', 'scripts/contratos/inventario-rutas.mts'], {
    cwd: RAIZ, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
  });
  return JSON.parse(salida.slice(salida.indexOf('[')));
}

const DESCRIPCION = `API HTTP de FLITO (Express en apps/api). Contrato generado desde el código con scripts/contratos/generar-openapi.mjs: las
rutas salen del Express real y los cuerpos, de los esquemas de Zod y de los tipos de TypeScript. Lo que no se pudo derivar del código
lleva [por verificar] en su descripción: no es una garantía de forma, es un pendiente. Interna: la consume la web de FLITO con un Bearer
JWT (/api/auth/login); lo compartible con terceros va en flit2-integracion.v1.yaml. El CI falla si una ruta de Express no está aquí.`;

/** Sube a components.schemas las formas grandes repetidas (filas de tablas, sobre todo): Atlas recibe hasta 5 MiB por spec. */
function compartirFormas(doc) {
  const esForma = (n) => n && n.type === 'object' && n.properties && Object.keys(n.properties).length >= 4;
  const claveDe = (n) => createHash('sha256').update(JSON.stringify(n)).digest('hex').slice(0, 10);
  const veces = new Map();
  const contar = (n) => {
    if (Array.isArray(n)) { n.forEach(contar); return; }
    if (!n || typeof n !== 'object') return;
    if (esForma(n)) { const k = JSON.stringify(n); veces.set(k, (veces.get(k) ?? 0) + 1); }
    Object.values(n).forEach(contar);
  };
  const reemplazar = (n) => {
    if (Array.isArray(n)) return n.map(reemplazar);
    if (!n || typeof n !== 'object') return n;
    if (esForma(n) && veces.get(JSON.stringify(n)) >= 2) {
      const nombre = `Forma-${claveDe(n)}`;
      if (!doc.components.schemas[nombre]) {
        doc.components.schemas[nombre] = {};
        doc.components.schemas[nombre] = { description: 'Forma que comparten varias operaciones.', ...Object.fromEntries(Object.entries(n).map(([k, v]) => [k, reemplazar(v)])) };
      }
      return { $ref: `#/components/schemas/${nombre}` };
    }
    return Object.fromEntries(Object.entries(n).map(([k, v]) => [k, reemplazar(v)]));
  };
  contar(doc.paths);
  doc.paths = reemplazar(doc.paths);
  doc.components.schemas = Object.fromEntries(Object.entries(doc.components.schemas).sort(([a], [b]) => a.localeCompare(b, 'en')));
}

function construir() {
  cargarRutasDeApp();
  const rutas = inventario();
  const paths = {};
  const tags = new Set();
  const claves = new Set(rutas.map((r) => `${r.metodo} ${r.ruta}`));
  const soloEstaticas = [...rutasEstaticas.keys()].filter((k) => !claves.has(k));
  for (const inv of rutas) {
    const op = operacionDe(inv, rutasEstaticas.get(`${inv.metodo} ${inv.ruta}`));
    const ruta = aRutaOpenApi(inv.ruta);
    paths[ruta] ??= {};
    paths[ruta][inv.metodo] = op;
    op.tags.forEach((t) => tags.add(t));
  }
  const doc = {
    openapi: '3.1.0',
    info: {
      title: 'FLITO — API de operaciones',
      version: VERSION_CONTRATO,
      description: DESCRIPCION,
      contact: { name: 'Equipo FLIT', url: 'https://github.com/flitsas/flito' },
      license: { name: 'Propietaria', url: 'https://github.com/flitsas/flito' },
      'x-flit-visibilidad': 'interna',
    },
    servers: [{ url: 'https://{host}', description: 'Host de la API en cada ambiente.', variables: { host: { default: 'api.example.com', description: 'Host público del ambiente.' } } }],
    tags: [...tags].sort().map((name) => ({ name, description: `Módulo ${name} de apps/api.` })),
    paths: Object.fromEntries(Object.entries(paths).sort(([a], [b]) => a.localeCompare(b, 'en'))),
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'JWT emitido por POST /api/auth/login. Referencia de buenas prácticas de JWT: RFC8725.' } },
      schemas: { Error: { ...ERROR, description: 'Cuerpo de error habitual de la API.' } },
    },
  };
  compartirFormas(doc);
  return { doc, rutas, soloEstaticas };
}

const { doc, rutas, soloEstaticas } = construir();
mkdirSync(path.dirname(SALIDA), { recursive: true });
const texto = `# Generado por scripts/contratos/generar-openapi.mjs (npm run contrato:generar). No editar a mano: se regenera desde apps/api.\n${aYaml(doc)}`;
writeFileSync(SALIDA, texto);

const resumen = {
  rutas: rutas.length,
  rutasConCuerpo: conteo.cuerposDerivados + conteo.cuerposPorVerificar,
  cuerposDerivados: conteo.cuerposDerivados,
  cuerposPorVerificar: conteo.cuerposPorVerificar,
  respuestasPorVerificar: conteo.respuestasPorVerificar,
  sinRelacionar: conteo.sinRelacionar,
  soloEnAnalisisEstatico: soloEstaticas,
  bytes: Buffer.byteLength(texto),
};
process.stderr.write(`${JSON.stringify(resumen, null, 1)}\n`);
