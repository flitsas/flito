// FLITO — estrategia de mapeo de compradores por tipo de propiedad. Portado de
// packages/server/src/sincronizacion/mapeo-compradores.ts.
//
// El mapeo difiere entre único y múltiple propietario. Se resuelve con una estrategia
// explícita en vez de un `if` enterrado en la sincronización. Cuando se conozca el mapeo
// real de FLIT se cambia el cuerpo de estas funciones; quien las llama no cambia.

import { TipoPropiedad } from '@operaciones/shared-types';
import type { TramiteFlit } from './flit.port.js';

export interface CompradorMapeado {
  nombreCompleto: string;
  numeroDocumento: string;
  correo: string | null;
  celular: string | null;
  direccion: string | null;
  orden: number;
  porcentajeParticipacion: number | null;
}

type MapeadorCompradores = (tramite: TramiteFlit) => CompradorMapeado[];

/**
 * Único propietario: un comprador con el 100%. Si FLIT enviara más de uno para un trámite
 * marcado como único propietario, son datos contradictorios: se rechaza en vez de tomar el
 * primero, porque elegir en silencio produciría un SOAT a nombre de quien no es.
 */
const mapearUnicoPropietario: MapeadorCompradores = (tramite) => {
  if (tramite.compradores.length === 0) {
    throw new Error(`El trámite ${tramite.idFlit} no trae comprador`);
  }
  if (tramite.compradores.length > 1) {
    throw new Error(
      `El trámite ${tramite.idFlit} está marcado como único propietario pero trae ` +
        `${tramite.compradores.length} compradores`,
    );
  }
  const [comprador] = tramite.compradores;
  return [{
    nombreCompleto: comprador.nombreCompleto,
    numeroDocumento: comprador.numeroDocumento,
    correo: comprador.correo,
    celular: comprador.celular,
    direccion: comprador.direccion,
    orden: 0,
    porcentajeParticipacion: 100,
  }];
};

/**
 * Múltiple propietario: varios compradores ordenados. El de orden 0 es el principal (tomador
 * de la póliza). El orden es el que trae FLIT: no se reordena por porcentaje. Los porcentajes
 * se conservan tal como vienen, incluso si no suman 100 — corregirlo aquí escondería el error.
 */
const mapearMultiplePropietario: MapeadorCompradores = (tramite) => {
  if (tramite.compradores.length < 2) {
    throw new Error(
      `El trámite ${tramite.idFlit} está marcado como múltiple propietario pero trae ` +
        `${tramite.compradores.length} comprador(es)`,
    );
  }
  return tramite.compradores.map((comprador, indice) => ({
    nombreCompleto: comprador.nombreCompleto,
    numeroDocumento: comprador.numeroDocumento,
    correo: comprador.correo,
    celular: comprador.celular,
    direccion: comprador.direccion,
    orden: indice,
    porcentajeParticipacion: comprador.porcentajeParticipacion ?? null,
  }));
};

const ESTRATEGIAS: Record<TipoPropiedad, MapeadorCompradores> = {
  [TipoPropiedad.UNICO_PROPIETARIO]: mapearUnicoPropietario,
  [TipoPropiedad.MULTIPLE_PROPIETARIO]: mapearMultiplePropietario,
};

export function mapearCompradores(tramite: TramiteFlit): CompradorMapeado[] {
  const estrategia = ESTRATEGIAS[tramite.tipoPropiedad as TipoPropiedad];
  if (!estrategia) {
    throw new Error(
      `El trámite ${tramite.idFlit} trae un tipo de propiedad desconocido: "${tramite.tipoPropiedad}"`,
    );
  }
  return estrategia(tramite);
}
