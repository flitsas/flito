// Siigo — compuerta de emisión real (HU #11285). Un bloque por criterio de aceptación.
//
// La compuerta es orquestación: pregunta al mapeo de conceptos y a la configuración de emisión, y
// decide. Por eso aquí se mockean esas dos fronteras y no la base: lo que hay que probar es la
// DECISIÓN —qué bloquea, qué no, y qué se dice—, no volver a probar sus dos insumos, que ya tienen
// sus propios specs.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONCEPTOS_FACTURABLES } from '@operaciones/shared-types';
import type { ValoresLiquidacion } from '@operaciones/shared-types';

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Modo simulado o real, controlado por test (AC3). */
let modo: 'mock' | 'real' = 'real';
vi.mock('../../src/modules/siigo/siigo.mock.js', async (original) => {
  const real = await original<typeof import('../../src/modules/siigo/siigo.mock.js')>();
  return { ...real, modoSiigo: () => modo, enModoMock: () => modo === 'mock' };
});

/** Filas del mapeo por ambiente: la compuerta no puede heredar entre ambientes (AC7). */
const mapeoPorAmbiente: Record<string, unknown[]> = {};
vi.mock('../../src/modules/siigo/mapeo-conceptos.service.js', async (original) => {
  const real = await original<typeof import('../../src/modules/siigo/mapeo-conceptos.service.js')>();
  return {
    ...real,
    listarMapeo: vi.fn(async (ambiente: string) => mapeoPorAmbiente[ambiente] ?? []),
  };
});

/** Fila del mapeo tal como la devuelve `listarMapeo`. */
function mapeo(concepto: string, over: Record<string, unknown> = {}) {
  return {
    id: `m-${concepto}`,
    ambiente: 'pruebas',
    concepto,
    tipoTramite: null,
    codigoProducto: 'P-1',
    clasificacionTributaria: 'gravado',
    confirmadoContabilidad: true,
    listoParaFacturar: true,
    validacionEstado: 'valido',
    ...over,
  };
}

/** Los seis conceptos, todos confirmados y listos: el punto de partida del caso feliz. */
function mapeoSano(ambiente = 'pruebas') {
  mapeoPorAmbiente[ambiente] = CONCEPTOS_FACTURABLES.map((c) => mapeo(c, { ambiente }));
}

/**
 * Liquidación sellada completa. Los seis campos son obligatorios en `ValoresLiquidacion`: un objeto
 * parcial ya no compila, que es justo la red que faltaba.
 */
function liquidacion(over: Partial<ValoresLiquidacion> = {}): ValoresLiquidacion {
  return {
    valorSoat: null,
    valorImpuesto: null,
    valorDerecho: null,
    valorTramiteDigital: null,
    valorLogistica: null,
    valorGmf: null,
    ...over,
  };
}

beforeEach(() => {
  modo = 'real';
  for (const k of Object.keys(mapeoPorAmbiente)) delete mapeoPorAmbiente[k];
  mapeoSano();
});

// ───────────────────────────────────────────────────────────────────────────────
describe('AC1 — un concepto sin confirmar bloquea la emisión real', () => {
  it('bloquea y enumera exactamente qué conceptos no tienen producto', async () => {
    mapeoPorAmbiente.pruebas = CONCEPTOS_FACTURABLES.map((c) => mapeo(c, {
      listoParaFacturar: c !== 'gmf' && c !== 'logistica',
    }));

    const { estadoCompuerta } = await import('../../src/modules/siigo/siigo.compuerta.service.js');
    const e = await estadoCompuerta('pruebas');

    expect(e.emisionRealHabilitada).toBe(false);
    const motivo = e.motivos.find((m) => m.tipo === 'concepto_no_listo')!;
    // Enumera, no dice «faltan 2».
    expect(motivo.conceptos).toEqual(['logistica', 'gmf']);
    expect(motivo.detalle).toContain('logistica');
    expect(motivo.detalle).toContain('gmf');
  });

  it('A7 — la firma de contabilidad YA NO bloquea', async () => {
    // Lo que esa firma custodiaba era el tratamiento tributario que FLITO guardaba en copia, y esa
    // copia dejó de existir: la factura no envía `taxes` y los aplica Siigo desde el producto. Sin
    // nada tributario de este lado, no queda nada que firmar aquí.
    //
    // Y conviene tenerlo escrito: esto MUEVE la garantía del IVA a la parametrización de Siigo
    // Nube. Si alguien la quiere de vuelta en FLITO, esta prueba es la que hay que cambiar a
    // propósito, no un efecto que se descubra con una factura ya emitida.
    mapeoPorAmbiente.pruebas = CONCEPTOS_FACTURABLES
      .map((c) => mapeo(c, { confirmadoContabilidad: false, listoParaFacturar: true }));

    const { estadoCompuerta } = await import('../../src/modules/siigo/siigo.compuerta.service.js');
    const e = await estadoCompuerta('pruebas');

    expect(e.motivos.some((m) => m.tipo === 'concepto_sin_confirmar')).toBe(false);
    expect(e.emisionRealHabilitada).toBe(true);
  });

  it('un concepto sin ninguna fila viva bloquea, y no como problema de firma', async () => {
    mapeoPorAmbiente.pruebas = CONCEPTOS_FACTURABLES
      .filter((c) => c !== 'derecho_transito').map((c) => mapeo(c));

    const { estadoCompuerta } = await import('../../src/modules/siigo/siigo.compuerta.service.js');
    const e = await estadoCompuerta('pruebas');

    expect(e.motivos.find((m) => m.tipo === 'concepto_no_listo')!.conceptos)
      .toContain('derecho_transito');
    expect(e.motivos.some((m) => m.tipo === 'concepto_sin_confirmar')).toBe(false);
  });

  it('basta que UNA fila del concepto no esté lista: la específica manda sobre la genérica', async () => {
    mapeoPorAmbiente.pruebas = [
      ...CONCEPTOS_FACTURABLES.map((c) => mapeo(c)),
      // Específica sin producto sobre un concepto cuya genérica sí lo tiene.
      mapeo('soat', { id: 'm-soat-esp', tipoTramite: 'TRASPASO', listoParaFacturar: false }),
    ];

    const { estadoCompuerta } = await import('../../src/modules/siigo/siigo.compuerta.service.js');
    const e = await estadoCompuerta('pruebas');

    // Cuál se usa depende del tipo de trámite, que aquí no se conoce: hay que exigir las dos.
    expect(e.motivos.find((m) => m.tipo === 'concepto_no_listo')!.conceptos).toEqual(['soat']);
  });

  it('con todo firmado y listo, la compuerta abre', async () => {
    const { estadoCompuerta } = await import('../../src/modules/siigo/siigo.compuerta.service.js');
    const e = await estadoCompuerta('pruebas');

    expect(e.emisionRealHabilitada).toBe(true);
    expect(e.motivos).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────────────────
describe('AC2 — solo pesan los conceptos que aplican', () => {
  it('un valor nulo NO aplica; cualquier otro sí', async () => {
    const { conceptosAplicables } = await import('../../src/modules/siigo/siigo.compuerta.service.js');

    const aplican = conceptosAplicables(liquidacion({
      valorSoat: '150000.00',
      valorDerecho: '25000.00',
      valorGmf: '600.00',
    }));

    expect(aplican).toEqual(['soat', 'derecho_transito', 'gmf']);
  });

  it('un valor CERO se considera aplicable, a diferencia de uno nulo', async () => {
    const { conceptosAplicables } = await import('../../src/modules/siigo/siigo.compuerta.service.js');

    const aplican = conceptosAplicables(liquidacion({ valorSoat: '0.00', valorGmf: '0' }));

    // La distinción la sostiene `flito_liquidaciones` y aquí no se reinterpreta: cero es «aplica y
    // vale cero», no «no aplica».
    expect(aplican).toContain('soat');
    expect(aplican).toContain('gmf');
    expect(aplican).not.toContain('impuesto_vehicular');
  });

  it('la comprobación es contra null, no por veracidad', async () => {
    // Hoy `numeric` llega como cadena y `'0.00'` es truthy, así que un `if (valor)` funcionaría por
    // accidente. El día que alguien convierta la columna a número, ese mismo `if` excluiría en
    // silencio los conceptos que valen cero — y una línea que falta no se nota hasta cuadrar.
    const fuente = readFileSync(
      resolve(RAIZ, 'src/modules/siigo/siigo.compuerta.service.ts'), 'utf8',
    );
    expect(fuente).toMatch(/valor !== null && valor !== undefined/);
  });

  it('un trámite sin logística no espera a que alguien confirme la logística', async () => {
    mapeoPorAmbiente.pruebas = CONCEPTOS_FACTURABLES.map((c) => mapeo(c, {
      confirmadoContabilidad: c !== 'logistica',
      listoParaFacturar: c !== 'logistica',
    }));

    const { exigirCompuertaAbierta } =
      await import('../../src/modules/siigo/siigo.compuerta.service.js');

    const estado = await exigirCompuertaAbierta('pruebas', liquidacion({
      valorSoat: '150000.00', valorGmf: '600.00',
    }));

    expect(estado.emisionRealHabilitada).toBe(true);
    expect(estado.conceptosEvaluados).not.toContain('logistica');
  });

  it('pero si el trámite SÍ trae logística, la compuerta la exige', async () => {
    mapeoPorAmbiente.pruebas = CONCEPTOS_FACTURABLES.map((c) => mapeo(c, {
      confirmadoContabilidad: c !== 'logistica',
      listoParaFacturar: c !== 'logistica',
    }));

    const { exigirCompuertaAbierta, SiigoCompuertaCerradaError } =
      await import('../../src/modules/siigo/siigo.compuerta.service.js');

    const e = await exigirCompuertaAbierta('pruebas', liquidacion({
      valorSoat: '150000.00', valorLogistica: '0.00', valorGmf: '600.00',
    })).catch((x) => x);

    expect(e).toBeInstanceOf(SiigoCompuertaCerradaError);
    expect(e.motivos[0].conceptos).toEqual(['logistica']);
  });
});

// ───────────────────────────────────────────────────────────────────────────────
describe('AC3 — en modo simulado la compuerta no aplica, pero se dice', () => {
  it('procede aunque haya conceptos sin confirmar', async () => {
    modo = 'mock';
    mapeoPorAmbiente.pruebas = CONCEPTOS_FACTURABLES
      .map((c) => mapeo(c, { confirmadoContabilidad: false, listoParaFacturar: false }));

    const { exigirCompuertaAbierta } =
      await import('../../src/modules/siigo/siigo.compuerta.service.js');

    const estado = await exigirCompuertaAbierta('pruebas', liquidacion({ valorSoat: '1.00' }));

    expect(estado.emisionRealHabilitada).toBe(true);
    expect(estado.compuertaActiva).toBe(false);
    expect(estado.modo).toBe('mock');
  });

  it('el estado dice que se ejecutó en simulado CON LA COMPUERTA INACTIVA', async () => {
    modo = 'mock';
    const { estadoCompuerta } = await import('../../src/modules/siigo/siigo.compuerta.service.js');
    const e = await estadoCompuerta('pruebas');

    // Una respuesta que no distinga «emitido» de «simulado» es la forma de creer que se facturó
    // cuando no salió nada.
    expect(e.compuertaActiva).toBe(false);
    expect(e.modo).toBe('mock');
  });

  it('en simulado los motivos se siguen calculando: sirven para saber qué faltaría en real', async () => {
    modo = 'mock';
    mapeoPorAmbiente.pruebas = CONCEPTOS_FACTURABLES
      .map((c) => mapeo(c, { confirmadoContabilidad: false, listoParaFacturar: false }));

    const { estadoCompuerta } = await import('../../src/modules/siigo/siigo.compuerta.service.js');
    const e = await estadoCompuerta('pruebas');

    // Ocultarlos haría que el simulador pareciera decir que todo está listo cuando no lo está.
    expect(e.motivos.length).toBeGreaterThan(0);
    expect(e.emisionRealHabilitada).toBe(true);
  });

  it('en modo real, la misma parametrización bloquea', async () => {
    modo = 'real';
    mapeoPorAmbiente.pruebas = CONCEPTOS_FACTURABLES
      .map((c) => mapeo(c, { confirmadoContabilidad: false, listoParaFacturar: false }));

    const { exigirCompuertaAbierta, SiigoCompuertaCerradaError } =
      await import('../../src/modules/siigo/siigo.compuerta.service.js');

    const e = await exigirCompuertaAbierta('pruebas', liquidacion({ valorSoat: '1.00' })).catch((x) => x);
    expect(e).toBeInstanceOf(SiigoCompuertaCerradaError);
  });
});

// ───────────────────────────────────────────────────────────────────────────────
describe('la configuración global de emisión ya no existe, y la compuerta no la mira', () => {
  it('sin nada configurado en el ambiente, la compuerta no inventa un motivo de configuración', async () => {
    // Hasta el 2026-08-13 aquí se comprobaba que el ambiente tuviera guardados comprobante,
    // vendedor, forma de pago y centro de costo, y se emitían los motivos `sin_configurar`,
    // `config_incompleta` y `config_invalida`. Esa configuración se retiró: los cuatro se eligen en
    // cada envío, así que cuando esta compuerta corre TODAVÍA NO EXISTEN y no hay nada que mirar.
    //
    // Con el mapeo completo, la compuerta abre. Que falte con qué emitir se comprueba donde sí se
    // sabe qué se eligió: el diálogo de envío y `prepararEmision`.
    const { estadoCompuerta } = await import('../../src/modules/siigo/siigo.compuerta.service.js');
    const e = await estadoCompuerta('pruebas');

    expect(e.motivos.map((m) => m.tipo)).toEqual([]);
  });

  it('lo único que sigue bloqueando es el mapeo de conceptos', async () => {
    mapeoPorAmbiente.pruebas = CONCEPTOS_FACTURABLES
      .map((c) => mapeo(c, { listoParaFacturar: false }));

    const { estadoCompuerta } = await import('../../src/modules/siigo/siigo.compuerta.service.js');
    const e = await estadoCompuerta('pruebas');

    expect(e.motivos.map((m) => m.tipo)).toEqual(['concepto_no_listo']);
  });
});

// ───────────────────────────────────────────────────────────────────────────────
describe('AC5 — el estado de la compuerta es consultable', () => {
  it('el estado global evalúa los SEIS conceptos, no los de un trámite', async () => {
    const { estadoCompuerta } = await import('../../src/modules/siigo/siigo.compuerta.service.js');
    const e = await estadoCompuerta('pruebas');

    // Lo consume la pantalla de parametrización, que pregunta «¿está todo listo?».
    expect(e.conceptosEvaluados).toEqual([...CONCEPTOS_FACTURABLES]);
  });

  it('devuelve si está habilitada y, si no, la lista de motivos', async () => {
    mapeoPorAmbiente.pruebas = CONCEPTOS_FACTURABLES
      .map((c) => mapeo(c, { listoParaFacturar: false }));

    const { estadoCompuerta } = await import('../../src/modules/siigo/siigo.compuerta.service.js');
    const e = await estadoCompuerta('pruebas');

    expect(e).toMatchObject({ ambiente: 'pruebas', emisionRealHabilitada: false });
    expect(e.motivos).toHaveLength(1);
    expect(e.motivos[0]!.detalle).toBeTruthy();
  });
});

// ───────────────────────────────────────────────────────────────────────────────
describe('AC6 — la compuerta vive en el servidor', () => {
  it('`exigirCompuertaAbierta` lanza antes de llamar a Siigo', async () => {
    mapeoPorAmbiente.pruebas = CONCEPTOS_FACTURABLES
      .map((c) => mapeo(c, { confirmadoContabilidad: false, listoParaFacturar: false }));

    const { exigirCompuertaAbierta, SiigoCompuertaCerradaError } =
      await import('../../src/modules/siigo/siigo.compuerta.service.js');

    const e = await exigirCompuertaAbierta('pruebas', liquidacion({ valorSoat: '1.00' })).catch((x) => x);

    expect(e).toBeInstanceOf(SiigoCompuertaCerradaError);
    // El error lleva los motivos: el flujo de emisión no tiene que inspeccionar un booleano y
    // decidir por su cuenta qué decirle a quien opera.
    expect(e.motivos.length).toBeGreaterThan(0);
    expect(e.message).toContain('pruebas');
  });

  it('la evaluación no consulta nada del cliente: solo ambiente y liquidación', async () => {
    const fuente = readFileSync(
      resolve(RAIZ, 'src/modules/siigo/siigo.compuerta.service.ts'), 'utf8',
    );
    // Ni cabeceras, ni query, ni cuerpo de la petición: nada que el navegador pueda falsear.
    expect(fuente).not.toMatch(/req\.|headers|req\.query|req\.body/);
  });
});

// ───────────────────────────────────────────────────────────────────────────────
describe('AC7 — el cambio de ambiente reevalúa y no hereda', () => {
  it('confirmar en pruebas no abre la compuerta de producción', async () => {
    mapeoSano('pruebas');
    // Producción sin nada parametrizado.
    delete mapeoPorAmbiente.produccion;

    const { estadoCompuerta } = await import('../../src/modules/siigo/siigo.compuerta.service.js');

    expect((await estadoCompuerta('pruebas')).emisionRealHabilitada).toBe(true);
    expect((await estadoCompuerta('produccion')).emisionRealHabilitada).toBe(false);
  });

  it('se evalúa en cada consulta: no hay veredicto cacheado', async () => {
    const { estadoCompuerta } = await import('../../src/modules/siigo/siigo.compuerta.service.js');

    expect((await estadoCompuerta('pruebas')).emisionRealHabilitada).toBe(true);

    // El producto de un concepto deja de ser utilizable; nadie recalcula nada a mano.
    mapeoPorAmbiente.pruebas = CONCEPTOS_FACTURABLES
      .map((c) => mapeo(c, { listoParaFacturar: false }));

    // Un veredicto guardado sería un permiso para emitir con parametrización vieja.
    expect((await estadoCompuerta('pruebas')).emisionRealHabilitada).toBe(false);
  });

  it('cada ambiente lee SU mapeo', async () => {
    mapeoSano('produccion');
    mapeoPorAmbiente.pruebas = CONCEPTOS_FACTURABLES
      .map((c) => mapeo(c, { confirmadoContabilidad: false, listoParaFacturar: false }));

    const { estadoCompuerta } = await import('../../src/modules/siigo/siigo.compuerta.service.js');

    expect((await estadoCompuerta('produccion')).emisionRealHabilitada).toBe(true);
    expect((await estadoCompuerta('pruebas')).emisionRealHabilitada).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// Regresión de la auditoría de seguridad de esta HU.
describe('Regresión — la compuerta no abre sin haber comprobado nada', () => {
  it('una liquidación sin ningún concepto BLOQUEA, no habilita', async () => {
    // El fail-open que encontró la auditoría: con cero conceptos, el bucle de evaluación no se
    // ejecuta, no hay motivos de mapeo y —con la configuración completa— la compuerta abría.
    const { exigirCompuertaAbierta, SiigoCompuertaCerradaError } =
      await import('../../src/modules/siigo/siigo.compuerta.service.js');

    const e = await exigirCompuertaAbierta('pruebas', liquidacion()).catch((x) => x);

    expect(e).toBeInstanceOf(SiigoCompuertaCerradaError);
    expect(e.motivos[0].tipo).toBe('sin_conceptos');
    expect(e.motivos[0].detalle).toMatch(/nada que facturar/i);
  });

  it('la invariante se mantiene incluso con TODO lo demás en orden', async () => {
    mapeoSano();
    const { exigirCompuertaAbierta } =
      await import('../../src/modules/siigo/siigo.compuerta.service.js');

    // Cero conceptos evaluados nunca habilita emisión real. Ni con el mapeo perfecto: no hay nada
    // que comprobar, y eso no es un aprobado.
    await expect(exigirCompuertaAbierta('pruebas', liquidacion())).rejects.toThrow();
  });

  it('también bloquea en modo simulado: una liquidación vacía es un problema de DATOS', async () => {
    modo = 'mock';
    const { exigirCompuertaAbierta } =
      await import('../../src/modules/siigo/siigo.compuerta.service.js');

    // En simulado la compuerta no aplica (AC3), pero armar una factura sin líneas no es válido en
    // ningún modo. Por eso esta guarda va antes de mirar el modo.
    await expect(exigirCompuertaAbierta('pruebas', liquidacion())).rejects.toThrow();
  });

  it('el mapa concepto→columna está tipado, sin `as keyof` que anule la comprobación', async () => {
    const fuente = readFileSync(
      resolve(RAIZ, 'src/modules/siigo/siigo.compuerta.service.ts'), 'utf8',
    );
    // Con el cast, renombrar una columna se leía como `undefined` — es decir, «el concepto no
    // aplica»— en silencio, que es el mecanismo que reproduce el fail-open de arriba.
    expect(fuente).not.toMatch(/as keyof ValoresLiquidacion/);
    expect(fuente).toMatch(/liquidacion\[CONCEPTO_FACTURABLE_COLUMNA_LIQUIDACION\[concepto\]\]/);
  });

  it('los seis campos de la liquidación son obligatorios: un objeto parcial no compila', async () => {
    const tipos = readFileSync(
      resolve(RAIZ, '../../packages/shared-types/src/siigo-facturacion.ts'), 'utf8',
    );
    // Sin esto, un `select` parcial o una fila no encontrada resuelta como `{}` desactivaba la
    // compuerta sin una sola queja del compilador.
    expect(tipos).toMatch(/valorSoat: string \| null;/);
    expect(tipos).not.toMatch(/valorSoat\?: string \| null;/);
  });
});

describe('la elegibilidad de un trámite no depende de con qué se vaya a emitir', () => {
  it('la compuerta por conceptos no menciona comprobante, vendedor ni forma de pago', async () => {
    // El comprobante, el vendedor y la forma de pago se ELIGEN al enviar, y desde el 2026-08-13 no
    // hay ninguna configuración global detrás. Bloquear aquí por ellos dejaba el botón del reporte
    // apagado por algo que quien envía decide dos pantallas más adelante — y ahora, además, sería
    // bloquear por un dato que en este momento todavía no existe en ninguna parte.
    const { evaluarCompuerta } = await import('../../src/modules/siigo/siigo.compuerta.service.js');
    const e = await evaluarCompuerta('pruebas', ['tramite_digital']);

    expect(e.motivos).toEqual([]);
  });

  it('la pantalla de parametrización tampoco: pregunta solo por el mapeo', async () => {
    // Antes esta pantalla sí miraba la configuración global. Ya no queda ninguna que mirar.
    const { estadoCompuerta } = await import('../../src/modules/siigo/siigo.compuerta.service.js');
    const e = await estadoCompuerta('pruebas');

    expect(e.motivos).toEqual([]);
    expect(e.emisionRealHabilitada).toBe(true);
  });
});
