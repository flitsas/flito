// FLITO — Comparendos: el formulario de gestión, dentro del panel (HU #11562, AC3, AC4 y AC6).
//
// Es la ÚNICA escritura de todo el módulo: dos campos de veintitantos, y el resto del registro es
// dato de fuente que no se edita (RN-04). Cuatro cosas que definen su comportamiento:
//
//   · **Se manda solo lo que cambió.** `{ causalId }`, `{ observacion }` o las dos. En el contrato
//     del PATCH, `null` significa «vacíalo» y ausente significa «no lo toques», así que serializar
//     un campo que nadie tocó sería pisarle el trabajo a quien esté mirando el mismo comparendo.
//   · **El tope de la observación se comprueba ANTES de la red** (AC6). Con un `maxLength` en el
//     `<textarea>` el navegador recortaría el pegado en silencio y el usuario perdería texto sin
//     enterarse; aquí se deja escribir, el contador se pone en rojo, aparece el mensaje y
//     `[Guardar]` se inhabilita. El número sale de `COMPARENDOS_OBSERVACION_MAX`, que es el MISMO
//     que importa el esquema `zod` del endpoint: el formulario y el servidor no pueden discrepar.
//   · **Lo escrito no se borra nunca por un error.** Una observación es texto que alguien redactó
//     mirando un caso; perderla por un 500 es la clase de cosa que hace que la gente deje de usar
//     el campo.
//   · **El texto del servidor no se pinta**, igual que en el resto del módulo desde la #11559. El
//     copy sale del código de estado y, cuando lo hay, del `codigo` estable del cuerpo —nunca del
//     mensaje—. Este formulario trabaja sobre un comparendo concreto e identificado: es de los
//     peores sitios donde reinstalar el eco. El caso que el AC6 nombra —«la causal que el servidor
//     rechaza»— tiene copy PROPIO gracias a eso: `causal_invalida` es un código estable y dice
//     exactamente qué pasó sin repetir nada de lo que el servidor escribió.

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  COMPARENDOS_OBSERVACION_MAX,
  type ComparendoRegistroDetalle,
  type ComparendosCausal,
  type ComparendosGestionPatch,
} from '@operaciones/shared-types';
import toast from 'react-hot-toast';
import { ApiError } from '../../../lib/api';
import {
  FlitField, flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle, flitInp,
} from '../../flit/flitPageKit';
import { codigoDeError, guardarGestion } from './useComparendoDetalle';
import { fechaHoraColombia } from './formato';

/** Valor del `<option>` que retira la causal. Cadena vacía = `causalId: null` en el cuerpo. */
const SIN_CAUSAL = '';

/**
 * Qué se le dice al usuario cuando el guardado falla.
 *
 * Los tres primeros casos son distintos entre sí de verdad —uno se arregla eligiendo otra causal,
 * otro no se arregla y otro exige copiar el texto antes de cerrar— y por eso no comparten mensaje.
 */
function errorDeGuardado(e: unknown): string {
  if (e instanceof ApiError) {
    // 422 `causal_invalida`: la causal se desactivó (o se borró) entre que se cargó el catálogo y
    // se pulsó Guardar. Es el caso del AC6 y tiene arreglo en pantalla, así que se nombra.
    if (codigoDeError(e) === 'causal_invalida') {
      return 'La causal que elegiste ya no existe o está desactivada en el catálogo. Recarga la '
        + 'página y elige una activa.';
    }
    if (e.status === 404) {
      return 'Este comparendo ya no está en el sistema. Copia tu observación antes de cerrar.';
    }
    if (e.status === 403) return 'Tu usuario ya no puede gestionar comparendos.';
    if (e.status === 429) {
      return 'Se registraron demasiadas gestiones seguidas. Espera un minuto y vuelve a intentarlo.';
    }
    if (e.status === 400 || e.status === 422) {
      return 'No se pudo guardar la gestión: revisa la causal y la observación.';
    }
  }
  return 'No se pudo guardar la gestión. Vuelve a intentarlo.';
}

interface Props {
  registro: ComparendoRegistroDetalle;
  /** Catálogo completo, con `activo` y `orden`. No el mapa de etiquetas: aquí hacen falta los dos. */
  causales: ComparendosCausal[];
  /** El cuerpo del `PATCH`, que ya es el registro entero con su timeline. */
  onGuardado: (nuevo: ComparendoRegistroDetalle) => void;
  /** Avisa al panel de si hay cambios sin guardar, para que Esc pida confirmación antes de cerrar. */
  onSucio: (sucio: boolean) => void;
}

export default function FormularioGestion({ registro, causales, onGuardado, onSucio }: Props) {
  const [causalId, setCausalId] = useState<string>(registro.causalId ?? SIN_CAUSAL);
  const [observacion, setObservacion] = useState<string>(registro.observacion ?? '');
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Las opciones del selector, y aquí está la trampa del catálogo.
   *
   * El catálogo tiene causales que se pueden desactivar, y un comparendo puede tener asignada una
   * que hoy está inactiva. Si el selector solo listara las activas no podría representar el valor
   * actual, así que caería en la primera opción y el primer guardado de la OBSERVACIÓN cambiaría la
   * causal sin que nadie lo pidiera. Por eso la inactiva ASIGNADA entra igualmente, marcada, y
   * ninguna otra inactiva lo hace: se puede conservar, no volver a elegir.
   *
   * El mismo agujero tiene una segunda boca, más rara y más fea: **que el catálogo no haya
   * cargado**. `useCatalogosComparendos` se traga el fallo de cada catálogo a propósito —son
   * etiquetas, y no pueden dejar la tabla sin pintar—, así que aquí puede llegar una lista vacía con
   * un comparendo que sí tiene causal. Sin la opción de respaldo, el selector enseñaría «— Sin
   * causal —» para un comparendo gestionado: no lo guardaría así (el borrador conserva el id y
   * `[Guardar]` sigue inhabilitado), pero estaría MINTIENDO en pantalla, que es peor que un nombre
   * feo. Con ella se dice lo que pasa: hay causal, y no se pudo leer cuál.
   */
  const opciones = useMemo(() => {
    const orden = [...causales].sort((a, b) => a.orden - b.orden);
    const visibles = orden.filter((c) => c.activo || c.id === registro.causalId);
    const lista = visibles.map((c) => ({
      id: c.id,
      etiqueta: c.activo ? c.nombre : `${c.nombre} (inactiva)`,
    }));
    if (registro.causalId && !lista.some((o) => o.id === registro.causalId)) {
      lista.unshift({ id: registro.causalId, etiqueta: 'Causal asignada (no se pudo cargar el catálogo)' });
    }
    return lista;
  }, [causales, registro.causalId]);

  const observacionRecortada = observacion.trim();
  const excedida = observacion.length > COMPARENDOS_OBSERVACION_MAX;

  // Lo que cambió respecto de lo que dice el SERVIDOR, no respecto del último render: es lo que
  // decide qué claves lleva el cuerpo.
  const causalCambio = (causalId || null) !== registro.causalId;
  const observacionCambio = (observacionRecortada || null) !== registro.observacion;
  const sucio = causalCambio || observacionCambio;

  // El panel necesita saberlo para que Esc no tire una observación a medio escribir. Va en un
  // efecto y no en el cuerpo del render: llamar al `setState` del PADRE mientras se renderiza el
  // HIJO es el aviso «Cannot update a component while rendering a different component» de React, y
  // el commit de diferencia no se paga en ningún sitio — el efecto corre antes de que a nadie le dé
  // tiempo a pulsar una tecla.
  // El `return` no es adorno: si el formulario se desmonta —el panel cayó en error, o se recargó—
  // el aviso se queda pegado en `true` y cerrar el panel pediría confirmación por un texto que ya
  // no está en ninguna parte.
  useEffect(() => {
    onSucio(sucio);
    return () => onSucio(false);
  }, [sucio, onSucio]);

  const restablecer = () => {
    setCausalId(registro.causalId ?? SIN_CAUSAL);
    setObservacion(registro.observacion ?? '');
    setError(null);
  };

  const enviar = async (e: FormEvent) => {
    e.preventDefault();
    // Doble candado del AC6: el botón ya está inhabilitado, y aun así no se llama al API. Un submit
    // puede entrar por Enter desde un campo, y «lo impide antes de llamar al API» es una afirmación
    // sobre la red, no sobre un atributo del botón.
    if (!sucio || excedida || guardando) return;

    const cambios: ComparendosGestionPatch = {};
    if (causalCambio) cambios.causalId = causalId || null;
    if (observacionCambio) cambios.observacion = observacionRecortada || null;

    setGuardando(true);
    setError(null);
    try {
      // La respuesta ES el registro con su timeline ya actualizado: se entrega tal cual y el panel
      // se repinta con ella. No se pide nada más ni se fabrica el evento en local.
      const nuevo = await guardarGestion(registro.id, cambios);
      onGuardado(nuevo);
      toast.success('Gestión guardada.');
    } catch (err) {
      setError(errorDeGuardado(err));
    } finally {
      setGuardando(false);
    }
  };

  const idContador = `contador-observacion-${registro.id}`;
  const idError = `error-gestion-${registro.id}`;

  return (
    <form onSubmit={enviar} className="space-y-3" aria-label="Gestión del comparendo">
      {/* AC5 — quién hizo la última gestión y cuándo. Sale de la FILA (`gestionActualizadaEn` /
          `gestionActualizadaPor`), no del timeline: el evento no publica su actor y no va a
          publicarlo (es PII y la lista blanca de RN-35 no se amplía). */}
      <p className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
        {registro.gestionActualizadaEn
          ? `Última gestión: ${fechaHoraColombia(registro.gestionActualizadaEn)}`
            + `${registro.gestionActualizadaPor ? ` · ${registro.gestionActualizadaPor.nombre}` : ''}`
          : 'Nadie ha gestionado este comparendo todavía.'}
      </p>

      <div className="max-w-sm">
        <FlitField label="Causal">
          <select
            className={flitInp}
            value={causalId}
            disabled={guardando}
            onChange={(e) => setCausalId(e.target.value)}
          >
            {/* Una opción REAL y no un `placeholder`: «sin causal» es un valor que se guarda
                (`causalId: null`) y es la mitad del AC4 —limpiar la gestión—. */}
            <option value={SIN_CAUSAL}>— Sin causal —</option>
            {opciones.map((o) => <option key={o.id} value={o.id}>{o.etiqueta}</option>)}
          </select>
        </FlitField>
      </div>

      <FlitField label="Observación">
        <textarea
          className={flitInp}
          rows={3}
          value={observacion}
          disabled={guardando}
          aria-describedby={`${idContador}${error ? ` ${idError}` : ''}`}
          aria-invalid={excedida || undefined}
          onChange={(e) => setObservacion(e.target.value)}
        />
      </FlitField>

      {/* El contador se pone en rojo Y aparece el mensaje: el color no puede cargar solo con la
          información (regla 12). `aria-live="polite"` porque el número cambia con cada tecla y
          `assertive` interrumpiría al usuario mientras escribe. */}
      <p
        id={idContador}
        aria-live="polite"
        className="text-xs"
        style={{ color: excedida ? 'var(--flit-danger-ink)' : 'var(--flit-text-secondary)' }}
      >
        {`${observacion.length} / ${COMPARENDOS_OBSERVACION_MAX} caracteres`}
        {excedida && ` · La observación admite hasta ${COMPARENDOS_OBSERVACION_MAX} caracteres.`}
      </p>

      {error && (
        <p id={idError} role="alert" className="text-sm" style={{ color: 'var(--flit-danger-ink)' }}>
          {error}
        </p>
      )}

      <div className="flex flex-wrap justify-end gap-2">
        <button
          type="button"
          className={flitBtnSecondary}
          style={flitBtnSecondaryStyle}
          disabled={!sucio || guardando}
          onClick={restablecer}
        >
          Cancelar
        </button>
        <button
          type="submit"
          className={flitBtnPrimary}
          style={flitBtnPrimaryStyle}
          disabled={!sucio || excedida || guardando}
          aria-busy={guardando || undefined}
        >
          {guardando ? 'Guardando…' : 'Guardar gestión'}
        </button>
      </div>
    </form>
  );
}
