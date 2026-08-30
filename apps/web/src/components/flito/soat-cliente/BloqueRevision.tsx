// FLITO — canal Cliente: el bloque de REVISIÓN del detalle de un SOAT (HU #11915, AC1/AC3/AC4).
//
// Diseño: `docs/ux/revision-rechazo-y-subsanacion.md`. Eslabón 3 de 4 del Feature #11912.
//
// ── Qué pinta, y para quién ─────────────────────────────────────────────────────────────────────
//
//   · `pendiente_revision`, lector INTERNO (admin o auditor) — el contexto de la solicitud y, solo
//     si además puede actuar, los dos botones: «Validar» y «Rechazar la solicitud».
//   · `rechazada`, lector INTERNO — en SOLO LECTURA, sin ningún botón: en `rechazada` la pelota es
//     del Cliente y el único camino de vuelta es que él reenvíe (ADR-0008 §8). Ofrecer un
//     «reactivar» crearía un segundo camino de salida que el diagrama de estados no tiene.
//   · `rechazada`, CLIENTE — «Por qué se rechazó» y «Corregir y reenviar», que es la puerta que
//     hacía falta: hasta esta HU el único camino a la subsanación era intentar radicar otra vez el
//     mismo VIN y chocar con el modal de bloqueo de la RN-01.
//
// **Al gestor no le llega nada** y no hace falta ninguna regla: los dos estados del canal están
// fuera de `ESTADOS_SOAT_VISIBLES_GESTOR`, así que la fila no existe para él y `GET /:id` le
// responde 404. La frontera está en el servidor, no en esta pantalla.
//
// ── La guarda se escribe por ESTADO, nunca por `!esCliente` ─────────────────────────────────────
//
// `esOperaciones && !soloLectura && estado === pendiente_revision`. La forma tentadora —`!esCliente`—
// le daría los botones al gestor y al auditor: es preguntar por el LECTOR cuando la pregunta es por
// la FILA. Y nunca un `if (role === 'proveedor') return null`, que es la lista negra que el ADR-0008
// §4 acaba de sacar del router.
//
// ── De dónde salen los datos ────────────────────────────────────────────────────────────────────
//
// De `GET /flito/soat/:id`, que desde esta HU trae el bloque `solicitud` con proyección por rol
// (`revisionDeSolicitud`). **No viene en la fila de la cola** —el detalle de esta pantalla se pinta
// de `filas.find`—, así que este bloque es la única superficie del modal que carga por red y tiene
// sus cuatro estados. `revisadoPorNombre` solo llega a los lectores internos: es el nombre de un
// empleado de FLIT y es exactamente lo que la HU #11913 retiró del historial del Cliente.

import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { CodigoErrorSolicitudSoat, EstadoSoat } from '@operaciones/shared-types';
import { api } from '../../../lib/api';
import { leerFallo } from '../../../lib/soatCliente';
import StatusChip from '../../flit/StatusChip';
import {
  FlitField, flitInp, flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle,
} from '../../flit/flitPageKit';
import PanelRechazo from './PanelRechazo';

/**
 * El satélite de una solicitud del canal, tal como lo sirve `GET /flito/soat/:id`.
 *
 * `revisadoPorNombre` es OPCIONAL y no `| null` a propósito: al `cliente` la clave no le llega
 * vacía, no le llega. La diferencia es real y conviene que se note.
 */
export interface RevisionSolicitud {
  causalNombre: string | null;
  observacion: string | null;
  revisadoEn: string | null;
  reenvios: number;
  solicitadoEn: string;
  revisadoPorNombre?: string | null;
}

interface ProveedorSoat { id: string; nombre: string; activo: boolean }

/**
 * Valor centinela del selector de destino, el MISMO que usa la barra de envío masivo: la
 * contingencia entra como una opción más de la única lista y no como una casilla aparte, así que es
 * imposible pedir proveedor y Operaciones a la vez —que es justo el 400 que el servidor rechaza—.
 */
const DESTINO_OPERACIONES = '__operaciones__';

/** Fecha de calendario, sin hora: «radicada el 28/08/2026» no necesita minutos. */
const fechaCorta = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleDateString('es-CO', { dateStyle: 'short' }) : '—';

export default function BloqueRevision({ soatId, estado, esCliente, puedeRevisar, proveedores, onCambio }: {
  soatId: string;
  estado: EstadoSoat;
  esCliente: boolean;
  /** `esOperaciones && !soloLectura && estado === pendiente_revision`, resuelto por la página. */
  puedeRevisar: boolean;
  proveedores: ProveedorSoat[];
  /** Éxito o «Actualizar la cola»: cierra el detalle y refresca la cola. */
  onCambio: () => void;
}) {
  const [datos, setDatos] = useState<RevisionSolicitud | null | undefined>(undefined);
  const [fallo, setFallo] = useState(false);
  const [recarga, setRecarga] = useState(0);
  const [panel, setPanel] = useState<'idle' | 'validar' | 'rechazar'>('idle');
  // A qué botón devolver el foco al cancelar un panel: el que lo abrió vuelve a existir, pero es un
  // nodo NUEVO, así que hay que enfocarlo después de que se repinte.
  const [volverA, setVolverA] = useState<'validar' | 'rechazar' | null>(null);
  const refValidar = useRef<HTMLButtonElement>(null);
  const refRechazar = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let vivo = true;
    setDatos(undefined);
    setFallo(false);
    api.get<{ solicitud?: RevisionSolicitud | null }>(`/flito/soat/${soatId}`)
      .then((d) => { if (vivo) setDatos(d.solicitud ?? null); })
      .catch(() => { if (vivo) setFallo(true); });
    return () => { vivo = false; };
  }, [soatId, recarga]);

  useEffect(() => {
    if (!volverA) return;
    (volverA === 'validar' ? refValidar : refRechazar).current?.focus();
    setVolverA(null);
  }, [volverA]);

  const enRevision = estado === EstadoSoat.PENDIENTE_REVISION;
  const titulo = esCliente ? 'Por qué se rechazó' : 'Revisión de la solicitud';

  // Estado 3 · vacío. `solicitud: null` significa «esta fila no nació del canal»: no hay nada que
  // revisar y el bloque NO se monta. No se inventa una tarjeta con guiones.
  if (datos === null) return null;

  return (
    <section aria-label={titulo} className="rounded-lg border p-3" style={{ borderColor: 'var(--flit-border-soft)' }}>
      <h3 className="text-sm font-bold" style={{ color: 'var(--flit-blue-text)' }}>{titulo}</h3>

      {/* Estado 1 · cargando. Es el único «cargando» del modal: el resto del detalle se pinta de una
          fila que ya está en memoria. */}
      {datos === undefined && !fallo && (
        <p role="status" className="mt-2 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
          Cargando la solicitud…
        </p>
      )}

      {/* Estado 2 · error de carga, CON salida: sin reintento la única vía sería cerrar y volver a
          abrir el detalle, y quien lo mira puede ser un rol externo. */}
      {fallo && (
        <div className="mt-2 space-y-2">
          <p role="alert" className="text-xs font-semibold" style={{ color: 'var(--flit-danger-ink)' }}>
            No pudimos cargar los datos de la revisión.
          </p>
          <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle}
            onClick={() => setRecarga((n) => n + 1)}>
            Volver a cargar la revisión
          </button>
        </div>
      )}

      {/* Estado 4 · lleno. */}
      {datos && enRevision && (
        <div className="mt-2 space-y-2">
          <p className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
            Solicitud del canal Cliente · radicada el {fechaCorta(datos.solicitadoEn)}
          </p>
          {datos.reenvios > 0 && (
            <p className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
              Es el {datos.reenvios}.º reenvío de esta solicitud. Lo que se le pidió corregir antes
              está en el historial de estados, más arriba.
            </p>
          )}
          <p className="text-sm">Revise la factura de venta y los datos del propietario antes de validarla.</p>

          {puedeRevisar && panel === 'idle' && (
            <div className="flex flex-wrap gap-2 pt-1">
              <button ref={refValidar} type="button" className={flitBtnPrimary} style={flitBtnPrimaryStyle}
                onClick={() => setPanel('validar')}>Validar</button>
              {/* «Rechazar la solicitud» y no «Rechazar» a secas: el detalle ya tiene un «Rechazar»
                  que es el del gestor y lleva a `con novedad`. Nunca coinciden en pantalla —son
                  estados distintos—, pero sí en el archivo y en el localizador de un test. */}
              <button ref={refRechazar} type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle}
                onClick={() => setPanel('rechazar')}>Rechazar la solicitud</button>
            </div>
          )}

          {puedeRevisar && panel === 'validar' && (
            <PanelValidar soatId={soatId} proveedores={proveedores} onCambio={onCambio}
              onCancelar={() => { setPanel('idle'); setVolverA('validar'); }} />
          )}

          {puedeRevisar && panel === 'rechazar' && (
            <PanelRechazo soatId={soatId} onRechazada={() => {
              toast.success('Solicitud rechazada. El cliente ya puede ver la causal y corregirla.');
              onCambio();
            }} onActualizarCola={onCambio}
              onCancelar={() => { setPanel('idle'); setVolverA('rechazar'); }} />
          )}
        </div>
      )}

      {datos && !enRevision && (
        <div className="mt-2 space-y-1">
          {/* El chip lleva TEXTO y no solo color, y dice de quién es la pelota. Al Cliente no se le
              repite: el `<h2>` de su propia pantalla y su cola ya se lo dijeron. */}
          {!esCliente && <StatusChip tone="danger">Rechazada · a la espera de que el cliente corrija</StatusChip>}
          {/* La causal, LITERAL y sin prefijo: nada de «Causal: …». El encabezado ya hizo esa
              pregunta y repetirla en cada línea es ruido. */}
          <p className="pt-1 text-sm font-semibold">{datos.causalNombre ?? '—'}</p>
          {/* Entre comillas angulares: las comillas la marcan como PALABRAS DE ALGUIEN y no como un
              mensaje del sistema, que es la diferencia entre «FLITO no acepta su factura» y
              «alguien miró su factura y le dice qué pasa». */}
          {datos.observacion && <p className="text-sm">«{datos.observacion}»</p>}
          <p className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
            {/* Quién rechazó SOLO para el lector interno: saber a quién preguntar por un rechazo de
                hace tres días es la mitad del valor del registro, y el `cliente` ni siquiera recibe
                el campo. */}
            {esCliente
              ? fechaCorta(datos.revisadoEn)
              : `Rechazada el ${fechaCorta(datos.revisadoEn)} por ${datos.revisadoPorNombre ?? '—'}`}
          </p>
          {esCliente && (
            <p className="pt-2">
              {/* `<Link>` con aspecto de botón: la subsanación es una pantalla con dirección propia y
                  tiene que poder abrirse en otra pestaña. El uuid del SOAT es opaco, así que la URL
                  no lleva PII (AGENTS.md §14). */}
              <Link to={`/flito/soat/solicitud/${soatId}`} className={flitBtnPrimary} style={flitBtnPrimaryStyle}>
                Corregir y reenviar
              </Link>
            </p>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * AC1 — «Validar» NO es un botón de un clic, y la razón es dura.
 *
 * `POST /:id/validar` reúsa `enviarAlGestor()`, que fija destino y estado en el mismo movimiento, y
 * exige uno de los dos destinos. Un `solicitado` sin proveedor y sin contingencia es un SOAT en la
 * cola de NADIE y sin ANS con el que medirlo — es literalmente por lo que la barra de envío masivo
 * deshabilita su botón mientras no hay destino.
 *
 * Y no hay validación en LOTE, dicho aquí para que no se «mejore» después: la casilla de selección
 * de la cola sigue siendo solo de los `pendiente`. Revisar es leer una factura de venta y comparar
 * un nombre; una casilla que valida diez a la vez es una casilla que aprueba sin leer.
 */
function PanelValidar({ soatId, proveedores, onCambio, onCancelar }: {
  soatId: string; proveedores: ProveedorSoat[]; onCambio: () => void; onCancelar: () => void;
}) {
  const [destino, setDestino] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [fallo, setFallo] = useState<{ mensaje: string; recargar: boolean } | null>(null);
  const refTitulo = useRef<HTMLHeadingElement>(null);
  useEffect(() => { refTitulo.current?.focus(); }, []);

  const aOperaciones = destino === DESTINO_OPERACIONES;

  const validar = async () => {
    setEnviando(true);
    setFallo(null);
    try {
      await api.post(`/flito/soat/${soatId}/validar`,
        aOperaciones ? { gestionOperaciones: true } : { proveedorSoatId: destino });
      toast.success(aOperaciones
        ? 'Solicitud validada y enviada a Operaciones.'
        : 'Solicitud validada y enviada al gestor.');
      onCambio();
    } catch (e) {
      const f = leerFallo(e);
      setFallo(f.codigo === CodigoErrorSolicitudSoat.ESTADO_NO_PERMITE
        ? {
          mensaje: 'Esta solicitud ya no está pendiente de revisión: alguien la revisó mientras usted la tenía abierta.',
          recargar: true,
        }
        : { mensaje: 'No se pudo validar la solicitud. Vuelva a intentarlo.', recargar: false });
    } finally {
      setEnviando(false);
    }
  };

  return (
    <div className="mt-3 rounded-lg border p-3" style={{ borderColor: 'var(--flit-border-soft)' }}>
      <h4 ref={refTitulo} tabIndex={-1} className="flit-focus text-sm font-bold" style={{ color: 'var(--flit-blue-text)' }}>
        Validar la solicitud
      </h4>
      <p className="mt-1 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
        Al validarla pasa a Solicitado y entra en la cola del gestor.
      </p>

      <div className="mt-3 space-y-3">
        {/* «Elija el destino…», y no el «Elige destino…» de la barra masiva dos tarjetas más arriba:
            el canal habla de usted (HU #11914) y la cola de Operaciones tutea. Es una divergencia
            consciente de dos palabras; unificar el tuteo del producto entero sigue siendo una
            decisión de PO abierta y no se hace de paso en esta HU. */}
        <FlitField label="Destino">
          <select className={flitInp} value={destino} onChange={(e) => setDestino(e.target.value)}>
            <option value="">Elija el destino…</option>
            <option value={DESTINO_OPERACIONES}>Gestionado por Operaciones</option>
            <optgroup label="Proveedores">
              {proveedores.filter((p) => p.activo).map((p) => <option key={p.id} value={p.id}>{p.nombre}</option>)}
            </optgroup>
          </select>
        </FlitField>

        {fallo && (
          <div className="space-y-2">
            <p role="alert" className="text-xs font-semibold" style={{ color: 'var(--flit-danger-ink)' }}>{fallo.mensaje}</p>
            {fallo.recargar && (
              <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={onCambio}>
                Actualizar la cola
              </button>
            )}
          </div>
        )}

        <span role="status" className="sr-only">{enviando ? 'Validando…' : ''}</span>

        <div className="flex flex-wrap gap-2">
          {/* `disabled` mientras está en vuelo, y no solo por cortesía: sin él un doble clic son dos
              validaciones, y la segunda devuelve un 409 que el admin lee como un error inexplicable
              justo después de un éxito. */}
          <button type="button" className={flitBtnPrimary} style={flitBtnPrimaryStyle}
            disabled={enviando || !destino} onClick={validar}>
            {enviando ? 'Validando…' : aOperaciones ? 'Validar y enviar a Operaciones' : 'Validar y enviar al gestor'}
          </button>
          <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={onCancelar}>
            Cancelar
          </button>
        </div>
      </div>
    </div>
  );
}
