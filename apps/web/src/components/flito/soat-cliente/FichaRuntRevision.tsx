// FLITO — ficha RUNT en la revisión de Operaciones (HU #11936, AC3/AC4).
//
// Solo lectores internos (`admin`, `auditor`). El Cliente no la ve: `verificacionEstado` es dato
// de la operación. Reusa el patrón de `FichaRunt` (`<dl>` + `StatusChip`), no siete inputs
// deshabilitados. «vigente» no es un valor del enum: es `ok` y `soatVigente === true`.

import StatusChip, { type ChipTone } from '../../flit/StatusChip';
import { flitBtnSecondary, flitBtnSecondaryStyle } from '../../flit/flitPageKit';
import { fechaLarga, type VerificacionRunt } from '../../../lib/soatCliente';

const dato = (v: string | null | undefined) => (v && v.trim() ? v : '—');

type Desenlace = 'pendiente' | 'caido' | 'sin_registro' | 'no_cuadra' | 'ok' | 'vigente';

function desenlaceDe(s: VerificacionRunt): Desenlace {
  if (s.verificacionEstado === 'ok' && s.soatVigente === true) return 'vigente';
  return s.verificacionEstado;
}

const CHIP: Record<Desenlace, { tone: ChipTone; texto: string }> = {
  pendiente: { tone: 'draft', texto: 'Esperando al RUNT' },
  caido: { tone: 'warning', texto: 'RUNT no disponible' },
  sin_registro: { tone: 'warning', texto: 'Sin registro en el RUNT' },
  no_cuadra: { tone: 'danger', texto: 'No cuadra con el RUNT' },
  ok: { tone: 'success', texto: 'Coincide con el RUNT' },
  vigente: { tone: 'warning', texto: 'SOAT vigente' },
};

export default function FichaRuntRevision({
  solicitud, marca, linea, organismoNombre, onActualizar,
}: {
  solicitud: VerificacionRunt;
  marca: string | null;
  linea: string | null;
  organismoNombre: string | null;
  /** Re-GET del detalle. Solo en `pendiente`; no relanza Kyverum. */
  onActualizar: () => void;
}) {
  const desenlace = desenlaceDe(solicitud);
  const chip = CHIP[desenlace];
  if (!chip) return null;
  const organismoFuera = solicitud.verificacionCodigo === 'organismo_no_catalogado';

  return (
    <section
      aria-labelledby="ficha-runt-revision-titulo"
      className="rounded-[12px] p-4"
      style={{ border: '1px solid var(--flit-border-soft)', background: 'var(--flit-bg-app)' }}
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 id="ficha-runt-revision-titulo" className="text-sm font-bold" style={{ color: 'var(--flit-blue-text)' }}>
          Verificación RUNT
        </h3>
        <StatusChip tone={chip.tone}>{chip.texto}</StatusChip>
      </div>

      <Cuerpo desenlace={desenlace} hasta={solicitud.soatVigenteHasta} />

      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
        <Dato k="Marca" v={dato(marca)} />
        <Dato k="Línea" v={dato(linea)} />
        <Dato k="Modelo" v="—" />
        <Dato k="Organismo de tránsito" v={dato(organismoNombre)} ancho />
      </dl>

      {organismoFuera && (desenlace === 'ok' || desenlace === 'vigente') && (
        <p className="mt-2 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
          El RUNT reportó un organismo que aún no está en el catálogo de FLITO. No impide validar ni
          rechazar.
        </p>
      )}

      {desenlace === 'ok' && (
        <p className="mt-3 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
          Estos datos los trajo el RUNT y no se editan.
        </p>
      )}

      {desenlace === 'pendiente' && (
        <div className="mt-3">
          <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={onActualizar}>
            Actualizar verificación
          </button>
        </div>
      )}
    </section>
  );
}

function Cuerpo({ desenlace, hasta }: { desenlace: Desenlace; hasta: string | null }) {
  if (desenlace === 'pendiente') {
    return (
      <p role="status" className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
        La marca, la línea, el modelo y el organismo los trae el RUNT. Mientras responde, los verá
        vacíos: no es un error.
      </p>
    );
  }
  if (desenlace === 'caido') {
    return (
      <p className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
        El RUNT no respondió. Puede validar o rechazar con la factura de venta y los datos que tecleó
        el cliente.
      </p>
    );
  }
  if (desenlace === 'sin_registro') {
    return (
      <p className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
        El RUNT no tiene un vehículo con esa placa y ese VIN. Revise la factura de venta.
      </p>
    );
  }
  if (desenlace === 'no_cuadra') {
    return (
      <p className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
        La placa o el VIN no coinciden con el registro del RUNT. Revise la factura de venta.
      </p>
    );
  }
  if (desenlace === 'vigente') {
    const conFecha = Boolean(hasta);
    return (
      <div role="alert" className="space-y-1 text-xs" style={{ color: 'var(--flit-text-primary)' }}>
        <p>
          {conFecha
            ? `Según el RUNT, la póliza está vigente hasta el ${fechaLarga(hasta!)}.`
            : 'Según el RUNT, este vehículo tiene una póliza SOAT vigente.'}
        </p>
        <p>Lo habitual es rechazar la solicitud. Puede validarla si es una excepción.</p>
      </div>
    );
  }
  return null;
}

function Dato({ k, v, ancho }: { k: string; v: string; ancho?: boolean }) {
  return (
    <div className={`flex flex-col ${ancho ? 'col-span-2' : ''}`}>
      <dt className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--flit-text-muted)' }}>{k}</dt>
      <dd className="text-sm font-medium" style={{ color: 'var(--flit-text-primary)' }}>{v}</dd>
    </div>
  );
}
