// TRAM-08 (cierra TODO #10) — contratos Zod para los campos JSONB del trámite
// (`vehiculo`, `comprador`, `documentos`, `validacion_identidad`).
//
// Antes eran `z.any()` / `z.record(z.unknown())` → cualquier payload pasaba y se
// persistía tal cual, con riesgo de corromper datos aguas abajo (vehículo + SOAT
// se crean a partir de estos campos en confirmar-placa). Estos schemas validan
// los campos CONOCIDOS y typados pero usan `.passthrough()` para tolerar la
// riqueza de la respuesta RUNT (muchos campos adicionales) sin romper el wizard.

import { z } from 'zod';

const str = z.string().max(200);

export const vehiculoSchema = z.object({
  marca: str.optional(),
  linea: str.optional(),
  modelo: str.optional(),            // año-modelo; el wizard lo envía como string
  clase: str.optional(),
  claseVehiculo: str.optional(),
  cilindraje: str.optional(),
  color: str.optional(),
  servicio: str.optional(),
  combustible: str.optional(),
  numeroMotor: str.optional(),
  numeroChasis: str.optional(),
  numeroSerie: str.optional(),
}).passthrough();
export type Vehiculo = z.infer<typeof vehiculoSchema>;

export const compradorSchema = z.object({
  nombre: z.string().min(1).max(200),
  tipoDoc: z.string().min(1).max(10),
  documento: z.string().min(3).max(30),
  email: z.string().email().max(150).optional().or(z.literal('')),
  telefono: str.optional(),
  direccion: str.optional(),
  ciudad: str.optional(),
}).passthrough();
export type Comprador = z.infer<typeof compradorSchema>;

// documentos / validación de identidad: objetos de metadatos (NO arrays), con
// tope de claves para evitar payloads absurdos. La estructura interna varía por
// tipo de documento; se valida que sea un objeto plano acotado.
const boundedRecord = z.record(z.string(), z.unknown()).refine(
  (o) => Object.keys(o).length <= 50,
  { message: 'demasiadas claves (máx 50)' },
);

export const documentosSchema = boundedRecord;
export const validacionIdentidadSchema = boundedRecord;
