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
