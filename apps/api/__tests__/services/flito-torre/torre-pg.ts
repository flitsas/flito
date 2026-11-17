// Torre de Control (Épica #14590) — banco de pruebas contra PostgreSQL de verdad para el motor y los tableros.
//
// El `db` de la aplicación se sustituye (vi.mock en cada archivo) por `dbProxy`: un Drizzle sobre UNA conexión reservada
// con `BEGIN` abierto que `cerrarTx()` deshace con `ROLLBACK`. Nada de lo que siembra un test queda en la base local
// (la comparten otras sesiones). `db.transaction(fn)` corre `fn` sobre la misma conexión: el `SET LOCAL
// statement_timeout` del motor vale hasta el ROLLBACK. Sin `TEST_DATABASE_URL` los describe se saltan (el CI no
// levanta Postgres). Patrón de `helpers/base-en-tx.ts`.
//
// Los datos de prueba viven en 2035 (ningún dato real cae ahí) y, cuando una consulta no se acota por fecha, se acota
// por las compañías que el test crea.
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '../../../src/db/schema.js';

export const URL_BASE = process.env.TEST_DATABASE_URL;

type Drizzle = ReturnType<typeof drizzle<typeof schema>>;
let actual: Drizzle | null = null;

export const dbProxy = new Proxy({} as Record<string | symbol, unknown>, {
  get(_t, k) {
    if (!actual) throw new Error('torre-pg: no hay transacción abierta (falta abrirTx en beforeEach)');
    if (k === 'transaction') return async (fn: (tx: Drizzle) => Promise<unknown>) => fn(actual!);
    const v = (actual as unknown as Record<string | symbol, unknown>)[k];
    return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(actual) : v;
  },
});

let base: postgres.Sql | null = null;
let reservada: postgres.ReservedSql | null = null;

export async function abrirTx(): Promise<postgres.ReservedSql> {
  base ??= postgres(URL_BASE!, { max: 1, onnotice: () => {} });
  reservada = await base.reserve();
  await reservada`BEGIN`;
  // Una conexión reservada no expone `options`; Drizzle lo lee para registrar sus parsers.
  Object.assign(reservada, { options: base.options });
  actual = drizzle(reservada as unknown as postgres.Sql, { schema });
  return reservada;
}

export async function cerrarTx(): Promise<void> {
  if (reservada) { await reservada`ROLLBACK`; reservada.release(); }
  reservada = null; actual = null;
}

export async function cerrarBase(): Promise<void> { await base?.end(); base = null; }

let n = 0;
const sello = () => `${Date.now().toString(36)}${(n++).toString(36)}`.toUpperCase();
/** Placa de prueba única (6 caracteres, empieza por «ZQ»). */
export const placaNueva = () => `ZQ${sello().slice(-4)}`;

export interface OpTramite {
  cia: number | null; organismo?: string | null; tipo?: string; flitEstado?: string;
  creadoFlit?: string | null; creadoSync?: string; aprobado?: string | null; placa?: string; vin?: string;
}

/** Siembra dentro de la transacción abierta. */
export function sembrador(tx: postgres.ReservedSql) {
  return {
    async organismos(...codigos: string[]) {
      for (const c of codigos) await tx`INSERT INTO organismos_transito_config (codigo, activo) VALUES (${c}, true) ON CONFLICT DO NOTHING`;
    },
    async cia(nombre = 'Cía prueba', flags: { soat?: boolean; impuestos?: boolean; logistica?: boolean } = {}): Promise<number> {
      const [f] = await tx`INSERT INTO clients (name, document, soat_autogestionable, impuestos_autogestionable, logistica_autogestionable)
        VALUES (${`${nombre} ${sello()}`}, ${`T${sello()}`}, ${flags.soat ?? false}, ${flags.impuestos ?? false}, ${flags.logistica ?? false})
        RETURNING id`;
      return f!.id as number;
    },
    async tramite(o: OpTramite): Promise<string> {
      const placa = o.placa ?? placaNueva();
      const [v] = await tx`INSERT INTO vehicles (plate, vin) VALUES (${placa}, ${o.vin ?? `VIN${sello()}`}) RETURNING id`;
      const [t] = await tx`INSERT INTO flito_tramites (id_flit, sincronizado_en, vehiculo_id, compania_id, organismo_codigo,
          flit_estado, tipo_tramite, plate_complete, fecha_creacion_flit, created_at, fecha_aprobacion)
        VALUES (${`TORRE${sello()}`}, now(), ${v!.id}, ${o.cia}, ${o.organismo === undefined ? '05001' : o.organismo},
          ${o.flitEstado ?? (o.aprobado ? 'Aprobado' : 'Asignado')}, ${o.tipo ?? 'Traspaso'}, ${placa},
          ${o.creadoFlit === undefined ? '2035-03-01T15:00:00Z' : o.creadoFlit}, ${o.creadoSync ?? '2035-03-01T15:00:00Z'},
          ${o.aprobado ?? null})
        RETURNING id`;
      return t!.id as string;
    },
    async liquidacion(tramiteId: string, o: { total: number; logistica?: number; digital?: number }) {
      await tx`INSERT INTO flito_liquidaciones (tramite_id, estado, base_gmf, valor_gmf, total, valor_logistica, valor_tramite_digital)
        VALUES (${tramiteId}, 'liquidado', 0, 0, ${o.total}, ${o.logistica ?? 0}, ${o.digital ?? 0})`;
    },
    async viaje(tramiteId: string, numero: number, valor: number) {
      await tx`INSERT INTO flito_tramite_viajes_logistica (tramite_id, numero, modo, valor, motivo)
        VALUES (${tramiteId}, ${numero}, 'manual', ${valor}, 'devolucion')`;
    },
    async impuesto(o: { tramiteId: string; cia: number; organismo: string; valorPagado: number | null; pagadoEn: string | null; estado?: string }) {
      await tx`INSERT INTO flito_impuestos (tramite_id, organismo_codigo, compania_id, modalidad_aplicada, valor_pagado, pagado_en, estado)
        VALUES (${o.tramiteId}, ${o.organismo}, ${o.cia}, 'requiere_gestion', ${o.valorPagado}, ${o.pagadoEn}, ${o.estado ?? (o.pagadoEn ? 'pagado' : 'pendiente')})`;
    },
    async derecho(o: { tramiteId: string; cia: number; organismo: string; valor: number; fechaPago: string }) {
      await tx`INSERT INTO flito_derechos_tramite (tramite_id, organismo_codigo, compania_id, valor, fecha_pago, origen)
        VALUES (${o.tramiteId}, ${o.organismo}, ${o.cia}, ${o.valor}, ${o.fechaPago}, 'manual')`;
    },
    async historial(tramiteId: string, anterior: string | null, nuevo: string, en: string) {
      await tx`INSERT INTO flito_tramite_historial (tramite_id, campo, valor_anterior, valor_nuevo, origen, created_at)
        VALUES (${tramiteId}, 'flit_estado', ${anterior}, ${nuevo}, 'sync', ${en})`;
    },
    async bolsa(cia: number, saldo: number): Promise<string> {
      const [b] = await tx`INSERT INTO flito_bolsas_unicas (alcance, nombre, compania_id, activa, saldo)
        VALUES ('compania', ${`Bolsa ${sello()}`}, ${cia}, true, ${saldo}) RETURNING id`;
      return b!.id as string;
    },
    async salida(bolsaId: string, valor: number, fecha: string) {
      await tx`INSERT INTO flito_bolsas_unicas_movimientos (bolsa_id, tipo, origen, valor, saldo_resultante, periodo, fecha, registrado_por_nombre)
        VALUES (${bolsaId}, 'salida', 'manual', ${valor}, 0, ${fecha.slice(0, 7)}, ${fecha}, 'Prueba')`;
    },
  };
}
