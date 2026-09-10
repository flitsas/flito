// HU #12083 — «Auditoría observa, no ejecuta» (AC6), rol por rol.
//
// «Lectura» y «ejecución» se derivan del MÉTODO HTTP de la foto (`inventario.generado.ts`), no del
// sufijo del código: es lo que había (`LECTURA = requireRole('admin','auditor')` protegía solo `GET`
// en los 11 módulos donde el auditor existía) y lo único medible sin interpretar nombres. Medido el
// 10/09/2026: 41 rutas `GET` con `auditor`, 0 no-GET. La HU #12373 retiró la única lectura de tarifas
// (`parametrizacion.tarifas.listar`, DELETE en la 0182): quedan 40.
//
// Tres asertos sobre el auditor, contra el SEED parseado (0179 + 0181, `helpers/permisos-seed-sql.ts`),
// no contra la foto ni el catálogo: lo que decide en producción es lo sembrado.
//   1. tiene EXACTAMENTE los 40 códigos de las rutas GET que la foto le concede (lista explícita,
//      agrupada por módulo);
//   2. ninguno de sus códigos corresponde a una ruta no-GET de la foto ni a una guarda en línea;
//   3. secundario: ninguno termina en verbo de ejecución. Redundante con 2 a propósito: si mañana un
//      GET ejecuta algo, este es el que lo cuenta.
// Y para los otros 11 roles, el mismo esquema en una tabla: `rol → códigos del seed` comparado con la
// foto. Es la vista por rol de la paridad (AC7) sin el motor en medio: si aquella está verde, esto lo
// está; si esto se pone rojo, dice QUÉ rol ganó o perdió.

import { describe, it, expect } from 'vitest';
import { USER_ROLES } from '@operaciones/shared-types';
import { leerRepartoSembrado } from '../helpers/permisos-seed-sql.js';
import { GUARDAS_MEDIDAS } from '../../src/modules/permisos/inventario.generado.js';
import { OPERACIONES_DECLARADAS } from '../../src/modules/permisos/catalogo-operaciones.js';
import { llaveDe } from '../../src/modules/permisos/inventario-guardas.js';

/** Los 40 códigos de lectura del auditor, fijados a mano desde la foto y agrupados por módulo. */
export const LECTURAS_DEL_AUDITOR = {
  soat: ['soat.cola.ver', 'soat.cola.filtrar', 'soat.solicitud.ver', 'soat.solicitud.ver_historial', 'soat.solicitud.ver_soportes'],
  impuestos: ['impuestos.cola.ver', 'impuestos.cola.filtrar', 'impuestos.tramite.ver', 'impuestos.tramite.ver_historial', 'impuestos.tramite.ver_soportes'],
  derechos: ['derechos.cola.ver', 'derechos.cola.filtrar', 'derechos.drive.listar', 'derechos.drive.ver_registro', 'derechos.candidatos.ver', 'derechos.soporte.descargar'],
  revisiones: ['revisiones.cola.ver', 'revisiones.campos.ver', 'revisiones.soporte.descargar'],
  compuerta: ['compuerta.cola.ver', 'compuerta.tramite.ver'],
  tramites: ['tramites.cola.ver', 'tramites.cola.filtrar', 'tramites.tramite.ver_historial', 'tramites.tramite.ver_soportes'],
  tablero: ['tablero.tablero.ver'],
  bitacora: ['bitacora.bitacora.ver', 'bitacora.bitacora.ver_recurso'],
  logistica: ['logistica.consola.ver', 'logistica.consola.filtrar', 'logistica.actas.listar', 'logistica.actas.ver', 'logistica.actas.descargar', 'logistica.documento.ver'],
  liquidacion: ['liquidacion.liquidacion.ver', 'liquidacion.liquidacion.ver_eventos'],
  // HU #12373 retiró `parametrizacion.tarifas.listar`: el auditor ya no ve el cuadro de tarifas.
  parametrizacion: ['parametrizacion.companias.listar', 'parametrizacion.proveedores.listar', 'parametrizacion.organismos.listar', 'parametrizacion.organismos.ver_vigencias'],
} as const;

/**
 * Sufijos que en la foto solo aparecen en rutas NO-GET (medidos el 10/09/2026). `exportar` y
 * `descargar` van en los dos lados (un `GET /:id/certificado` descarga) y por eso no están.
 */
const VERBOS_DE_EJECUCION = /\.(accionar|activar|asignar|asumir|borrar|buscar|cambiar|cambiar_ajena|cambiar_estado|cargar|cerrar|certificar|certificar_lote|conciliar|confirmar|consultar|corregir|crear|desbloquear|descartar|despachar|devolver|editar|entregar|enviar|escanear|evaluar|facturar|fijar_modalidad|forzar_continuar|generar|gestionar|guardar_token|iniciar|iniciar_partes|invalidar|invitar|lanzar|leer|liquidar|liquidar_lote|pedir_ambos|pedir_impuestos|pedir_soat|preconsultar|previsualizar|procesar|procesar_async|reactivar|rechazar|rechazar_ot|recruzar|reemplazar|registrar|reportar_novedad|reprocesar|resolver|reversar|revocar|sembrar|sugerir|tomar|validar|verificar_enlace)$/;

const codigoDeLlave = new Map(OPERACIONES_DECLARADAS.map((o) => [o.llave, o.codigo]));
const codigoDe = (g: (typeof GUARDAS_MEDIDAS)[number]) => codigoDeLlave.get(llaveDe(g))!;
const sembrado = leerRepartoSembrado();
const operacionesDe = (rol: string) => [...(sembrado.get(rol) ?? [])].filter((c) => !c.startsWith('pagina.')).sort();

describe('AC6 — el auditor conserva todas las lecturas y ninguna ejecución', () => {
  const esperadas: string[] = Object.values(LECTURAS_DEL_AUDITOR).flat().slice().sort();

  it('la lista fijada son 40 códigos, todos de rutas GET de la foto con `auditor`', () => {
    expect(esperadas).toHaveLength(40);
    const enFoto = new Set(GUARDAS_MEDIDAS.filter((g) => g.metodo === 'GET' && g.roles.includes('auditor')).map(codigoDe));
    expect([...enFoto].sort()).toEqual(esperadas);
  });

  it('(1) el seed le da EXACTAMENTE esos 40: ni uno más, ni uno menos', () => {
    const suyas = operacionesDe('auditor');
    const deMas = suyas.filter((c) => !esperadas.includes(c));
    const deMenos = esperadas.filter((c) => !suyas.includes(c));
    expect(deMas, 'códigos que el auditor tiene sembrados y no debería').toEqual([]);
    expect(deMenos, 'lecturas que el auditor perdió').toEqual([]);
  });

  it('(2) ninguno de sus códigos es de una ruta no-GET de la foto ni de una guarda en línea', () => {
    const noLectura = new Set(GUARDAS_MEDIDAS.filter((g) => g.metodo !== 'GET' || g.condicion).map(codigoDe));
    expect(operacionesDe('auditor').filter((c) => noLectura.has(c))).toEqual([]);
  });

  it('(3) ninguno de sus códigos termina en verbo de ejecución', () => {
    expect(operacionesDe('auditor').filter((c) => VERBOS_DE_EJECUCION.test(c))).toEqual([]);
  });

  it('los tres GET sin auditor siguen sin él: la factura de venta, el certificado y la ruta del mensajero', () => {
    // No es una omisión de la foto: `impuestos.factura.ver` y `.certificado.descargar` entregan un
    // documento con datos del titular y `logistica.ruta.ver` es la ruta de un mensajero concreto.
    const suyas = new Set(operacionesDe('auditor'));
    for (const c of ['impuestos.factura.ver', 'impuestos.certificado.descargar', 'logistica.ruta.ver']) {
      expect(suyas.has(c), c).toBe(false);
    }
  });
});

describe('AC6 — rol por rol: lo sembrado es lo que la foto concedía', () => {
  for (const rol of USER_ROLES) {
    it(`${rol}: sus operaciones en el seed son exactamente las de las rutas que la foto le daba`, () => {
      const desdeFoto = GUARDAS_MEDIDAS.filter((g) => g.roles.includes(rol)).map(codigoDe).sort();
      expect(operacionesDe(rol)).toEqual(desdeFoto);
    });
  }

  it('los roles con operaciones son los ocho de la foto, y conductor / compliance / lider_pesv / supervisor_flota no tienen ninguna', () => {
    const conOperaciones = USER_ROLES.filter((r) => operacionesDe(r).length > 0).sort();
    expect(conOperaciones).toEqual(['admin', 'auditor', 'cliente', 'financiera', 'gestor_impuestos', 'mensajero', 'proveedor', 'transito']);
  });
});
