// FLITO — la compañía del usuario `cliente`: catálogo y selector. Feature #11912.
// Extraído de `pages/Users.tsx` sin cambios. HU #12175 / Feature #12072.
//
// **Esto NO es kit.** Mismo criterio que `AtaduraFields.tsx`: el hook del catálogo y el campo que
// lo consume viven juntos, en su propio archivo, y solo los importan la página de usuarios y el
// bloque de ámbito.

import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import FlitSelect from '../../components/flit/FlitSelect';
import { formatErrors } from './UserFormShared';

/** Lo que el selector necesita de `GET /flito/parametrizacion/companias`. Nada más. */
interface Compania { id: number; nombre: string }

// ── Copy del selector de compañía (docs/ux/identidad-rol-cliente-y-soat-sin-tramite.md §1.4) ──
const COMPANIA_AYUDA = 'Define de qué compañía es este usuario: solo verá y solicitará el SOAT de esa compañía.';
const COMPANIA_CARGANDO = 'Cargando compañías…';
const COMPANIA_ERROR = 'No se pudieron cargar las compañías.';
const COMPANIA_VACIO = 'No hay compañías registradas. Crea una en Clientes y proveedores antes de crear un usuario Cliente.';
export const COMPANIA_REQUERIDA = 'Selecciona la compañía del usuario Cliente.';
export const COMPANIA_RELOGIN = 'El usuario debe volver a iniciar sesión para aplicar la nueva compañía.';

/**
 * Catálogo de compañías para el selector del rol Cliente y para la celda «Organismo / Compañía».
 *
 * Se pide UNA vez por página —no por formulario— y de
 * `GET /flito/parametrizacion/companias`, que entrega `{id, nombre, nit, banderas}`. **No** de
 * `GET /clients`, que devuelve 26 columnas con teléfono, correo y dirección de cada compañía: para
 * pintar un desplegable de nombres eso es PII que no hace falta pedir.
 *
 * Los cuatro estados los consume `CompaniaField`: `data === null && !error` es cargando.
 */
export function useCompanias() {
  const [data, setData] = useState<Compania[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recarga, setRecarga] = useState(0);

  useEffect(() => {
    let vivo = true;
    setData(null); setError(null);
    api.get<Compania[]>('/flito/parametrizacion/companias')
      .then((filas) => { if (vivo) setData(filas.map((c) => ({ id: c.id, nombre: c.nombre }))); })
      .catch((e) => { if (vivo) setError(formatErrors(e)); });
    return () => { vivo = false; };
  }, [recarga]);

  return { data, error, recargar: () => setRecarga((n) => n + 1) };
}

export type CatalogoCompanias = ReturnType<typeof useCompanias>;

/**
 * Compañía del usuario Cliente. **Sus 4 estados están aquí**, no en la página: es la única
 * superficie con datos que esta HU añade.
 *
 * El widget es `FlitSelect` y no un combobox: hay 4 compañías en la base, muy por debajo del umbral
 * (~40 opciones) a partir del cual un `<select>` nativo deja de leerse. Del patrón `transitoCodigo`
 * se calca el MECANISMO —campo condicionado al rol, reset al cambiar de rol, borrado al salir del
 * rol, validación en los dos sentidos e invalidación de sesión—, no el desplegable.
 *
 * El botón de reintento del estado de error no es opcional: un `<select disabled>` no recibe foco,
 * así que su `aria-describedby` es inalcanzable por teclado y el botón es la única salida.
 */
export function CompaniaField({ companias, value, onChange, error, onInvalido }: {
  companias: CatalogoCompanias;
  value: string;
  onChange: (v: string) => void;
  error: string | null;
  onInvalido: () => void;
}) {
  const { data, error: errorCarga, recargar } = companias;
  const cargando = data === null && !errorCarga;
  const vacio = data !== null && data.length === 0;
  const mensaje = errorCarga ? COMPANIA_ERROR : cargando ? COMPANIA_CARGANDO : vacio ? COMPANIA_VACIO : null;

  return (
    <FlitSelect
      label="Compañía"
      value={value}
      onChange={onChange}
      opciones={[
        { valor: '', etiqueta: 'Seleccione compañía…' },
        ...(data ?? []).map((c) => ({ valor: String(c.id), etiqueta: c.nombre })),
      ]}
      ayuda={COMPANIA_AYUDA}
      mensaje={mensaje}
      fallo={!!errorCarga}
      disabled={cargando || vacio || !!errorCarga}
      // Solo el error de carga se reintenta. En vacío NO se ofrece: volver a pedir el catálogo no
      // crea compañías, y un botón que no arregla nada es peor que ninguno.
      onReintentar={errorCarga ? recargar : undefined}
      textoReintento="Volver a cargar compañías"
      required
      error={error}
      onInvalido={onInvalido}
    />
  );
}
