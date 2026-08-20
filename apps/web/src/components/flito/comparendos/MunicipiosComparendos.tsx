// FLITO — Comparendos · Configuración: bloque 2, municipios fuente (HU #11633, AC5).
//
// El catálogo que decide DÓNDE se pregunta, además de SIMIT. Dos columnas y no una, y esa es la
// decisión de dominio que explica el bloque entero:
//
//   · `codigoFuente` es el valor LITERAL que viaja en la petición al UTS municipal («ITAGUI»), en
//     mayúsculas y sin tildes. Se normaliza al enviar y **no se edita después**: cambiarlo sería
//     apuntar a otra fuente conservando el histórico de la anterior.
//   · `nombre` es lo que lee un humano en el visor («Itagüí»). Es lo único editable, y existe
//     precisamente para poder escribir bien el nombre sin tocar el código.
//
// Aquí **no hay `[Eliminar]`**: el API no expone `DELETE` de municipio. Pintar el botón y traducir
// el 404 o el 405 a un mensaje sería ofrecer una acción que siempre falla. La baja es `PATCH
// { activo: false }`, que deja de consultarlo sin borrar lo que ya trajo — y por eso el inactivo
// sigue en la tabla: es la única forma de volver a activarlo.
//
// La baja NO pide confirmación, al revés que la del NIT. No es un descuido: desactivar un municipio
// no toca ningún histórico, se deshace con un clic en la misma fila y la spec de UX solo pide
// confirmación en el NIT (donde la pregunta de verdad es «¿eliminar o desactivar?»).

import { useState, type FormEvent } from 'react';
import toast from 'react-hot-toast';
import type { ComparendosMunicipio } from '@operaciones/shared-types';
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

const RUTA_MUNICIPIOS = `${RUTA_COMPARENDOS}/municipios`;

const NOMBRE_MAX = 80;

/**
 * El MISMO normalizador del servidor (`normalizarCodigoFuente`): NFD, fuera las marcas diacríticas,
 * recorte y mayúsculas. Escrito aquí para poder validar sobre el valor que se va a enviar de verdad
 * —«bello» son cinco caracteres y «BELLO» también, pero «Itagüí» y «ITAGUI» no son el mismo texto—.
 */
export function normalizarCodigoFuente(valor: string): string {
  return valor
    .normalize('NFD')
    // Marcas combinantes que deja sueltas el NFD, escritas como escape: en literal son caracteres
    // invisibles que cualquier editor puede comerse sin que nadie lo note.
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toUpperCase();
}

function validarCodigo(escrito: string): string | null {
  const codigo = normalizarCodigoFuente(escrito);
  if (!codigo) return 'Escribe el código de fuente.';
  if (codigo.length < 2 || codigo.length > 40) return 'El código de fuente debe tener entre 2 y 40 caracteres.';
  // El alfabeto se cierra aquí por el mismo motivo que en el servidor: este valor se interpola en la
  // URL que sale hacia UTS, y un «BELLO&token=» guardado hoy es inyección de parámetros mañana.
  if (!/^[A-Z0-9 _-]+$/.test(codigo)) {
    return 'El código de fuente admite letras, dígitos, espacio, guion y guion bajo.';
  }
  return null;
}

/** Copy propio por `codigo`/estado; el texto del servidor no se pinta (postura de la #11559). */
function mensajeDeAlta(e: unknown): string {
  if (codigoDeError(e) === 'municipio_duplicado') return 'Ese código de fuente ya está en el catálogo.';
  // `POST /municipios` no tiene limitador propio, pero le aplica el global de `/api`: sin esta rama,
  // un 429 caería en el genérico «vuelve a intentarlo» y el operador reintentaría contra la pared.
  if (e instanceof ApiError && e.status === 429) {
    return 'Se hicieron muchas peticiones en el último minuto. Espera un minuto y vuelve a intentarlo.';
  }
  if (e instanceof ApiError && e.status === 400) return 'Revisa el código y el nombre antes de guardar.';
  return 'No se pudo agregar el municipio. Vuelve a intentarlo.';
}

/** Orden de `GET /municipios`: ascendente por nombre. Se replica al insertar. */
const porNombre = (a: ComparendosMunicipio, b: ComparendosMunicipio) => a.nombre.localeCompare(b.nombre, 'es');

export default function MunicipiosComparendos() {
  const { items, estado, setItems, recargar } = useCatalogoConfig<ComparendosMunicipio>(RUTA_MUNICIPIOS);
  const [alta, setAlta] = useState(false);
  const [editando, setEditando] = useState<ComparendosMunicipio | null>(null);

  const reemplazar = (fila: ComparendosMunicipio) => setItems(
    (previos) => previos.map((m) => (m.id === fila.id ? fila : m)).sort(porNombre),
  );

  const cambiarActivo = async (fila: ComparendosMunicipio, activo: boolean) => {
    try {
      const actualizado = await api.patch<ComparendosMunicipio>(`${RUTA_MUNICIPIOS}/${fila.id}`, { activo });
      reemplazar(actualizado);
      toast.success(activo ? 'Municipio activado.' : 'Municipio desactivado.');
    } catch {
      toast.error(activo ? 'No se pudo activar el municipio.' : 'No se pudo desactivar el municipio.');
    }
  };

  return (
    <>
      <BloqueConfig
        titulo="Municipios fuente"
        descripcion={
          'El código es el que viaja literal a la consulta municipal —en mayúsculas y sin tildes— y '
          + 'el nombre es el que se ve en el visor. Desactivar un municipio deja de consultarlo; no '
          + 'borra los comparendos que ya trajo.'
        }
        accion={(
          <button type="button" className={flitBtnPrimary} style={flitBtnPrimaryStyle} onClick={() => setAlta(true)}>
            Agregar municipio
          </button>
        )}
        estado={estado}
        hayItems={items.length > 0}
        textoError="No se pudieron cargar los municipios fuente. Vuelve a intentarlo."
        etiquetaCarga="Cargando municipios fuente"
        onReintentar={recargar}
        vacio={(
          <p style={{ color: 'var(--flit-text-secondary)' }}>
            No hay municipios configurados. Sin municipios activos solo se consulta SIMIT (si el
            token está listo).
          </p>
        )}
      >
        <FlitTable>
          <caption className="sr-only">
            Municipios fuente. El código es el que se envía a la consulta municipal; los inactivos
            dejan de consultarse pero conservan los comparendos que ya trajeron.
          </caption>
          <thead>
            <FlitTr>
              <FlitTh>Código fuente</FlitTh>
              <FlitTh>Nombre</FlitTh>
              <FlitTh>Estado</FlitTh>
              <FlitTh>Acciones</FlitTh>
            </FlitTr>
          </thead>
          <tbody>
            {items.map((m) => (
              <FlitTr key={m.id}>
                <td className="px-4 py-2.5 text-sm font-medium" style={{ color: 'var(--flit-text-primary)' }}>
                  {m.codigoFuente}
                </td>
                <td className="px-4 py-2.5 text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
                  {m.nombre}
                </td>
                <td className="px-4 py-2.5"><ChipEstadoConfig activo={m.activo} /></td>
                <td className="px-4 py-2.5">
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      className={flitBtnSecondarySm}
                      style={flitBtnSecondaryStyle}
                      aria-label={`Editar nombre del municipio ${m.codigoFuente}`}
                      onClick={() => setEditando(m)}
                    >
                      Editar nombre
                    </button>
                    {m.activo ? (
                      <button
                        type="button"
                        className={flitBtnSecondarySm}
                        style={flitBtnSecondaryStyle}
                        aria-label={`Desactivar el municipio ${m.codigoFuente}`}
                        onClick={() => { void cambiarActivo(m, false); }}
                      >
                        Desactivar
                      </button>
                    ) : (
                      <button
                        type="button"
                        className={flitBtnSecondarySm}
                        style={flitBtnSecondaryStyle}
                        aria-label={`Activar el municipio ${m.codigoFuente}`}
                        onClick={() => { void cambiarActivo(m, true); }}
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
        <ModalMunicipio
          onCerrar={() => setAlta(false)}
          onCreado={(nuevo) => {
            setItems((previos) => [...previos, nuevo].sort(porNombre));
            setAlta(false);
            toast.success('Municipio agregado.');
          }}
        />
      )}

      {editando && (
        <ModalNombreMunicipio
          fila={editando}
          onCerrar={() => setEditando(null)}
          onGuardado={(actualizado) => {
            reemplazar(actualizado);
            setEditando(null);
            toast.success('Municipio actualizado.');
          }}
        />
      )}
    </>
  );
}

// ───────────────────────────────────────── Modales ──────────────────────────────────────────────

function ModalMunicipio(
  { onCerrar, onCreado }: { onCerrar: () => void; onCreado: (m: ComparendosMunicipio) => void },
) {
  const [codigo, setCodigo] = useState('');
  const [nombre, setNombre] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  const guardar = async (e: FormEvent) => {
    e.preventDefault();
    const problema = validarCodigo(codigo);
    if (problema) { setError(problema); return; }
    setError(null);
    setOcupado(true);
    try {
      // Igual que con el NIT: se normaliza AL ENVIAR y el campo no se reescribe mientras se teclea.
      const cuerpo: Record<string, string> = { codigoFuente: normalizarCodigoFuente(codigo) };
      if (nombre.trim()) cuerpo.nombre = nombre.trim();
      onCreado(await api.post<ComparendosMunicipio>(RUTA_MUNICIPIOS, cuerpo));
    } catch (err) {
      setError(mensajeDeAlta(err));
      setOcupado(false);
    }
  };

  return (
    <FlitModal title="Agregar municipio" onClose={onCerrar}>
      <form className="space-y-4" onSubmit={guardar}>
        <FlitField label="Código de fuente *">
          <input
            className={flitInp}
            value={codigo}
            onChange={(e) => setCodigo(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            required
          />
        </FlitField>
        <p className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
          Se guarda en mayúsculas y sin tildes, tal y como lo espera la consulta municipal. No se
          puede cambiar después: si te equivocas, se desactiva y se agrega el correcto.
        </p>
        <FlitField label="Nombre">
          <input
            className={flitInp}
            value={nombre}
            onChange={(e) => setNombre(e.target.value)}
            autoComplete="off"
            maxLength={NOMBRE_MAX}
          />
        </FlitField>
        <p className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
          Opcional: es el nombre que se ve en el visor. Sin nombre se usa el propio código.
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

function ModalNombreMunicipio(
  { fila, onCerrar, onGuardado }:
  { fila: ComparendosMunicipio; onCerrar: () => void; onGuardado: (m: ComparendosMunicipio) => void },
) {
  const [nombre, setNombre] = useState(fila.nombre);
  const [error, setError] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  const guardar = async (e: FormEvent) => {
    e.preventDefault();
    // El nombre es NOT NULL en la base: vaciarlo no es «quitarlo», es un 400. Se dice antes de
    // gastar la petición.
    if (!nombre.trim()) { setError('El nombre no puede quedar vacío.'); return; }
    setError(null);
    setOcupado(true);
    try {
      onGuardado(await api.patch<ComparendosMunicipio>(`${RUTA_MUNICIPIOS}/${fila.id}`, { nombre: nombre.trim() }));
    } catch {
      setError('No se pudo guardar el nombre. Vuelve a intentarlo.');
      setOcupado(false);
    }
  };

  return (
    <FlitModal title={`Editar nombre · ${fila.codigoFuente}`} onClose={onCerrar}>
      <form className="space-y-4" onSubmit={guardar}>
        <FlitField label="Nombre">
          <input
            className={flitInp}
            value={nombre}
            onChange={(e) => setNombre(e.target.value)}
            autoComplete="off"
            maxLength={NOMBRE_MAX}
            required
          />
        </FlitField>
        <p className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
          Solo cambia lo que se ve en pantalla. El código de fuente sigue siendo {fila.codigoFuente}.
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
