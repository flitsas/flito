// FLITO — Comparendos · Configuración: bloque 3, causales de gestión (HU #11634, AC1 y AC2).
//
// El catálogo que decide QUÉ se puede registrar al gestionar un comparendo en el visor. Lo que
// distingue este bloque de sus dos vecinos es una columna: `orden`.
//
//   · **El orden es del negocio, no del alfabeto.** El selector de gestión del visor lista estas
//     causales en la secuencia en que se usan («Notificado al cliente» antes que «Pagado», y «En
//     gestión jurídica» al final), y esa secuencia no coincide con ninguna ordenación automática.
//     Por eso `orden` es un dato editable y se pinta como primera columna: si no se ve, nadie
//     entiende por qué la lista no está alfabetizada.
//   · **El nombre SÍ se edita**, al revés que el NIT o el `codigoFuente`. No es una llave que viaje
//     a ningún proveedor: es la etiqueta que el operador lee en el selector, y corregirle una tilde
//     no cambia a qué causal apunta un comparendo ya gestionado (la referencia es el `id`).
//   · **La inactiva se queda en la tabla.** Deja de ofrecerse en gestiones nuevas pero sigue
//     explicando las viejas, y es la única forma de volver a activarla (AC1).
//
// Aquí **no hay `[Eliminar]`**: el API no expone `DELETE /causales`, y con razón — borrar una causal
// dejaría sin explicación las gestiones que la citan. La baja es `PATCH { activo: false }`.
//
// La baja NO pide confirmación, igual que la de municipios y al revés que la del NIT: no toca ningún
// histórico, se deshace con un clic en la misma fila y la spec de UX solo pide confirmación donde la
// pregunta de verdad es «¿eliminar o desactivar?».
//
// Cableado, idéntico al de los bloques 1 y 2 y por los mismos motivos: la lista se parchea en sitio
// con la respuesta de la escritura —no se vuelve a pedir el catálogo, que haría parpadear el
// esqueleto sobre una tabla que alguien está mirando— y se ramifica por el `codigo` del cuerpo de
// error, nunca por su texto (`causal_duplicada` es contrato; el mensaje está en español y cambiará).

import { useState, type FormEvent } from 'react';
import toast from 'react-hot-toast';
import type { ComparendosCausal } from '@operaciones/shared-types';
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

const RUTA_CAUSALES = `${RUTA_COMPARENDOS}/causales`;

const NOMBRE_MAX = 120;

/**
 * Tope de `orden`: el de la columna, que es un `smallint` (`0..32767`).
 *
 * Se comprueba en el cliente ADEMÁS del servidor porque un 400 aquí no es un error del operador que
 * se pueda leer: el cuerpo del 400 habla de un esquema, y lo único accionable es «ese número no
 * cabe». Decirlo antes ahorra la petición y explica el límite.
 */
const ORDEN_MAX = 32767;

function validarNombre(nombre: string): string | null {
  if (!nombre) return 'Escribe el nombre de la causal.';
  if (nombre.length > NOMBRE_MAX) return `El nombre no puede pasar de ${NOMBRE_MAX} caracteres.`;
  // Mismo motivo que el alias del NIT: el nombre se concatena literal en el detalle de auditoría, y
  // un salto de línea parte en dos una entrada de la bitácora para quien la lea.
  if (/[\r\n\t]/.test(nombre)) return 'El nombre no admite saltos de línea ni tabulaciones.';
  return null;
}

/** `null` = «no lo dijo» (válido en el alta: el servidor pone 0). `undefined` = escrito y mal. */
function leerOrden(escrito: string): number | null | undefined {
  const limpio = escrito.trim();
  if (!limpio) return null;
  // Se comprueba la FORMA de lo escrito antes de convertir, y ni `parseInt` ni `Number` bastan:
  //
  //   · `parseInt('10abc')` devuelve 10 y guardaría un orden que nadie pidió.
  //   · `Number` no arregla eso del todo. Acepta otras formas de escribir un número que un campo de
  //     orden no admite —`0x10` es 16, `0o17` es 15, `0b11` es 3, `1e3` es 1000, `10.0` es 10— y las
  //     cinco dan un entero dentro del rango, así que pasaban `Number.isInteger` y el tope sin que
  //     nada avisara: el operador escribía una cosa y se guardaba otra (HU #11652, AC4). También
  //     convierte dígitos de otras escrituras (`'١٠'` → 10), que es lo mismo por otro camino.
  //
  // `^\d+$` deja pasar exactamente lo que el campo dice admitir: dígitos decimales y nada más. El
  // signo tampoco entra, y no hace falta: el rango empieza en 0 y un `-1` no es un orden.
  if (!/^\d+$/.test(limpio)) return undefined;
  const valor = Number(limpio);
  // Solo el techo: la forma ya garantiza entero y no negativo.
  if (valor > ORDEN_MAX) return undefined;
  return valor;
}

const ERROR_ORDEN = `El orden debe ser un número entero entre 0 y ${ORDEN_MAX}.`;

// El campo de orden es de TEXTO con `inputMode="numeric"`, no un `type="number"` con `min`/`max`.
// Con las restricciones nativas, «40000» o «10,5» los rechaza el navegador antes del `submit`: no
// llega a correr la validación de arriba, no se pinta `ErrorFormulario` y lo que el operador recibe
// es un globo del navegador —sin `role="alert"`, con el idioma del navegador y no el de la app, y
// que se desvanece solo—. Mismo criterio que el campo de NIT del bloque 1: el teclado numérico en
// móvil se pide con `inputMode`, y el error lo explica la aplicación.

/** Copy propio por `codigo`/estado; el texto del servidor no se pinta (postura de la #11559). */
function mensajeDeEscritura(e: unknown, verbo: 'agregar' | 'guardar'): string {
  if (codigoDeError(e) === 'causal_duplicada') return 'Ya hay una causal con ese nombre.';
  // `POST /causales` no tiene limitador propio, pero le aplica el global de `/api`: sin esta rama un
  // 429 caería en el genérico «vuelve a intentarlo» y el operador reintentaría contra la pared.
  if (e instanceof ApiError && e.status === 429) {
    return 'Se hicieron muchas peticiones en el último minuto. Espera un minuto y vuelve a intentarlo.';
  }
  if (e instanceof ApiError && e.status === 400) return 'Revisa el nombre y el orden antes de guardar.';
  if (e instanceof ApiError && e.status === 404) {
    return 'Esa causal ya no está en el catálogo. Recarga la lista para verla como está.';
  }
  return verbo === 'agregar'
    ? 'No se pudo agregar la causal. Vuelve a intentarlo.'
    : 'No se pudo guardar la causal. Vuelve a intentarlo.';
}

/**
 * El orden de `GET /causales`: `orden` ascendente y, a igualdad, nombre.
 *
 * El desempate por nombre no es adorno: `orden` NO es único —dos causales pueden compartir el 10— y
 * sin segundo criterio la tabla las barajaría en cada parcheo, moviendo filas que nadie tocó.
 */
const porOrden = (a: ComparendosCausal, b: ComparendosCausal) => (
  a.orden - b.orden || a.nombre.localeCompare(b.nombre, 'es')
);

export default function CausalesComparendos() {
  const { items, estado, setItems, recargar } = useCatalogoConfig<ComparendosCausal>(RUTA_CAUSALES);
  const [alta, setAlta] = useState(false);
  const [editando, setEditando] = useState<ComparendosCausal | null>(null);

  const reemplazar = (fila: ComparendosCausal) => setItems(
    (previas) => previas.map((c) => (c.id === fila.id ? fila : c)).sort(porOrden),
  );

  const cambiarActivo = async (fila: ComparendosCausal, activo: boolean) => {
    try {
      const actualizada = await api.patch<ComparendosCausal>(`${RUTA_CAUSALES}/${encodeURIComponent(fila.id)}`, { activo });
      reemplazar(actualizada);
      toast.success(activo ? 'Causal activada.' : 'Causal desactivada.');
    } catch {
      toast.error(activo ? 'No se pudo activar la causal.' : 'No se pudo desactivar la causal.');
    }
  };

  return (
    <>
      <BloqueConfig
        titulo="Causales de gestión"
        descripcion={
          'Las usa el visor al gestionar un comparendo. El orden es el del selector, no el '
          + 'alfabético. Una causal inactiva no se ofrece en altas nuevas, pero sigue visible aquí.'
        }
        accion={(
          <button type="button" className={flitBtnPrimary} style={flitBtnPrimaryStyle} onClick={() => setAlta(true)}>
            Agregar causal
          </button>
        )}
        estado={estado}
        hayItems={items.length > 0}
        textoError="No se pudieron cargar las causales de gestión. Vuelve a intentarlo."
        etiquetaCarga="Cargando causales de gestión"
        onReintentar={recargar}
        vacio={(
          <p style={{ color: 'var(--flit-text-secondary)' }}>
            No hay causales. El visor podrá listar comparendos, pero no asignar gestión hasta que
            agregues al menos una.
          </p>
        )}
      >
        <FlitTable>
          <caption className="sr-only">
            Causales de gestión, en el mismo orden en que las ofrece el visor. Las inactivas siguen
            en la lista: dejan de ofrecerse en gestiones nuevas, pero explican las ya registradas y
            se pueden volver a activar.
          </caption>
          <thead>
            <FlitTr>
              <FlitTh>Orden</FlitTh>
              <FlitTh>Nombre</FlitTh>
              <FlitTh>Estado</FlitTh>
              <FlitTh>Acciones</FlitTh>
            </FlitTr>
          </thead>
          <tbody>
            {items.map((c) => (
              <FlitTr key={c.id}>
                <td className="px-4 py-2.5 text-sm tabular-nums" style={{ color: 'var(--flit-text-secondary)' }}>
                  {c.orden}
                </td>
                <td className="px-4 py-2.5 text-sm font-medium" style={{ color: 'var(--flit-text-primary)' }}>
                  {c.nombre}
                </td>
                <td className="px-4 py-2.5"><ChipEstadoConfig activo={c.activo} genero="f" /></td>
                <td className="px-4 py-2.5">
                  <div className="flex flex-wrap gap-2">
                    {/* El nombre de la causal va en el `aria-label` porque «Editar» a secas se repite
                        en cada fila y un lector anunciaría una lista de botones idénticos. El texto
                        visible va DENTRO del nombre accesible (WCAG 2.5.3). */}
                    <button
                      type="button"
                      className={flitBtnSecondarySm}
                      style={flitBtnSecondaryStyle}
                      aria-label={`Editar la causal ${c.nombre}`}
                      onClick={() => setEditando(c)}
                    >
                      Editar
                    </button>
                    {c.activo ? (
                      <button
                        type="button"
                        className={flitBtnSecondarySm}
                        style={flitBtnSecondaryStyle}
                        aria-label={`Desactivar la causal ${c.nombre}`}
                        onClick={() => { void cambiarActivo(c, false); }}
                      >
                        Desactivar
                      </button>
                    ) : (
                      <button
                        type="button"
                        className={flitBtnSecondarySm}
                        style={flitBtnSecondaryStyle}
                        aria-label={`Activar la causal ${c.nombre}`}
                        onClick={() => { void cambiarActivo(c, true); }}
                      >
                        Activar
                      </button>
                    )}
                  </div>
                </td>
              </FlitTr>
            ))}
          </tbody>
        </FlitTable>
      </BloqueConfig>

      {alta && (
        <ModalCausal
          onCerrar={() => setAlta(false)}
          onCreada={(nueva) => {
            setItems((previas) => [...previas, nueva].sort(porOrden));
            setAlta(false);
            toast.success('Causal agregada.');
          }}
        />
      )}

      {editando && (
        <ModalEditarCausal
          fila={editando}
          onCerrar={() => setEditando(null)}
          onGuardada={(actualizada) => {
            reemplazar(actualizada);
            setEditando(null);
            toast.success('Causal actualizada.');
          }}
        />
      )}
    </>
  );
}

// ───────────────────────────────────────── Modales ──────────────────────────────────────────────

/** Ayuda del campo `orden`, la misma en el alta y en la edición: explica el 0 y el desempate. */
function AyudaOrden() {
  return (
    <p className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
      Es la posición en el selector del visor, de menor a mayor. Se suele numerar de diez en diez
      para poder intercalar después. Si lo dejas vacío queda en 0.
    </p>
  );
}

function ModalCausal(
  { onCerrar, onCreada }: { onCerrar: () => void; onCreada: (c: ComparendosCausal) => void },
) {
  const [nombre, setNombre] = useState('');
  const [orden, setOrden] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  const guardar = async (e: FormEvent) => {
    e.preventDefault();
    const limpio = nombre.trim();
    const problema = validarNombre(limpio);
    if (problema) { setError(problema); return; }
    const posicion = leerOrden(orden);
    if (posicion === undefined) { setError(ERROR_ORDEN); return; }
    setError(null);
    setOcupado(true);
    try {
      // `orden` se OMITE cuando no se escribió, en vez de mandar un 0 nuestro: el valor por defecto
      // es del servidor y mandarlo desde aquí lo congelaría el día que allí cambie.
      const cuerpo: Record<string, unknown> = { nombre: limpio };
      if (posicion !== null) cuerpo.orden = posicion;
      onCreada(await api.post<ComparendosCausal>(RUTA_CAUSALES, cuerpo));
    } catch (err) {
      setError(mensajeDeEscritura(err, 'agregar'));
      setOcupado(false);
    }
  };

  return (
    <FlitModal title="Agregar causal" onClose={onCerrar}>
      <form className="space-y-4" onSubmit={guardar}>
        <FlitField label="Nombre *">
          <input
            className={flitInp}
            value={nombre}
            onChange={(e) => setNombre(e.target.value)}
            autoComplete="off"
            maxLength={NOMBRE_MAX}
            required
          />
        </FlitField>
        <FlitField label="Orden">
          <input
            className={flitInp}
            inputMode="numeric"
            value={orden}
            onChange={(e) => setOrden(e.target.value)}
            autoComplete="off"
          />
        </FlitField>
        <AyudaOrden />
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
 * Editar nombre y orden a la vez.
 *
 * Se manda SIEMPRE el cuerpo completo `{ nombre, orden }` y no un diff con lo que cambió: son dos
 * campos que se miran juntos —reordenar suele ir con renombrar— y el `PATCH` admite ambos. Lo único
 * que se cuida es que el cuerpo nunca vaya vacío, que el servidor rechaza con 400; con estos dos
 * campos siempre presentes, eso no puede pasar.
 *
 * `activo` NO viaja aquí: se gobierna desde los botones de la fila, y meterlo en este formulario
 * daría dos sitios para lo mismo.
 */
function ModalEditarCausal(
  { fila, onCerrar, onGuardada }:
  { fila: ComparendosCausal; onCerrar: () => void; onGuardada: (c: ComparendosCausal) => void },
) {
  const [nombre, setNombre] = useState(fila.nombre);
  const [orden, setOrden] = useState(String(fila.orden));
  const [error, setError] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  const guardar = async (e: FormEvent) => {
    e.preventDefault();
    const limpio = nombre.trim();
    const problema = validarNombre(limpio);
    if (problema) { setError(problema); return; }
    const posicion = leerOrden(orden);
    // En la edición el vacío tampoco vale: la fila YA tiene un orden y borrarlo no significa
    // «ninguno», significa 0 — que es un cambio, no una omisión. Se pide escribirlo.
    if (posicion === undefined || posicion === null) { setError(ERROR_ORDEN); return; }
    setError(null);
    setOcupado(true);
    try {
      onGuardada(await api.patch<ComparendosCausal>(
        `${RUTA_CAUSALES}/${encodeURIComponent(fila.id)}`, { nombre: limpio, orden: posicion },
      ));
    } catch (err) {
      setError(mensajeDeEscritura(err, 'guardar'));
      setOcupado(false);
    }
  };

  return (
    <FlitModal title={`Editar causal · ${fila.nombre}`} onClose={onCerrar}>
      <form className="space-y-4" onSubmit={guardar}>
        <FlitField label="Nombre *">
          <input
            className={flitInp}
            value={nombre}
            onChange={(e) => setNombre(e.target.value)}
            autoComplete="off"
            maxLength={NOMBRE_MAX}
            required
          />
        </FlitField>
        <FlitField label="Orden *">
          <input
            className={flitInp}
            inputMode="numeric"
            value={orden}
            onChange={(e) => setOrden(e.target.value)}
            autoComplete="off"
            required
          />
        </FlitField>
        <AyudaOrden />
        <p className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
          Renombrar no cambia las gestiones ya registradas: siguen apuntando a esta misma causal.
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
