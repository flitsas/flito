// FLITO — Comparendos · Configuración: bloque 1, NITs monitoreados (HU #11633, AC3 y AC4).
//
// El catálogo que decide a QUIÉN se le consultan comparendos. Tres reglas de dominio se ven en el
// marcado y conviene leerlas juntas, porque explican por qué esta tabla tiene tres botones por fila
// y no uno:
//
//   · **El NIT no se edita.** Es la llave con la que se pregunta a SIMIT y a los UTS municipales, y
//     cambiarla en sitio convertiría el histórico ya traído en histórico de otra empresa. Lo que se
//     edita es el alias, que es solo para reconocerlo en pantalla.
//   · **Eliminar y desactivar NO son lo mismo, y solo el servidor sabe cuál toca.** `DELETE` está
//     permitido únicamente mientras el NIT no haya traído ni un comparendo; si trajo, responde 409
//     `nit_en_uso` y hay que desactivarlo para conservar el histórico. La pantalla NO puede
//     adivinarlo —no tiene el conteo— así que ofrece `[Eliminar]` en todas las filas y trata el 409
//     como lo que es: la respuesta correcta, con una salida a mano (ver `ModalEliminarNit`).
//   · **El inactivo se queda en la tabla.** Es la única forma de volver a activarlo; ocultarlo
//     dejaría un NIT gobernable solo por SQL.
//
// Dos decisiones de cableado:
//
//   1. **La lista se parchea en sitio con la respuesta de la escritura**, no se vuelve a pedir. El
//      `POST` y el `PATCH` devuelven la fila completa y ya normalizada por el servidor, así que
//      refrescar el catálogo entero solo añadiría un parpadeo del esqueleto sobre una tabla que
//      alguien está mirando. El orden se mantiene ordenando por `nit`, que es el mismo criterio con
//      el que responde `GET /nits`.
//   2. **Se ramifica por el `codigo` del cuerpo de error, jamás por su texto** (misma postura que la
//      #11559). El mensaje del servidor está en español y va a cambiar; `nit_duplicado` y
//      `nit_en_uso` son contrato. Y ningún mensaje del servidor se pinta tal cual: el copy es
//      nuestro, incluido el del 429 del limitador de altas.
//
// PII: el NIT se enseña COMPLETO —es el eje del módulo y esta pantalla solo la ve `admin`— pero no
// entra en la URL del SPA, ni en `console`, ni en un `placeholder` de ejemplo (política del módulo:
// en comparendos, lo único con forma de NIT que llega al DOM viene del servidor o de lo que el
// propio usuario acaba de escribir).

import { useState, type FormEvent } from 'react';
import toast from 'react-hot-toast';
import type { ComparendosNit } from '@operaciones/shared-types';
import { ApiError, api } from '../../../lib/api';
import FlitModal from '../../flit/FlitModal';
import {
  FlitField, FlitTable, FlitTh, FlitTr, flitBtnPrimary, flitBtnPrimaryStyle,
  flitBtnSecondary, flitBtnSecondarySm, flitBtnSecondaryStyle, flitInp,
} from '../../flit/flitPageKit';
import {
  BloqueConfig, ChipEstadoConfig, ErrorFormulario, RUTA_COMPARENDOS, useCatalogoConfig,
} from './bloqueConfigComparendos';
import { codigoDeError } from './useComparendoDetalle';
import { normalizarNit } from './useComparendosLista';

const RUTA_NITS = `${RUTA_COMPARENDOS}/nits`;

const ALIAS_MAX = 120;

/**
 * Lo que el servidor exige (`nitSchema`), comprobado aquí ADEMÁS de allí.
 *
 * No es desconfianza del backend: es que el alta tiene limitador de tasa (5/min) y gastar un intento
 * en «ABC12» dejaría al operador sin poder corregir. La comprobación se hace sobre el valor YA
 * normalizado, porque «900.123.456» son doce caracteres escritos y nueve de NIT.
 */
function validarNit(escrito: string): string | null {
  const nit = normalizarNit(escrito);
  if (!nit) return 'Escribe el NIT.';
  if (!/^\d+(-\d)?$/.test(nit)) {
    return 'El NIT admite solo dígitos, con guion opcional para el dígito de verificación.';
  }
  if (nit.length < 5 || nit.length > 20) return 'El NIT debe tener entre 5 y 20 caracteres.';
  return null;
}

function validarAlias(alias: string): string | null {
  if (alias.length > ALIAS_MAX) return `El alias no puede pasar de ${ALIAS_MAX} caracteres.`;
  // El alias se concatena literal en el detalle de la bitácora: un salto de línea parte en dos una
  // entrada de auditoría para quien la lea.
  if (/[\r\n\t]/.test(alias)) return 'El alias no admite saltos de línea ni tabulaciones.';
  return null;
}

/** Copy propio por `codigo`/estado. El texto del servidor no se pinta nunca. */
function mensajeDeAlta(e: unknown): string {
  if (codigoDeError(e) === 'nit_duplicado') return 'Ese NIT ya está en el catálogo de monitoreo.';
  if (e instanceof ApiError && e.status === 429) {
    return 'Se agregaron varios NIT en el último minuto. Espera un minuto y vuelve a intentarlo.';
  }
  if (e instanceof ApiError && e.status === 400) return 'Revisa el NIT y el alias antes de guardar.';
  return 'No se pudo agregar el NIT. Vuelve a intentarlo.';
}

/** Orden de `GET /nits`: ascendente por NIT. Se replica al insertar para no barajar la tabla. */
const porNit = (a: ComparendosNit, b: ComparendosNit) => a.nit.localeCompare(b.nit);

export default function NitsComparendos() {
  const { items, estado, setItems, recargar } = useCatalogoConfig<ComparendosNit>(RUTA_NITS);
  const [alta, setAlta] = useState(false);
  const [editando, setEditando] = useState<ComparendosNit | null>(null);
  const [confirmandoBaja, setConfirmandoBaja] = useState<ComparendosNit | null>(null);
  const [eliminando, setEliminando] = useState<ComparendosNit | null>(null);

  const reemplazar = (fila: ComparendosNit) => setItems(
    (previos) => previos.map((n) => (n.id === fila.id ? fila : n)).sort(porNit),
  );

  /** `PATCH { activo }`. Es la baja REVERSIBLE, y la única que conserva el histórico. */
  const cambiarActivo = async (fila: ComparendosNit, activo: boolean) => {
    try {
      const actualizado = await api.patch<ComparendosNit>(`${RUTA_NITS}/${encodeURIComponent(fila.id)}`, { activo });
      reemplazar(actualizado);
      toast.success(activo ? 'NIT activado.' : 'NIT desactivado.');
    } catch {
      toast.error(activo ? 'No se pudo activar el NIT.' : 'No se pudo desactivar el NIT.');
    }
  };

  return (
    <>
      <BloqueConfig
        titulo="NITs monitoreados"
        descripcion={
          'Son las empresas que se consultan en SIMIT y en los municipios. El NIT no se edita: si '
          + 'está mal escrito y nunca sincronizó, se elimina; si ya trajo datos, se desactiva.'
        }
        accion={(
          <button type="button" className={flitBtnPrimary} style={flitBtnPrimaryStyle} onClick={() => setAlta(true)}>
            Agregar NIT
          </button>
        )}
        estado={estado}
        hayItems={items.length > 0}
        textoError="No se pudieron cargar los NIT monitoreados. Vuelve a intentarlo."
        etiquetaCarga="Cargando NITs monitoreados"
        onReintentar={recargar}
        vacio={(
          <div className="space-y-1" style={{ color: 'var(--flit-text-secondary)' }}>
            <p className="font-semibold">Todavía no hay NIT monitoreados.</p>
            <p>Agrega al menos uno antes de sincronizar.</p>
          </div>
        )}
      >
        <FlitTable>
          <caption className="sr-only">
            NIT monitoreados. Los inactivos siguen en la lista: dejan de consultarse, pero conservan
            los comparendos que ya trajeron y se pueden volver a activar.
          </caption>
          <thead>
            <FlitTr>
              <FlitTh>NIT</FlitTh>
              <FlitTh>Alias</FlitTh>
              <FlitTh>Estado</FlitTh>
              <FlitTh>Acciones</FlitTh>
            </FlitTr>
          </thead>
          <tbody>
            {items.map((n) => (
              <FlitTr key={n.id}>
                <td className="px-4 py-2.5 text-sm font-medium" style={{ color: 'var(--flit-text-primary)' }}>
                  {n.nit}
                </td>
                <td className="px-4 py-2.5 text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
                  {n.alias ?? '—'}
                </td>
                <td className="px-4 py-2.5"><ChipEstadoConfig activo={n.activo} /></td>
                <td className="px-4 py-2.5">
                  <div className="flex flex-wrap gap-2">
                    {/* El `aria-label` lleva el NIT porque «Editar alias» a secas se repite en cada
                        fila y un lector de pantalla anunciaría una lista de botones idénticos. El
                        texto visible va DENTRO del nombre accesible (WCAG 2.5.3). */}
                    <button
                      type="button"
                      className={flitBtnSecondarySm}
                      style={flitBtnSecondaryStyle}
                      aria-label={`Editar alias del NIT ${n.nit}`}
                      onClick={() => setEditando(n)}
                    >
                      Editar alias
                    </button>
                    {n.activo ? (
                      <button
                        type="button"
                        className={flitBtnSecondarySm}
                        style={flitBtnSecondaryStyle}
                        aria-label={`Desactivar el NIT ${n.nit}`}
                        onClick={() => setConfirmandoBaja(n)}
                      >
                        Desactivar
                      </button>
                    ) : (
                      <button
                        type="button"
                        className={flitBtnSecondarySm}
                        style={flitBtnSecondaryStyle}
                        aria-label={`Activar el NIT ${n.nit}`}
                        onClick={() => { void cambiarActivo(n, true); }}
                      >
                        Activar
                      </button>
                    )}
                    <button
                      type="button"
                      className={flitBtnSecondarySm}
                      style={flitBtnSecondaryStyle}
                      aria-label={`Eliminar el NIT ${n.nit}`}
                      onClick={() => setEliminando(n)}
                    >
                      Eliminar
                    </button>
                  </div>
                </td>
              </FlitTr>
            ))}
          </tbody>
        </FlitTable>
      </BloqueConfig>

      {alta && (
        <ModalNit
          onCerrar={() => setAlta(false)}
          onCreado={(nuevo) => {
            setItems((previos) => [...previos, nuevo].sort(porNit));
            setAlta(false);
            toast.success('NIT agregado.');
          }}
        />
      )}

      {editando && (
        <ModalAlias
          fila={editando}
          onCerrar={() => setEditando(null)}
          onGuardado={(actualizado) => { reemplazar(actualizado); setEditando(null); toast.success('NIT actualizado.'); }}
        />
      )}

      {confirmandoBaja && (
        <FlitModal title="Desactivar NIT" onClose={() => setConfirmandoBaja(null)}>
          <div className="space-y-4">
            <p className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
              Dejará de consultarse en la próxima sincronización. Los comparendos ya registrados se
              conservan.
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className={flitBtnSecondary}
                style={flitBtnSecondaryStyle}
                onClick={() => setConfirmandoBaja(null)}
              >
                Cancelar
              </button>
              <button
                type="button"
                className={flitBtnPrimary}
                style={flitBtnPrimaryStyle}
                onClick={() => { const fila = confirmandoBaja; setConfirmandoBaja(null); void cambiarActivo(fila, false); }}
              >
                Desactivar
              </button>
            </div>
          </div>
        </FlitModal>
      )}

      {eliminando && (
        <ModalEliminarNit
          fila={eliminando}
          onCerrar={() => setEliminando(null)}
          onEliminado={(fila) => {
            setItems((previos) => previos.filter((n) => n.id !== fila.id));
            setEliminando(null);
            toast.success('NIT eliminado.');
          }}
          onDesactivar={(fila) => { setEliminando(null); void cambiarActivo(fila, false); }}
        />
      )}
    </>
  );
}

// ───────────────────────────────────────── Modales ──────────────────────────────────────────────

function ModalNit({ onCerrar, onCreado }: { onCerrar: () => void; onCreado: (n: ComparendosNit) => void }) {
  const [nit, setNit] = useState('');
  const [alias, setAlias] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  const guardar = async (e: FormEvent) => {
    e.preventDefault();
    const problema = validarNit(nit) ?? validarAlias(alias.trim());
    if (problema) { setError(problema); return; }
    setError(null);
    setOcupado(true);
    try {
      // El NIT se normaliza AL ENVIAR y no al teclear: reescribir el campo bajo los dedos manda el
      // cursor al final y hace imposible corregir un dígito del medio. Quien escribe «900.123.456»
      // sigue viendo sus puntos.
      const cuerpo: Record<string, string> = { nit: normalizarNit(nit) };
      if (alias.trim()) cuerpo.alias = alias.trim();
      onCreado(await api.post<ComparendosNit>(RUTA_NITS, cuerpo));
    } catch (err) {
      setError(mensajeDeAlta(err));
      setOcupado(false);
    }
  };

  return (
    <FlitModal title="Agregar NIT" onClose={onCerrar}>
      <form className="space-y-4" onSubmit={guardar}>
        <FlitField label="NIT *">
          <input
            className={flitInp}
            value={nit}
            onChange={(e) => setNit(e.target.value)}
            autoComplete="off"
            inputMode="numeric"
            required
          />
        </FlitField>
        <p className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
          Solo dígitos. Los puntos y espacios se quitan al guardar; el guion del dígito de
          verificación se conserva tal cual lo escribas.
        </p>
        <FlitField label="Alias">
          <input
            className={flitInp}
            value={alias}
            onChange={(e) => setAlias(e.target.value)}
            autoComplete="off"
            maxLength={ALIAS_MAX}
          />
        </FlitField>
        {error && <ErrorFormulario>{error}</ErrorFormulario>}
        <div className="flex justify-end gap-2">
          <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={onCerrar}>
            Cancelar
          </button>
          <button type="submit" className={flitBtnPrimary} style={flitBtnPrimaryStyle} disabled={ocupado} aria-busy={ocupado}>
            {ocupado ? 'Guardando…' : 'Guardar'}
          </button>
        </div>
      </form>
    </FlitModal>
  );
}

function ModalAlias(
  { fila, onCerrar, onGuardado }:
  { fila: ComparendosNit; onCerrar: () => void; onGuardado: (n: ComparendosNit) => void },
) {
  const [alias, setAlias] = useState(fila.alias ?? '');
  const [error, setError] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  const guardar = async (e: FormEvent) => {
    e.preventDefault();
    const problema = validarAlias(alias.trim());
    if (problema) { setError(problema); return; }
    setError(null);
    setOcupado(true);
    try {
      // Vacío significa BORRAR el alias, y eso se dice con `null`: mandar `''` guardaría una cadena
      // vacía, que en la tabla se vería igual que «sin alias» pero no lo sería.
      const nuevo = alias.trim() === '' ? null : alias.trim();
      onGuardado(await api.patch<ComparendosNit>(`${RUTA_NITS}/${encodeURIComponent(fila.id)}`, { alias: nuevo }));
    } catch {
      setError('No se pudo guardar el alias. Vuelve a intentarlo.');
      setOcupado(false);
    }
  };

  return (
    <FlitModal title={`Editar alias · NIT ${fila.nit}`} onClose={onCerrar}>
      <form className="space-y-4" onSubmit={guardar}>
        <FlitField label="Alias">
          <input
            className={flitInp}
            value={alias}
            onChange={(e) => setAlias(e.target.value)}
            autoComplete="off"
            maxLength={ALIAS_MAX}
          />
        </FlitField>
        <p className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
          Es solo la etiqueta con la que reconoces el NIT en pantalla. Déjalo vacío para quitarlo.
        </p>
        {error && <ErrorFormulario>{error}</ErrorFormulario>}
        <div className="flex justify-end gap-2">
          <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={onCerrar}>
            Cancelar
          </button>
          <button type="submit" className={flitBtnPrimary} style={flitBtnPrimaryStyle} disabled={ocupado} aria-busy={ocupado}>
            {ocupado ? 'Guardando…' : 'Guardar'}
          </button>
        </div>
      </form>
    </FlitModal>
  );
}

/**
 * Eliminar, con la salida de emergencia dentro.
 *
 * El 409 `nit_en_uso` NO se trata como un fallo: es la respuesta correcta a una petición razonable,
 * y lo único que le falta al operador es la alternativa. Por eso el modal no se cierra al recibirlo
 * —cerrarlo obligaría a reconstruir en la cabeza qué fila era— y cambia su botón primario por
 * `[Desactivar]`, que es lo que de verdad quería hacer.
 *
 * **La fila no se toca hasta saber la respuesta.** Un borrado optimista aquí es el fallo caro: el
 * operador vería desaparecer un NIT que sigue vivo en el servidor y se enteraría en la siguiente
 * sincronización.
 *
 * El `[Desactivar]` que se ofrece cierra el modal en el acto y deja el `PATCH` en manos del bloque:
 * ya hubo confirmación explícita —se pidió eliminar, que es más—, así que encadenar otro diálogo de
 * confirmación sería preguntar dos veces lo mismo.
 */
function ModalEliminarNit(
  { fila, onCerrar, onEliminado, onDesactivar }:
  {
    fila: ComparendosNit;
    onCerrar: () => void;
    onEliminado: (n: ComparendosNit) => void;
    onDesactivar: (n: ComparendosNit) => void;
  },
) {
  const [error, setError] = useState<string | null>(null);
  const [enUso, setEnUso] = useState(false);
  const [ocupado, setOcupado] = useState(false);

  const eliminar = async () => {
    setOcupado(true);
    setError(null);
    try {
      await api.delete(`${RUTA_NITS}/${encodeURIComponent(fila.id)}`);
      onEliminado(fila);
    } catch (e) {
      if (codigoDeError(e) === 'nit_en_uso') {
        setError(
          'Este NIT ya tiene comparendos registrados y no se puede eliminar. Desactívalo para '
          + 'conservar el histórico.',
        );
        setEnUso(true);
      } else if (e instanceof ApiError && e.status === 404) {
        setError('Ese NIT ya no está en el catálogo. Recarga la lista para verla como está.');
      } else {
        setError('No se pudo eliminar el NIT. Vuelve a intentarlo.');
      }
      setOcupado(false);
    }
  };

  return (
    <FlitModal title={`Eliminar NIT ${fila.nit}`} onClose={onCerrar}>
      <div className="space-y-4">
        <p className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
          Se borra del catálogo de monitoreo. Solo es posible mientras el NIT no haya traído ningún
          comparendo; si ya trajo, hay que desactivarlo para conservar el histórico.
        </p>
        {error && <ErrorFormulario>{error}</ErrorFormulario>}
        <div className="flex justify-end gap-2">
          <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={onCerrar}>
            Cancelar
          </button>
          {enUso ? (
            <button
              type="button"
              className={flitBtnPrimary}
              style={flitBtnPrimaryStyle}
              onClick={() => onDesactivar(fila)}
            >
              Desactivar
            </button>
          ) : (
            <button
              type="button"
              className={flitBtnPrimary}
              style={flitBtnPrimaryStyle}
              disabled={ocupado}
              aria-busy={ocupado}
              onClick={() => { void eliminar(); }}
            >
              {ocupado ? 'Borrando…' : 'Eliminar'}
            </button>
          )}
        </div>
      </div>
    </FlitModal>
  );
}
