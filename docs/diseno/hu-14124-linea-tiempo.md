# HU #14124 — Línea de tiempo de la LT

Diseño **slim** cerrado (architecture OK). Este archivo es el registro del contrato; no lo reabre.

BACKEND only. Sin función nueva, sin migración, sin siembra. `GET /:id` no se retoca.
No se cambia `tipoEventoEfectivo` ni `TIPO_DESDE_ESTADO_NUEVO`.
`tipoEventoEfectivo(null, 'en_flit')` sigue null. `clasificado`, `en_flit`, `generado` y `en_acta` quedan con tipo null.
Los alias ya existentes (`anulado` → `anulacion`) se usan tal cual.

## Rutas

El router ya tiene `authMiddleware`. Dos GET, uuid en el path. Función existente `logistica.documento.ver` (la de `GET /:id`).

- `GET /api/flito/logistica/documentos/:id/linea-tiempo`
- `GET /api/flito/logistica/tramites/:tramiteId/linea-tiempo`

`soloSinEnlace()` va **antes** de `exigirFuncion`.

| Quién | Respuesta |
|---|---|
| Sin token | 401 |
| Enlace `compania` (cliente) | 403 `{ error: 'Sin permisos' }` antes de mirar si el id existe |
| Enlace proveedor u organismos | 403 de la frontera del módulo |
| Interno sin la función | 403 de `exigirFuncion` |
| Id que no es uuid, LT inexistente o trámite inexistente | 404 |
| Trámite que existe y aún no tiene LT | 200 `{ documentoId: null, tramiteId, hitos: [] }` |
| LT sin eventos | 200 con `hitos: []` |

- Por trámite: la LT `tipo = licencia_transito` de ese `tramite_id`.
- Por documento: eventos de ese id, también si sigue pendiente de trámite.
- `Cache-Control: no-store`. Sin `logPiiAccess`.
- No devolver `payload`, lat/lng, claves de storage, ni joins a firmas.
- Orden `created_at DESC`. Dos eventos del mismo `now()` salen los dos; no hay columna de desempate.

El catálogo declara las dos rutas con el **mismo** código, nombre y descripción que `GET /:id`.
Si el texto difiere, `CatalogoIncoherenteError`. Reparto `["admin","auditor"]`, el de `GET /:id`.

## DTO

`packages/shared-types/src/flito-logistica.ts`:

```ts
interface HitoLineaTiempoLogistica {
  id: string;
  tipo: EventoDocumentoLogisticaTipo | null;
  fecha: string; // created_at ISO
  actorNombre: string | null; // users.name; null si el usuario ya no está
  destino: string | null; // columna destino, tal cual; no se deduce del estado
  motivo: string | null;
  estadoNuevo: string;
}
interface LineaTiempoLogistica {
  documentoId: string | null;
  tramiteId: string | null;
  hitos: HitoLineaTiempoLogistica[];
}
```

Tipo del hito: `tipoEventoEfectivo(fila.tipo, fila.estadoNuevo)` en la lectura.

## Motivo

Columna `motivo`. Si viene vacía y `payload.motivoLlegadaId` es uuid del catálogo, el nombre de `flito_logistica_motivos_llegada` aunque esté inactivo. Si el id no resuelve, null. El cast a uuid va protegido (jsonb sucio no debe ser 500). La nota libre no sale. El payload solo se lee en servidor para ese id.
