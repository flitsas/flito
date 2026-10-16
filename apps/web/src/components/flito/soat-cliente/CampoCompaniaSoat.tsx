// FLITO — canal Cliente: a nombre de qué compañía se radica la solicitud de SOAT (HU #12874).
//
// Diseño: docs/arquitectura/hu-12874-soat-sin-tramite-compania.md. Contrato:
// `GET /api/flito/soat/cliente/companias` → `CompaniasCanalSoat` = `{ fija, companias: [{ id, nombre }] }`.
//
//   · **Enlace compañía** (`fija: true`): su compañía, de SOLO LECTURA (AC1). El `companiaId` NO se
//     envía: el servidor usa la del enlace y uno distinto sería un `403 compania_no_permitida`.
//   · **Sin enlace** (`fija: false`): un `<select>` con las compañías que tienen el canal «SOAT sin
//     trámite» (AC2). Es obligatorio (AC3): sin compañía no se consulta el RUNT, no se lee la
//     factura y no se envía.
//
// El campo tiene sus cuatro estados (AC6): cargando, error con reintento, vacío y lleno. Vive fuera
// de `FlitoSoatSolicitud.tsx` porque esa página está en el techo de `max-lines`.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Building2 } from 'lucide-react';
import type { CompaniasCanalSoat } from '@operaciones/shared-types';
import { api } from '../../../lib/api';
import FlitSelect from '../../flit/FlitSelect';
import { Seccion } from './bloques';

export type EstadoCompanias =
  | { fase: 'cargando' }
  | { fase: 'error' }
  | { fase: 'ok'; fija: boolean; companias: CompaniasCanalSoat['companias'] };

/** El ítem de la frase «Para enviar falta: …». Siempre el PRIMERO: la compañía está arriba de todo. */
export const ITEM_COMPANIA = 'escoger la compañía';
const ERROR_COMPANIA = 'Escoja la compañía a nombre de la que se radica la solicitud.';

/**
 * El estado del campo y lo que el formulario necesita saber de él.
 *
 * `enlaceCompania` es el `tipoEnlace` de la sesión. Hace falta mientras la lista no ha llegado (o no
 * pudo llegar): quien tiene enlace compañía radica igual con la suya, así que un fallo del listado
 * NO le bloquea el envío; quien no tiene enlace sí necesita escoger, y sin lista no puede.
 */
export function useCompaniaSoat(enlaceCompania: boolean) {
  const [estado, setEstado] = useState<EstadoCompanias>({ fase: 'cargando' });
  const [valor, setValor] = useState('');
  const [error, setError] = useState<string | null>(null);
  /** Sube cada vez que se pide la compañía: el campo se enfoca aunque el error ya estuviera puesto. */
  const [toque, setToque] = useState(0);
  const turno = useRef(0);

  const cargar = useCallback(async () => {
    turno.current += 1;
    const mio = turno.current;
    setEstado({ fase: 'cargando' });
    try {
      const r = await api.get<CompaniasCanalSoat>('/flito/soat/cliente/companias');
      if (turno.current !== mio) return;
      if (!r || !Array.isArray(r.companias)) { setEstado({ fase: 'error' }); return; }
      setEstado({ fase: 'ok', fija: r.fija === true, companias: r.companias });
      // Una compañía que ya no está en la lista (se le apagó el canal) deja de estar escogida.
      setValor((v) => (v && !r.companias.some((c) => String(c.id) === v) ? '' : v));
    } catch {
      if (turno.current === mio) setEstado({ fase: 'error' });
    }
  }, []);

  useEffect(() => { void cargar(); }, [cargar]);

  const escoge = estado.fase === 'ok' ? !estado.fija : !enlaceCompania;
  const companiaId = escoge && valor ? Number(valor) : undefined;

  return {
    estado, valor, error, toque, escoge, companiaId,
    /** Sin enlace y sin compañía escogida: no se consulta, no se lee y no se envía (AC3). */
    faltante: escoge && !valor,
    recargar: () => { void cargar(); },
    cambiar: (v: string) => { setValor(v); setError(null); },
    /** Marca el campo con su aviso y lo enfoca. `mensaje` = el copy de un rechazo del servidor. */
    pedir: (mensaje: string = ERROR_COMPANIA) => { setError(mensaje); setToque((n) => n + 1); },
  };
}

export type CompaniaSoat = ReturnType<typeof useCompaniaSoat>;

export function CampoCompaniaSoat({ compania, onCambio }: {
  compania: CompaniaSoat;
  onCambio: (valor: string) => void;
}) {
  const { estado, valor, error, toque } = compania;
  const contenedor = useRef<HTMLDivElement>(null);

  // `FlitSelect` se enfoca solo cuando CAMBIA el texto del error; pulsar dos veces «Enviar» con el
  // mismo aviso no lo movería. El contador cubre ese caso.
  useEffect(() => {
    if (toque > 0) contenedor.current?.querySelector<HTMLElement>('select, input')?.focus();
  }, [toque]);

  return (
    <Seccion titulo="Compañía" icono={<Building2 size={18} aria-hidden="true" className="shrink-0" />}>
      <div ref={contenedor} className="max-w-xl">
        {estado.fase === 'ok' && estado.fija
          ? <CompaniaFija nombre={estado.companias[0]?.nombre ?? null} />
          : (
            <FlitSelect
              label="Compañía"
              value={valor}
              opciones={[
                { valor: '', etiqueta: estado.fase === 'cargando' ? 'Cargando compañías…' : 'Seleccione la compañía…' },
                ...(estado.fase === 'ok' ? estado.companias.map((c) => ({ valor: String(c.id), etiqueta: c.nombre })) : []),
              ]}
              onChange={onCambio}
              disabled={estado.fase !== 'ok' || estado.companias.length === 0}
              mensaje={mensajeDe(estado)}
              fallo={estado.fase === 'error'}
              onReintentar={estado.fase === 'error' ? compania.recargar : undefined}
              textoReintento="Reintentar"
              ayuda="La solicitud se radica a nombre de la compañía que escoja."
              error={error}
              required
            />
          )}
      </div>
    </Seccion>
  );
}

function mensajeDe(estado: EstadoCompanias): string | null {
  if (estado.fase === 'cargando') return 'Cargando las compañías…';
  if (estado.fase === 'error') return 'No pudimos cargar las compañías.';
  if (estado.companias.length === 0) return 'Ninguna compañía tiene habilitado el SOAT sin trámite.';
  return null;
}

/**
 * AC1: la compañía del enlace, **como dato y no como control**. Un `<input readOnly>` sería un tope de
 * tabulación sin nada que hacer en él; un par término–definición se lee igual con su rótulo.
 */
function CompaniaFija({ nombre }: { nombre: string | null }) {
  return (
    <dl>
      <dt className="mb-1 text-[11px] font-semibold" style={{ color: 'var(--flit-text-primary)' }}>Compañía</dt>
      <dd className="text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>{nombre ?? '—'}</dd>
      <dd className="mt-1 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
        {nombre
          ? 'La solicitud se radica a nombre de su compañía.'
          : 'Su compañía no tiene habilitado el SOAT sin trámite.'}
      </dd>
    </dl>
  );
}
