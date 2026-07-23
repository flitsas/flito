// FLITO — semilla de parametrización y usuarios. Portado de packages/server/src/semilla.
//
// No es relleno bonito: cada registro está puesto para poder recorrer un criterio de
// aceptación concreto. Las compañías cubren los interruptores de autogestión; los organismos
// cubren las tres modalidades —incluida SIN clasificar (Barranquilla), que retiene (CA-03)—;
// los usuarios cubren los roles con sus fronteras de visibilidad. NO crea trámites: los
// trámites son de FLIT (se generan desde /api/flito/demo mientras FLIT no exista).
//
// Ejecutar: npx tsx src/scripts/flito-seed.ts   (idempotente: no re-siembra si ya hay datos)

import argon2 from 'argon2';
import { db } from '../db/client.js';
import {
  clients,
  flitoOrganismoVigencias,
  flitoProveedoresSoat,
  flitoReglasProveedorSoat,
  organismosTransitoConfig,
  users,
} from '../db/schema.js';
import { AmbitoReglaProveedor, ModalidadOrganismo, ORGANISMOS_TRANSITO, PRIORIDAD_POR_AMBITO } from '@operaciones/shared-types';

export const CONTRASENA_DEMO = 'flito2026';

// Códigos DIVIPOLA reales (organismos_transito_config.codigo, varchar(5)).
const ORG = { MEDELLIN: '05001', ENVIGADO: '05266', BOGOTA: '11001', CALI: '76001', BARRANQUILLA: '08001' } as const;

async function main(): Promise<void> {
  const [ya] = await db.select({ id: flitoProveedoresSoat.id }).from(flitoProveedoresSoat).limit(1);
  if (ya) {
    console.log('La base ya tiene parametrización FLITO. No se re-siembra.');
    process.exit(0);
  }

  // ── Compañías (sobre clients) ──────────────────────────────────────────────
  const companias = await db.insert(clients).values([
    { name: 'TESLA COLOMBIA S.A.S.', document: '901789698', documentType: 'NIT', flitoCarpetaStorage: 'FLIT/Clientes/Tesla', flitoToleranciaValorImpuesto: '0' },
    { name: 'BANCOLOMBIA S.A.', document: '890903938', documentType: 'NIT', flitoCarpetaStorage: 'FLIT/Clientes/Bancolombia', flitoToleranciaValorImpuesto: '20000' },
    // CA-01 SOAT: autogestiona SOAT → sus trámites no aparecen en cola de SOAT. NIT = gestora real
    // frecuente en el reporte de FLIT (empareja sus trámites por CompaniaGestora).
    { name: 'RENTING S.A.S', document: '811011779', documentType: 'NIT', soatAutogestionable: true, flitoCarpetaStorage: 'FLIT/Clientes/Renting', flitoToleranciaValorImpuesto: '0' },
    // CA-05 Impuestos: autogestiona impuestos → no entra al módulo, sin importar la modalidad.
    { name: 'LOGÍSTICA DEL CARIBE S.A.S.', document: '900789123', documentType: 'NIT', impuestosAutogestionable: true, logisticaAutogestionable: true, flitoCarpetaStorage: 'FLIT/Clientes/LogisticaCaribe', flitoToleranciaValorImpuesto: '0' },
  ]).returning();
  const porNombre = (prefijo: string) => companias.find((c) => c.name.startsWith(prefijo))!;

  // ── Organismos (organismos_transito_config) + modalidad con vigencias ───────
  // Cinco con alias/ajustes explícitos (cubren las 3 modalidades + SIN clasificar).
  await db.insert(organismosTransitoConfig).values([
    { codigo: ORG.MEDELLIN, alias: 'Secretaría de Movilidad de Medellín', flitoSlaHoras: 48 },
    { codigo: ORG.ENVIGADO, alias: 'Tránsito de Envigado', flitoUmbralOcr: '0.700', flitoSlaHoras: 72 },
    { codigo: ORG.BOGOTA, alias: 'Secretaría de Movilidad de Bogotá' },
    { codigo: ORG.CALI, alias: 'Secretaría de Tránsito de Cali' },
    { codigo: ORG.BARRANQUILLA, alias: 'Tránsito de Barranquilla' },
  ]).onConflictDoNothing();
  // El resto del catálogo nacional entra como config para que CUALQUIER ciudad del reporte de FLIT
  // empareje su secretaría. Quedan SIN clasificar (sin vigencia) → sus impuestos se RETIENEN hasta
  // que se les asigne modalidad (CA-03). Sin esto, los trámites de esas ciudades quedaban huérfanos.
  await db.insert(organismosTransitoConfig)
    .values(ORGANISMOS_TRANSITO.map((o) => ({ codigo: o.codigo, alias: `Tránsito de ${o.ciudad}` })))
    .onConflictDoNothing();

  const ahora = new Date();
  // Antioquia (Medellín/Envigado) requiere gestión; Bogotá/Cali autogestionan. Barranquilla
  // queda deliberadamente SIN vigencia: es el organismo recién sincronizado que nadie clasificó
  // y sus trámites deben quedar RETENIDOS (CA-03). Ponerle modalidad "para que no moleste" sería
  // justo lo que RN-01 prohíbe.
  await db.insert(flitoOrganismoVigencias).values([
    { organismoCodigo: ORG.MEDELLIN, modalidad: ModalidadOrganismo.REQUIERE_GESTION, desde: ahora, hasta: null, motivo: 'Clasificación inicial: Antioquia requiere que FLITO gestione los impuestos.', actorNombre: 'sistema' },
    { organismoCodigo: ORG.ENVIGADO, modalidad: ModalidadOrganismo.REQUIERE_GESTION, desde: ahora, hasta: null, motivo: 'Clasificación inicial: Antioquia requiere que FLITO gestione los impuestos.', actorNombre: 'sistema' },
    { organismoCodigo: ORG.BOGOTA, modalidad: ModalidadOrganismo.AUTOGESTIONADO, desde: ahora, hasta: null, motivo: 'Clasificación inicial: el organismo gestiona sus propios impuestos.', actorNombre: 'sistema' },
    { organismoCodigo: ORG.CALI, modalidad: ModalidadOrganismo.AUTOGESTIONADO, desde: ahora, hasta: null, motivo: 'Clasificación inicial: el organismo gestiona sus propios impuestos.', actorNombre: 'sistema' },
  ]);

  // ── Proveedores de SOAT ─────────────────────────────────────────────────────
  const proveedores = await db.insert(flitoProveedoresSoat).values([
    { nombre: 'Seguros del Estado', estrategia: 'portal', slaHoras: 24 },
    { nombre: 'SURA', estrategia: 'portal', umbralOcr: '0.900', slaHoras: 48 },
  ]).returning();
  const estado = proveedores.find((p) => p.nombre === 'Seguros del Estado')!;
  const sura = proveedores.find((p) => p.nombre === 'SURA')!;

  // ── Reglas de enrutamiento ───────────────────────────────────────────────────
  await db.insert(flitoReglasProveedorSoat).values([
    // Default global: lo que no tenga regla más específica.
    { ambito: AmbitoReglaProveedor.GLOBAL, proveedorSoatId: estado.id, prioridad: PRIORIDAD_POR_AMBITO.global },
    // Tesla va por SURA: la regla por compañía gana a la global.
    { ambito: AmbitoReglaProveedor.COMPANIA, companiaId: porNombre('TESLA').id, proveedorSoatId: sura.id, prioridad: PRIORIDAD_POR_AMBITO.compania },
  ]);

  // ── Usuarios (roles del grande: operaciones/proveedor/gestor_impuestos/auditor) ─
  const hash = await argon2.hash(CONTRASENA_DEMO);
  await db.insert(users).values([
    // El operador FLITO ES admin (despliegue FLITO-only; el rol `operaciones` se fusionó en `admin`).
    { username: 'operaciones', name: 'Operaciones FLIT', email: 'operaciones@flito.co', passwordHash: hash, role: 'admin' },
    // Dos gestores del MISMO proveedor: permite demostrar CA-04 (toma atómica de la misma cola).
    { username: 'gestor.sura', name: 'Gestor SURA (1)', email: 'gestor.sura@flito.co', passwordHash: hash, role: 'proveedor', flitoProveedorSoatId: sura.id },
    { username: 'gestor.sura2', name: 'Gestor SURA (2)', email: 'gestor.sura2@flito.co', passwordHash: hash, role: 'proveedor', flitoProveedorSoatId: sura.id },
    // Gestor del otro proveedor: demuestra CA-09 (aislamiento entre proveedores).
    { username: 'gestor.estado', name: 'Gestor Seguros del Estado', email: 'gestor.estado@flito.co', passwordHash: hash, role: 'proveedor', flitoProveedorSoatId: estado.id },
    // Gestores de impuestos atados a su organismo (transito_codigo = DIVIPOLA), CA-10.
    { username: 'gestor.medellin', name: 'Gestor Movilidad Medellín', email: 'gestor.medellin@flito.co', passwordHash: hash, role: 'gestor_impuestos', transitoCodigo: ORG.MEDELLIN },
    { username: 'gestor.envigado', name: 'Gestor Tránsito Envigado', email: 'gestor.envigado@flito.co', passwordHash: hash, role: 'gestor_impuestos', transitoCodigo: ORG.ENVIGADO },
    { username: 'auditoria', name: 'Auditoría FLIT', email: 'auditoria@flito.co', passwordHash: hash, role: 'auditor' },
  ]).onConflictDoNothing();

  const linea = '─'.repeat(72);
  console.log(`\n${linea}\n  FLITO — parametrización sembrada\n${linea}\n
  Usuarios (contraseña para todos: ${CONTRASENA_DEMO})
    operaciones      Operaciones — parametriza, sincroniza, resuelve revisiones
    gestor.sura      Gestor SOAT (proveedor) — solo SURA
    gestor.sura2     Gestor SOAT — mismo proveedor (CA-04, toma atómica)
    gestor.estado    Gestor SOAT — solo Seguros del Estado (CA-09)
    gestor.medellin  Gestor Impuestos — solo Medellín (CA-10)
    gestor.envigado  Gestor Impuestos — solo Envigado
    auditoria        Auditoría — solo lectura

  NO hay trámites (son de FLIT). Entra como operaciones y sincroniza desde el Tablero
  (o POST /api/flito/sync/sincronizar) contra FLIT real. Barranquilla (${ORG.BARRANQUILLA})
  quedó SIN clasificar: sus trámites se RETIENEN (CA-03).\n${linea}\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Semilla FLITO falló:', err);
  process.exit(1);
});
