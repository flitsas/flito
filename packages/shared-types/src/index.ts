import { z } from 'zod';

// Roles, catálogo de páginas y permisos por defecto (fuente única).
// Exporta UserRole, USER_ROLES, ALL_ROLES, userRoleSchema, ROLE_LABELS,
// PAGES, PAGE_GROUPS, PageSlug, ROLE_DEFAULT_PAGES, getEffectivePages, isValidPage, ...
export * from './permissions.js';

// EPIC TRAM-INNOV · A5 — catálogo de tipologías de trámite + checklist dinámico.
export * from './tramite-tipologias.js';

// TRAM-TIPO-01 (Fase 3) — matriz paso × tipología + journeys (partes por tipología).
export * from './tramite-tipologia-matriz.js';

// TRAM-PRODUCTO · TRAM-OPS-02 — motivos de rechazo OT.
export * from './tramite-motivos-rechazo.js';

// TRAM-INNOV-PRE-02 — CTAs canónicos del pre-vuelo (server-driven) + telemetría.
export * from './preflight-actions.js';

// TRAM-MT-01 — catálogo nacional STT + helpers de scope multitenant.
export * from './organismos-transito.js';

// TRAM-INNOV-B3 — firma electrónica (tipos + check pre-vuelo).
export * from './firma.js';

// TRAM-TRASPASO-F1 — modalidad de entrada + workflow STT.
export * from './tramite-workflow.js';

// TRAM-TRASPASO-P1 — impuesto vehicular (reglas plataforma, todos los traspasos).
export * from './impuesto-vehicular.js';

// TRAM-TRASPASO — comparendos desde RUNT persona (gate SIMIT sin proxy obligatorio).
export * from './runt-multas.js';

// TRAM-TRASPASO — vendedor/comprador deben ser personas distintas.
export * from './traspaso-partes.js';

// TRAM-TRASPASO-P0 — gates unificados paso × validación (sidebar + Continuar + BE).
export * from './traspaso-gates.js';

// TRAM-TRASPASO-P0 — permisos dual-actor gestor ↔ STT (paridad CEA).
export * from './traspaso-permisos.js';

export const SoatStatus = z.enum(['pendiente', 'enviado', 'comprado', 'verificado', 'rechazado']);
export type SoatStatus = z.infer<typeof SoatStatus>;

// ── FLITO (migración packages/ → Operaciones) ──────────────────────────────
// Dominio de estados SOAT/Impuestos, modalidad de organismo, soportes y reglas.
export * from './flito-estados.js';
// Dominio del módulo de Logística: estados por documento, actas, tipos y proveedores.
export * from './flito-logistica.js';
export * from './flito-logistica-barcode.js';
// Campos OCR (SOAT / impuesto / factura de venta) con confianza por campo y motivos de revisión.
export * from './flito-ocr.js';
// Mapeo de roles FLITO → roles Operaciones y ataduras de visibilidad del gestor.
export * from './flito-roles.js';
// Bolsas prepago del cliente: tipos de movimiento, conceptos que consumen saldo y periodo contable.
export * from './flito-bolsas.js';
// Bolsa prepago que FLIT mantiene en cada Organismo de Tránsito. Es la inversa de la del cliente:
// FLIT carga el saldo y el organismo lo consume con cada derecho de trámite.
export * from './flito-bolsas-transito.js';
// Certificación de impuestos contra el RUNT: campos comparados, desenlaces y motivos.
export * from './flito-certificacion.js';
// Siigo — catálogos de parametrización contable cacheados en FLITO (Feature #11239).
export * from './siigo-catalogos.js';
// Facturación electrónica: conceptos facturables, clasificación tributaria y mapeo a Siigo.
export * from './siigo-facturacion.js';
// Productos de Siigo y validación en vivo del mapeo antes de guardarlo.
export * from './siigo-productos.js';
// Configuración global de emisión: comprobante, vendedor, forma de pago y centro de costo.
// Compuerta: qué impide emitir contra el ambiente real sin confirmación de contabilidad.
export * from './siigo-compuerta.js';
// Datos fiscales del cliente para existir como tercero en Siigo (Feature #11241).
export * from './siigo-terceros.js';
// Por qué un trámite no se puede enviar todavía a facturación electrónica (HU #11324).
export * from './siigo-elegibilidad.js';
// Por qué un cliente no se puede facturar todavía: motivos nombrados uno por uno.
export * from './siigo-validador-cliente.js';
// Estados de la factura electrónica y estrategias de agrupación (Feature #11242).
export * from './siigo-factura.js';
// Freno por proporción de errores: dejar de insistir antes de que Siigo bloquee el usuario API.
export * from './siigo-freno.js';
// Estado ante la DIAN y de dónde salió el dato. Eje APARTE del estado de emisión (Feature #11243).
export * from './siigo-estado-dian.js';
// Quién puede cada acción de facturación electrónica. Lo leen el servidor Y la pantalla (#11342).
export * from './siigo-permisos.js';
// Corrección de una factura ya emitida: qué admite cada estado y qué se registró (Feature #11244).
export * from './siigo-correccion.js';
// Entrega de la factura por correo y reenvío: el correo lo manda Siigo, FLITO lo registra (#11243).
export * from './siigo-envio.js';
// Archivo del PDF y el XML de la factura como soporte del trámite (Feature #11243).
export * from './siigo-archivo.js';
// Cola de emisión: qué queda por facturar y cuándo le toca. Eje APARTE del estado del documento.
export * from './siigo-cola.js';
// Monitoreo de comparendos: catálogos, token, sync y lectura del consolidado (Feature #11492).
export * from './flito-comparendos.js';
