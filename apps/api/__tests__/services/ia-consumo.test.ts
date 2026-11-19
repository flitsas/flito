// Contrato `ia-consumo` v1 (ADR-0047) — contexto, costo, escritor y armado de la fila. Sin BD: el escritor
// escribe en un sumidero en memoria (`configurarSumideroIaParaTests`).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { env } from '../../src/config/env.js';
import { registry } from '../../src/shared/metrics.js';
import {
  conContextoIa, ejecutarConUsuarioIa, leerContextoIa, normalizarPlacaIa,
} from '../../src/shared/ia-consumo/contexto.js';
import { PROCESOS_IA_FLITO, procesoIa, TIPOS_TAREA_IA } from '../../src/shared/ia-consumo/catalogo.js';
import { calcularCostoIa, crearCacheTarifas, modeloSinFecha, type TarifaIa } from '../../src/shared/ia-consumo/costo.js';
import {
  anotarConsumoIa, cerrarConsumoIa, configurarSumideroIaParaTests, encolarConsumoIa, LOTE_MAX, tamanoColaIa, TOPE_COLA,
  vaciarConsumoIa, type FilaConsumoIa, type SumideroIa,
} from '../../src/shared/ia-consumo/escritor.js';
import {
  ambienteIa, clasificarIntentoAnthropic, mensajeSeguro, recortarBytes, registrarConsumoIa, registrarIntentoAnthropic,
  renderizarPrompt,
} from '../../src/shared/ia-consumo/registro.js';
import { uuidv7 } from '../../src/shared/ia-consumo/uuid7.js';

const TARIFAS: TarifaIa[] = [
  { proveedor: 'anthropic', modelo: 'claude-haiku-4-5', vigenteDesde: '2026-11-18', entrada: 1, salida: 5, cacheLectura: 0.1, cacheEscritura: 1.25 },
  { proveedor: 'anthropic', modelo: 'claude-sonnet-4-6', vigenteDesde: '2026-11-18', entrada: 3, salida: 15, cacheLectura: 0.3, cacheEscritura: 3.75 },
  { proveedor: 'anthropic', modelo: 'claude-sonnet-4-6', vigenteDesde: '2027-01-01', entrada: 30, salida: 150, cacheLectura: 3, cacheEscritura: 37.5 },
];

function sumideroMemoria(opciones: { falla?: boolean } = {}) {
  const escritas: FilaConsumoIa[] = [];
  const detalles: Array<{ consumoId: string; promptTexto: string | null; respuestaTexto: string | null }> = [];
  const actualizaciones: Array<{ id: string; cambios: unknown }> = [];
  const s: SumideroIa = {
    async insertar(filas, det) {
      if (opciones.falla) throw Object.assign(new Error('conexión rechazada con datos sensibles'), { code: 'ECONNREFUSED' });
      escritas.push(...filas);
      detalles.push(...(det as typeof detalles));
    },
    async actualizar(id, cambios) { actualizaciones.push({ id, cambios }); },
    async cargarTarifas() { return TARIFAS; },
  };
  return { s, escritas, detalles, actualizaciones };
}

const filaMinima = (extra: Partial<FilaConsumoIa> = {}): FilaConsumoIa => ({
  id: uuidv7(), correlacionId: uuidv7(), fechaInicio: new Date('2026-11-18T12:00:00Z'), fechaFin: new Date('2026-11-18T12:00:01Z'),
  latenciaMs: 1000, aplicativo: 'flito', servicio: 'api', ambiente: 'local', origen: 'job', modulo: 'm', proceso: 'p',
  tipoTarea: 'ocr', proveedor: 'anthropic', resultado: 'exito', ...extra,
});

beforeEach(() => {
  env.IA_CONSUMO_LOG = true;
  env.IA_CONSUMO_DETALLE = false;
});
afterEach(() => {
  env.IA_CONSUMO_LOG = false;
  configurarSumideroIaParaTests(null);
});

describe('uuidv7', () => {
  it('formato v7 + variante RFC, y ordenable por tiempo', () => {
    const a = uuidv7(1_700_000_000_000);
    const b = uuidv7(1_700_000_000_001);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a < b).toBe(true);
  });
});

describe('catálogo', () => {
  it('cada proceso FLITO tiene un tipo de tarea del catálogo y procesoIa lo expande', () => {
    for (const [proceso, { tipoTarea }] of Object.entries(PROCESOS_IA_FLITO)) {
      expect(TIPOS_TAREA_IA).toContain(tipoTarea);
      expect(procesoIa(proceso as keyof typeof PROCESOS_IA_FLITO).proceso).toBe(proceso);
    }
    expect(procesoIa('validar_identidad')).toEqual({ modulo: 'identidad', proceso: 'validar_identidad', tipoTarea: 'validacion_identidad' });
  });
});

describe('contexto (AsyncLocalStorage)', () => {
  it('anida: el interior hereda y pisa solo lo que declara; el correlacionId nace con el proceso y se hereda', async () => {
    await conContextoIa({ usuarioId: '7', usuarioLogin: 'ana' }, async () => {
      expect(leerContextoIa().correlacionId).toBeUndefined();
      await conContextoIa({ ...procesoIa('ocr_factura_soat'), placa: 'abc-12 3' }, async () => {
        const fuera = leerContextoIa();
        expect(fuera).toMatchObject({ usuarioId: '7', modulo: 'soat', proceso: 'ocr_factura_soat', placa: 'ABC123' });
        await new Promise((r) => setTimeout(r, 1));
        await conContextoIa({ pasada: 2 }, async () => {
          const dentro = leerContextoIa();
          expect(dentro.correlacionId).toBe(fuera.correlacionId);
          expect(dentro.pasada).toBe(2);
          expect(dentro.usuarioLogin).toBe('ana');
        });
      });
    });
    expect(leerContextoIa()).toEqual({});
  });

  it('dos operaciones hermanas tienen correlacionId distinto', () => {
    const a = conContextoIa(procesoIa('captcha'), () => leerContextoIa().correlacionId);
    const b = conContextoIa(procesoIa('captcha'), () => leerContextoIa().correlacionId);
    expect(a).toBeTruthy();
    expect(a).not.toBe(b);
  });

  it('placa: mayúsculas, sin espacios ni guiones; vacía o absurda → null', () => {
    expect(normalizarPlacaIa(' jnh-38h ')).toBe('JNH38H');
    expect(normalizarPlacaIa('')).toBeNull();
    expect(normalizarPlacaIa('X'.repeat(30))).toBeNull();
  });

  it('ejecutarConUsuarioIa: usuario y tenant de req.user, y los eventos del req quedan atados al ámbito', async () => {
    const { EventEmitter } = await import('node:events');
    const req = Object.assign(new EventEmitter(), { user: { sub: 42, username: 'gestor', transitoCodigo: '05001' } });
    let visto: unknown;
    ejecutarConUsuarioIa(req, () => undefined);
    // Un listener añadido FUERA del ámbito (como el de multer) ve el ámbito cuando el evento se emite.
    req.on('finish', () => { visto = leerContextoIa(); });
    setImmediate(() => req.emit('finish'));
    await new Promise((r) => setTimeout(r, 5));
    expect(visto).toMatchObject({ usuarioId: '42', usuarioLogin: 'gestor', tenantId: '05001' });
  });
});

describe('costo', () => {
  it('fórmula del contrato con el modelo sin sufijo de fecha', () => {
    const c = calcularCostoIa(TARIFAS, {
      proveedor: 'anthropic', modeloSolicitado: 'claude-haiku-4-5-20251001', fechaInicio: new Date('2026-11-20T00:00:00Z'),
      tokensEntrada: 1000, tokensSalida: 200, tokensCacheLectura: 500, tokensCacheEscritura: 100,
    });
    // (1000·1 + 200·5 + 500·0.1 + 100·1.25) / 1e6
    expect(c).toBe('0.002175');
    expect(modeloSinFecha('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5');
  });

  it('prefiere el modelo respondido y la tarifa vigente más reciente; antes de toda tarifa o sin modelo → null', () => {
    const base = { proveedor: 'anthropic', modeloSolicitado: 'x', modeloRespondido: 'claude-sonnet-4-6', tokensEntrada: 1_000_000 };
    expect(calcularCostoIa(TARIFAS, { ...base, fechaInicio: new Date('2026-12-01T00:00:00Z') })).toBe('3.000000');
    expect(calcularCostoIa(TARIFAS, { ...base, fechaInicio: new Date('2027-02-01T00:00:00Z') })).toBe('30.000000');
    expect(calcularCostoIa(TARIFAS, { ...base, fechaInicio: new Date('2026-01-01T00:00:00Z') })).toBeNull();
    expect(calcularCostoIa(TARIFAS, { proveedor: 'tesseract', fechaInicio: new Date() })).toBeNull();
    expect(calcularCostoIa(TARIFAS, { proveedor: 'anthropic', modeloSolicitado: 'modelo-sin-tarifa', fechaInicio: new Date() })).toBeNull();
  });

  it('caché de tarifas: una carga por TTL; si la carga falla se sigue con lo anterior', async () => {
    let t = 0;
    let cargas = 0;
    let falla = false;
    const cache = crearCacheTarifas(async () => { cargas++; if (falla) throw new Error('bd'); return TARIFAS; }, 1000, () => t);
    expect(await cache.obtener()).toHaveLength(3);
    expect(await cache.obtener()).toHaveLength(3);
    expect(cargas).toBe(1);
    t = 2000; falla = true;
    expect(await cache.obtener()).toHaveLength(3);
    expect(cargas).toBe(2);
  });
});

describe('registro: armado de la fila', () => {
  it('renderiza el prompt sin base64 y calcula hash, mime y bytes', () => {
    const data = Buffer.from('contenido de la imagen').toString('base64');
    const r = renderizarPrompt({
      system: 'SISTEMA',
      messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data } }, { type: 'text', text: 'lee' }] }],
    });
    expect(r.texto).toBe('SISTEMA\n[image image/png]\nlee');
    expect(r.texto).not.toContain(data);
    expect(r.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.mime).toBe('image/png');
    expect(r.bytes).toBe(Buffer.byteLength('contenido de la imagen'));
  });

  it('error_mensaje sin cédulas ni correos y a 500; detalle a 64 KB', () => {
    expect(mensajeSeguro('doc 1020304050 de ana@x.co')).toBe('doc [DOC] de [EMAIL]');
    expect(mensajeSeguro('x'.repeat(900))).toHaveLength(500);
    expect(Buffer.byteLength(recortarBytes('ñ'.repeat(40_000))!)).toBeLessThanOrEqual(64 * 1024);
  });

  it('clasifica según el catálogo resultado', () => {
    const ok = { stop_reason: 'end_turn', content: [] };
    expect(clasificarIntentoAnthropic({ statusCode: 200 }, ok).resultado).toBe('exito');
    expect(clasificarIntentoAnthropic({ statusCode: 200 }, { stop_reason: 'max_tokens' }).resultado).toBe('respuesta_invalida');
    expect(clasificarIntentoAnthropic({ statusCode: 200 }, { stop_reason: 'max_tokens' }, true).resultado).toBe('exito');
    expect(clasificarIntentoAnthropic({ statusCode: 200 }, null)).toEqual({ resultado: 'respuesta_invalida', errorCodigo: 'cuerpo_no_json' });
    expect(clasificarIntentoAnthropic({ statusCode: 429 }, { error: { type: 'rate_limit_error' } })).toEqual({ resultado: 'rate_limit', errorCodigo: 'rate_limit_error' });
    expect(clasificarIntentoAnthropic({ statusCode: 529 }, { error: { type: 'overloaded_error' } }).resultado).toBe('error_proveedor');
    expect(clasificarIntentoAnthropic({ statusCode: 500 }, null).resultado).toBe('error_proveedor');
    expect(clasificarIntentoAnthropic({ statusCode: 401 }, { error: { type: 'authentication_error' } }).resultado).toBe('error_proveedor');
    expect(clasificarIntentoAnthropic({ statusCode: 400 }, { error: { type: 'invalid_request_error' } }).resultado).toBe('rechazado');
    expect(clasificarIntentoAnthropic({ error: { kind: 'timeout' } }, null).resultado).toBe('timeout');
    expect(clasificarIntentoAnthropic({ error: { kind: 'network' } }, null).resultado).toBe('red');
  });

  it('sin contexto: modulo y proceso «desconocido», origen job, correlacion = id', async () => {
    const m = sumideroMemoria();
    configurarSumideroIaParaTests(m.s);
    const id = registrarConsumoIa({ proveedor: 'tesseract', inicio: new Date(), fin: new Date(), resultado: 'exito' });
    await vaciarConsumoIa();
    expect(m.escritas[0]).toMatchObject({
      id, correlacionId: id, modulo: 'desconocido', proceso: 'desconocido', origen: 'job', proveedor: 'tesseract',
      tokensEntrada: 0, costoUsdEstimado: null, aplicativo: 'flito', servicio: 'api', ambiente: ambienteIa(),
    });
  });

  it('ambiente: IA_CONSUMO_AMBIENTE manda; luego DEPLOY_ENVIRONMENT en minúscula; producción sin ellos = pdn; si no, local', () => {
    expect(ambienteIa({ IA_CONSUMO_AMBIENTE: 'qa', DEPLOY_ENVIRONMENT: 'PDN', NODE_ENV: 'production' })).toBe('qa');
    expect(ambienteIa({ IA_CONSUMO_AMBIENTE: 'dev', NODE_ENV: 'production' })).toBe('dev');
    expect(ambienteIa({ DEPLOY_ENVIRONMENT: 'QA' })).toBe('qa');
    expect(ambienteIa({ NODE_ENV: 'production' })).toBe('pdn');
    expect(ambienteIa({ NODE_ENV: 'development' })).toBe('local');
  });

  it('intento Anthropic: tokens, modelo respondido, id, stop_reason y costo; usuario del contexto', async () => {
    const m = sumideroMemoria();
    configurarSumideroIaParaTests(m.s);
    const cuerpo = {
      id: 'msg_1', model: 'claude-haiku-4-5-20251001', stop_reason: 'end_turn', content: [{ type: 'text', text: '{}' }],
      usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    };
    conContextoIa({ usuarioId: '9', usuarioLogin: 'lu', ...procesoIa('ocr_documento'), placa: 'QTP482' }, () => {
      registrarIntentoAnthropic(
        { modelo: 'claude-haiku-4-5-20251001', maxTokens: 2000, prompt: renderizarPrompt({ messages: [] }), op: 'ocr' },
        { intento: 1, inicio: new Date('2026-11-19T00:00:00Z'), fin: new Date('2026-11-19T00:00:02Z'), statusCode: 200, buffer: Buffer.from(JSON.stringify(cuerpo)) },
      );
    });
    await vaciarConsumoIa();
    expect(m.escritas[0]).toMatchObject({
      resultado: 'exito', httpStatus: 200, tokensEntrada: 1000, tokensSalida: 100, modeloRespondido: 'claude-haiku-4-5-20251001',
      idRespuestaProveedor: 'msg_1', stopReason: 'end_turn', latenciaMs: 2000, usuarioId: '9', origen: 'usuario',
      modulo: 'tramites', proceso: 'ocr_documento', tipoTarea: 'ocr', placa: 'QTP482', maxTokens: 2000, costoUsdEstimado: '0.001500',
    });
    expect(m.detalles).toHaveLength(0);
  });

  it('detalle solo con IA_CONSUMO_DETALLE=true', async () => {
    const m = sumideroMemoria();
    configurarSumideroIaParaTests(m.s);
    env.IA_CONSUMO_DETALLE = true;
    registrarIntentoAnthropic(
      { modelo: 'm', maxTokens: 1, prompt: renderizarPrompt({ messages: [{ role: 'user', content: 'hola' }] }), op: 'chat' },
      { intento: 1, inicio: new Date(), fin: new Date(), statusCode: 200, buffer: Buffer.from(JSON.stringify({ content: [{ type: 'text', text: 'respuesta' }], stop_reason: 'end_turn' })) },
    );
    await vaciarConsumoIa();
    expect(m.detalles[0]).toMatchObject({ promptTexto: 'hola', respuestaTexto: 'respuesta' });
  });
});

describe('escritor: nunca bloquea ni rompe', () => {
  it('bandera maestra apagada → no encola nada', () => {
    configurarSumideroIaParaTests(sumideroMemoria().s);
    env.IA_CONSUMO_LOG = false;
    encolarConsumoIa(filaMinima());
    expect(registrarConsumoIa({ proveedor: 'anthropic', inicio: new Date(), fin: new Date(), resultado: 'exito' })).toBeNull();
    expect(tamanoColaIa()).toBe(0);
  });

  it('la BD cae: encolar y vaciar no lanzan, el lote se descarta y se mide', async () => {
    configurarSumideroIaParaTests(sumideroMemoria({ falla: true }).s);
    expect(() => encolarConsumoIa(filaMinima())).not.toThrow();
    await expect(vaciarConsumoIa()).resolves.toBeUndefined();
    expect(tamanoColaIa()).toBe(0);
    expect(await registry.metrics()).toMatch(/ia_consumo_descartados_total\{motivo="bd"\}\s+[1-9]/);
  });

  it('la cola se llena: descarta lo que sobra sin lanzar y lo cuenta', async () => {
    const m = sumideroMemoria();
    // Sumidero que no termina nunca: el vaciado queda en vuelo y la cola solo crece.
    configurarSumideroIaParaTests({ ...m.s, insertar: () => new Promise(() => undefined) });
    // El primer lote (LOTE_MAX) sale de la cola y queda en vuelo; el resto la llena.
    for (let i = 0; i < TOPE_COLA + LOTE_MAX + 25; i++) encolarConsumoIa(filaMinima());
    expect(tamanoColaIa()).toBe(TOPE_COLA);
    expect(tamanoColaIa()).toBeLessThanOrEqual(TOPE_COLA);
    expect(await registry.metrics()).toMatch(/ia_consumo_descartados_total\{motivo="cola_llena"\}\s+[1-9]/);
  });

  it('vacía por lotes de 200 y el apagado vacía lo pendiente', async () => {
    const m = sumideroMemoria();
    let lotes = 0;
    configurarSumideroIaParaTests({ ...m.s, insertar: async (f, d) => { lotes++; await m.s.insertar(f, d); } });
    for (let i = 0; i < 450; i++) encolarConsumoIa(filaMinima());
    await cerrarConsumoIa(2000);
    expect(m.escritas).toHaveLength(450);
    expect(lotes).toBe(3);
  });

  it('anotar: corrige la fila encolada; ya escrita → UPDATE de mejor esfuerzo', async () => {
    const m = sumideroMemoria();
    configurarSumideroIaParaTests(m.s);
    const f = filaMinima();
    encolarConsumoIa(f);
    anotarConsumoIa(f.id, { resultado: 'respuesta_invalida', errorCodigo: 'json_no_parseable', placa: 'ABC123' });
    await vaciarConsumoIa();
    expect(m.escritas[0]).toMatchObject({ resultado: 'respuesta_invalida', placa: 'ABC123' });
    anotarConsumoIa(f.id, { placa: 'XYZ987' });
    await new Promise((r) => setTimeout(r, 1));
    expect(m.actualizaciones).toEqual([{ id: f.id, cambios: { placa: 'XYZ987' } }]);
    expect(() => anotarConsumoIa(null, { placa: 'A' })).not.toThrow();
  });
});

describe('valla: un solo punto habla con api.anthropic.com', () => {
  it('ningún archivo de src fuera del cliente central nombra el host de Anthropic', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src');
    const fuera: string[] = [];
    const recorrer = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = path.join(d, n);
        if (statSync(p).isDirectory()) recorrer(p);
        else if (p.endsWith('.ts') && readFileSync(p, 'utf8').includes('api.anthropic.com')) fuera.push(path.relative(raiz, p).split(path.sep).join('/'));
      }
    };
    recorrer(raiz);
    expect(fuera).toEqual(['modules/tramites/anthropic.ts']);
  });
});
