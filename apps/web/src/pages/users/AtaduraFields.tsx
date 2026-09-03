// FLITO — el ÁMBITO del usuario por rol: su proveedor SOAT (uno) y sus organismos de tránsito
// (varios). HU #12053 / Feature #12052.
//
// Especificación que manda sobre este archivo, literal por literal:
// `docs/ux/usuarios-ambito-proveedor-y-gestor-impuestos.md`.
//
// **Esto NO es kit.** No vive en `components/flit/`, no se anuncia como reutilizable y solo lo
// importa `pages/Users.tsx`. La decisión 2 de UX descartó un `FlitMultiSelect` en el kit con un
// único consumidor —se promueve cuando aparezca el segundo—, y descartó `ThFiltroMulti` porque su
// panel `absolute z-20` está pensado para un `<th>` y se recorta dentro del `overflow-y-auto` de
// `FlitModal`. Lo que sí se calca es el LENGUAJE VISUAL de `PermissionsPicker`, que vive en este
// mismo modal y para este mismo público.
//
// Vive en su propio archivo y no dentro de `Users.tsx` por una razón medida: la página estaba en
// 551 sloc de un techo de 800 que ESLint marca como `error` y bloquea CI, y dos campos con sus
// cuatro estados cada uno no caben con margen.

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { getOrganismoByCodigo } from '@operaciones/shared-types';
import { api, errorMessage } from '../../lib/api';
import FlitSelect from '../../components/flit/FlitSelect';

// ─────────────────────────────── Copy exacto (UX §5.1 a §5.4) ────────────────────────────────────

export const PROVEEDOR_LABEL = 'Proveedor SOAT';
const PROVEEDOR_VACIA = 'Seleccione proveedor…';
const PROVEEDOR_AYUDA = 'Define qué cola de SOAT ve este usuario: solo los trámites de ese proveedor.';
const PROVEEDOR_CARGANDO = 'Cargando proveedores SOAT…';
const PROVEEDOR_ERROR = 'No se pudieron cargar los proveedores SOAT.';
const PROVEEDOR_VACIO = 'No hay proveedores SOAT activos. Crea uno en Clientes y proveedores antes de crear un usuario Proveedor.';
const PROVEEDOR_REINTENTO = 'Volver a cargar proveedores';
export const PROVEEDOR_REQUERIDO = 'Selecciona el proveedor SOAT del usuario Proveedor.';
export const PROVEEDOR_RELOGIN = 'El usuario debe volver a iniciar sesión para aplicar el nuevo proveedor.';

export const ORGANISMOS_LABEL = 'Organismos de tránsito';
const ORGANISMOS_AYUDA = 'Define qué impuestos ve este usuario: solo los de los organismos marcados.';
const ORGANISMOS_CARGANDO = 'Cargando organismos…';
const ORGANISMOS_ERROR = 'No se pudieron cargar los organismos.';
const ORGANISMOS_VACIO = 'No hay organismos parametrizados. Parametriza uno en Organismos STT antes de crear un usuario Gestor de Impuestos.';
const ORGANISMOS_REINTENTO = 'Volver a cargar organismos';
export const ORGANISMOS_REQUERIDO = 'Marca al menos un organismo para el usuario Gestor de Impuestos.';
export const ORGANISMOS_RELOGIN = 'El usuario debe volver a iniciar sesión para aplicar los nuevos organismos.';

/** Solo en `EditForm`: en el alta sería falsa, porque no hay sesión que cerrar (UX §5.4). */
const AVISO_RELOGIN = 'Al guardar, este usuario deberá volver a iniciar sesión.';

// ───────────────────────────────────── Catálogos ─────────────────────────────────────────────────

/** Lo que los campos necesitan de `GET /flito/parametrizacion/proveedores-soat`. Nada más. */
export interface ProveedorSoat { id: string; nombre: string; activo: boolean }
/** Lo que los campos necesitan de `GET /flito/parametrizacion/organismos`. Nada más. */
export interface OrganismoParametrizado { codigo: string; alias: string | null; activo: boolean }

/**
 * Los dos catálogos se piden UNA vez por página —no por formulario—, igual que el de compañías, y
 * los comparten el selector y la celda «Ámbito» de la tabla.
 *
 * Los cuatro estados se derivan de aquí sin un booleano extra: `data === null && !error` es
 * cargando, `error` es fallo, `data` vacío es vacío, y `data` con filas es lleno.
 */
function useCatalogo<T>(ruta: string, mapear: (fila: any) => T) {
  const [data, setData] = useState<T[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recarga, setRecarga] = useState(0);

  useEffect(() => {
    let vivo = true;
    setData(null); setError(null);
    api.get<any[]>(ruta)
      .then((filas) => { if (vivo) setData(filas.map(mapear)); })
      .catch((e) => { if (vivo) setError(errorMessage(e)); });
    return () => { vivo = false; };
    // `mapear` es una constante de módulo; la ruta no cambia. La recarga es la única entrada.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ruta, recarga]);

  return { data, error, recargar: () => setRecarga((n) => n + 1) };
}

const aProveedor = (p: any): ProveedorSoat => ({ id: String(p.id), nombre: p.nombre, activo: !!p.activo });
const aOrganismo = (o: any): OrganismoParametrizado => ({ codigo: String(o.codigo), alias: o.alias ?? null, activo: !!o.activo });

/**
 * Catálogo de proveedores SOAT. **Del endpoint de parametrización**, que es el que trae `activo` y
 * el que el `admin` ya puede leer hoy. Devuelve activos e inactivos: filtrar al OFRECER es trabajo
 * de la UI (decisión 9 de UX), no del servidor.
 */
export function useProveedoresSoat() {
  return useCatalogo<ProveedorSoat>('/flito/parametrizacion/proveedores-soat', aProveedor);
}

/**
 * Catálogo de organismos PARAMETRIZADOS (filas de `organismos_transito_config`).
 *
 * No es `GET /tramites/organismos-config` ni `FlitOrganismoCombobox`: los dos sirven el catálogo
 * NACIONAL de `shared-types`, y el AC2 pide el parametrizado. Se puebla del catálogo y **nunca** de
 * las facetas de la cola: un organismo sin impuestos pendientes se lista igual, porque atar a un
 * gestor a una secretaría que hoy no tiene recibos es cómo se prepara la operación de mañana.
 */
export function useOrganismosParametrizados() {
  return useCatalogo<OrganismoParametrizado>('/flito/parametrizacion/organismos', aOrganismo);
}

export type CatalogoProveedores = ReturnType<typeof useProveedoresSoat>;
export type CatalogoOrganismos = ReturnType<typeof useOrganismosParametrizados>;

// ─────────────────────────── Nombres: los mismos en el campo y en la tabla ───────────────────────

/**
 * Nombre del organismo, por este orden: `alias` de la parametrización → `ciudad` del catálogo
 * nacional → el código. El primero es el que el propio admin escribió en «Organismos STT»; el
 * segundo es el que ya usa la columna de tránsito de esta misma tabla.
 */
export function nombreOrganismo(data: OrganismoParametrizado[] | null, codigo: string): string {
  const org = data?.find((o) => o.codigo === codigo);
  return org?.alias ?? getOrganismoByCodigo(codigo)?.ciudad ?? codigo;
}

/** Nombre del proveedor, o `null` si el catálogo no cargó o el id ya no está en él. */
export function nombreProveedor(data: ProveedorSoat[] | null, id: string): string | null {
  return data?.find((p) => p.id === id)?.nombre ?? null;
}

/**
 * Etiquetas de los organismos de un gestor, **en el orden del catálogo** y no en el de inserción:
 * una fila cuyo texto cambia según en qué orden se marcaron las casillas no se puede afirmar en un
 * test. Los códigos que no estén en el catálogo van al final, con su propio código por texto.
 */
export function etiquetasOrganismos(data: OrganismoParametrizado[] | null, codigos: string[]): string[] {
  const pedidos = new Set(codigos);
  const enCatalogo = (data ?? []).filter((o) => pedidos.has(o.codigo));
  const sueltos = codigos.filter((c) => !enCatalogo.some((o) => o.codigo === c));
  return [...enCatalogo.map((o) => nombreOrganismo(data, o.codigo)), ...sueltos];
}

/**
 * «Medellín» · «Medellín, Envigado» · «Medellín, Envigado y 3 más» (AC5).
 *
 * El corte en dos no es estético: con siete columnas, dos alias son lo que cabe sin que la celda
 * empuje a las demás. Y «y 3 más» se lee en voz alta y significa algo, a diferencia de un `+3`.
 */
export function resumenOrganismos(etiquetas: string[]): string {
  if (etiquetas.length <= 2) return etiquetas.join(', ');
  return `${etiquetas[0]}, ${etiquetas[1]} y ${etiquetas.length - 2} más`;
}

// ─────────────────────────────── Campo 1 · Proveedor SOAT ────────────────────────────────────────

/**
 * El widget es `FlitSelect` **tal cual, sin ningún prop nuevo**: son ~4 aseguradoras, muy por
 * debajo del umbral (~40 opciones) donde un `<select>` nativo deja de leerse, y el kit ya trae
 * `<label for>`, región `role="status"` montada siempre, `aria-describedby`, `required` nativo,
 * `error`/`onInvalido` con foco al control y `onReintentar`. Esta HU no toca el kit.
 *
 * Lo que el molde de `CompaniaField` no resolvía y se añade aquí: **el proveedor desactivado**. Se
 * ofrecen los activos MÁS el asignado actual si no está entre ellos, con el matiz «(inactivo)» que
 * `FlitSelect` ya sabe pintar. Filtrar por `activo` a secas dejaría el `<select>` en blanco y
 * guardar cualquier otro campo se llevaría la atadura por delante, sin que el admin lo pidiera.
 */
export function ProveedorSoatField({ proveedores, value, onChange, error, onInvalido, editando }: {
  proveedores: CatalogoProveedores;
  value: string;
  onChange: (v: string) => void;
  error: string | null;
  onInvalido: () => void;
  editando?: boolean;
}) {
  const { data, error: errorCarga, recargar } = proveedores;
  const cargando = data === null && !errorCarga;

  const ofrecidos = useMemo(() => {
    if (!data) return [];
    const activos = data.filter((p) => p.activo);
    const asignado = value ? data.find((p) => p.id === value) : undefined;
    return asignado && !asignado.activo ? [...activos, asignado] : activos;
  }, [data, value]);

  const vacio = data !== null && ofrecidos.length === 0;
  const mensaje = errorCarga ? PROVEEDOR_ERROR : cargando ? PROVEEDOR_CARGANDO : vacio ? PROVEEDOR_VACIO : null;

  return (
    <FlitSelect
      label={PROVEEDOR_LABEL}
      value={value}
      onChange={onChange}
      opciones={[
        { valor: '', etiqueta: PROVEEDOR_VACIA },
        ...ofrecidos.map((p) => ({ valor: p.id, etiqueta: p.nombre, ...(p.activo ? {} : { nota: 'inactivo' }) })),
      ]}
      ayuda={editando ? `${PROVEEDOR_AYUDA} ${AVISO_RELOGIN}` : PROVEEDOR_AYUDA}
      mensaje={mensaje}
      fallo={!!errorCarga}
      disabled={cargando || vacio || !!errorCarga}
      // Solo el error de carga se reintenta. En vacío NO se ofrece: volver a pedir el catálogo no
      // crea proveedores, y un botón que no arregla nada es peor que ninguno.
      onReintentar={errorCarga ? recargar : undefined}
      textoReintento={PROVEEDOR_REINTENTO}
      required
      error={error}
      onInvalido={onInvalido}
    />
  );
}

// ────────────────────────── Campo 2 · Organismos de tránsito (varios) ────────────────────────────

/**
 * Lista de casillas en un `<fieldset>`, con el lenguaje visual de `PermissionsPicker`. Una sola
 * columna —los alias son largos y en 448 px una rejilla de dos parte los nombres—, `max-h-48`, y
 * sin «Quitar todos»: el campo es obligatorio y un botón que lleva a un estado inválido no ayuda.
 *
 * Accesibilidad (UX §«Accesibilidad»): `<legend>` como nombre accesible del grupo —no un `<div>`
 * con `aria-label`—, casillas nativas dentro de su `<label>` envolvente, **sin `aria-live`** en la
 * lista ni en el contador (el rol de la casilla ya anuncia el cambio, y dos regiones lo leerían dos
 * veces), `aria-describedby` al estado del catálogo y, cuando lo hay, al error, `aria-invalid` en
 * el `<fieldset>` y el foco a la primera casilla al rechazar. Ningún `keydown` propio ni
 * `tabIndex` manipulado: Tab recorre las casillas y Espacio marca, que es lo nativo.
 */
export function OrganismosField({ organismos, seleccionados, onChange, error, editando }: {
  organismos: CatalogoOrganismos;
  seleccionados: string[];
  onChange: (codigos: string[]) => void;
  error: string | null;
  editando?: boolean;
}) {
  const { data, error: errorCarga, recargar } = organismos;
  const id = useId();
  const idMensaje = `${id}-mensaje`;
  const idError = `${id}-error`;
  const refCaja = useRef<HTMLDivElement>(null);

  // Los marcados AL ABRIR, congelados. Son dos cosas a la vez: el criterio de orden (marcados
  // primero) y la reinyección del inactivo asignado. Se fija una sola vez y NO se recalcula al
  // marcar o desmarcar — si se recalculara, la fila que acabas de tocar se movería bajo el cursor,
  // que es el error clásico de este patrón.
  const marcadosAlAbrir = useRef(new Set(seleccionados));

  const lista = useMemo(() => {
    if (!data) return [];
    const visibles = data.filter((o) => o.activo || marcadosAlAbrir.current.has(o.codigo));
    return visibles
      .map((o) => ({ ...o, etiqueta: nombreOrganismo(data, o.codigo) }))
      .sort((a, b) => {
        const ma = marcadosAlAbrir.current.has(a.codigo) ? 0 : 1;
        const mb = marcadosAlAbrir.current.has(b.codigo) ? 0 : 1;
        return ma !== mb ? ma - mb : a.etiqueta.localeCompare(b.etiqueta, 'es');
      });
  }, [data]);

  const cargando = data === null && !errorCarga;
  const vacio = data !== null && lista.length === 0;
  const mensaje = errorCarga ? ORGANISMOS_ERROR : cargando ? ORGANISMOS_CARGANDO : vacio ? ORGANISMOS_VACIO : null;
  const ayuda: ReactNode = editando ? `${ORGANISMOS_AYUDA} ${AVISO_RELOGIN}` : ORGANISMOS_AYUDA;

  // El foco va a la PRIMERA casilla en cuanto aparece el error, que es donde se corrige. Depende
  // del texto y no de un booleano, igual que en `FlitSelect`.
  useEffect(() => { if (error) refCaja.current?.querySelector('input')?.focus(); }, [error]);

  const alternar = (codigo: string) => {
    const next = new Set(seleccionados);
    if (next.has(codigo)) next.delete(codigo); else next.add(codigo);
    // Se reordena por la lista para que lo que viaja no dependa de en qué orden se hizo clic, pero
    // lo que ya estaba marcado y NO se pinta —un código que el catálogo no trae— se conserva: si se
    // cayera aquí, tocar otra casilla borraría una atadura que el admin no tocó.
    const enLista = lista.filter((o) => next.has(o.codigo)).map((o) => o.codigo);
    const fuera = seleccionados.filter((c) => next.has(c) && !enLista.includes(c));
    onChange([...enLista, ...fuera]);
  };

  const marcados = seleccionados.length;

  return (
    <fieldset
      className="relative"
      aria-invalid={error ? true : undefined}
      aria-describedby={error ? `${idMensaje} ${idError}` : idMensaje}
    >
      {/* `<legend>` como PRIMER hijo y con solo su texto: es el nombre accesible del grupo, y meter
          el contador dentro lo cambiaría en cada clic. El contador va al lado, posicionado sobre la
          propia caja del campo —no es un panel que pueda recortarse contra el borde del modal. */}
      <legend className="mb-1.5 block text-xs font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
        {ORGANISMOS_LABEL}
      </legend>
      {marcados > 0 && (
        <span className="absolute right-0 top-0 text-[10px]" style={{ color: 'var(--flit-text-muted)' }}>
          {marcados === 1 ? '1 marcado' : `${marcados} marcados`}
        </span>
      )}

      {/* En cargando / error / vacío NO se pinta la caja: una caja vacía es un rectángulo
          decorativo que no dice cuál de los tres estados es. */}
      {lista.length > 0 && (
        <div
          ref={refCaja}
          className="max-h-48 space-y-1 overflow-y-auto rounded-xl bg-white p-3"
          style={{ border: '1px solid var(--flit-border-soft)' }}
        >
          {lista.map((o) => {
            const marcado = seleccionados.includes(o.codigo);
            return (
              <label
                key={o.codigo}
                className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1 text-xs hover:bg-[color:var(--flit-bg-app)]"
                style={marcado
                  ? { color: 'var(--flit-blue)', background: 'rgba(79,116,201,0.12)' }
                  : { color: 'var(--flit-text-secondary)' }}
              >
                <input
                  type="checkbox"
                  checked={marcado}
                  onChange={() => alternar(o.codigo)}
                  className="flit-focus rounded"
                  style={{ accentColor: 'var(--flit-blue)' }}
                />
                {/* El código va detrás SIEMPRE: dos municipios pueden llamarse igual y el DIVIPOLA
                    es lo que desempata. El matiz «(inactivo)» va en el texto, no en un color. */}
                <span className="flex-1">
                  {o.etiqueta} · {o.codigo}{o.activo ? '' : ' (inactivo)'}
                </span>
              </label>
            );
          })}
        </div>
      )}

      {/* La región del mensaje se monta SIEMPRE y solo cambia su texto: una `role="status"` que
          aparece ya rellena no dispara anuncio en varios lectores. El botón queda fuera, para que
          no se reanuncie entero con cada cambio. */}
      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
        <span
          id={idMensaje}
          role="status"
          style={{ color: mensaje && errorCarga ? 'var(--flit-danger-ink)' : 'var(--flit-text-secondary)' }}
        >
          {mensaje ?? ayuda}
        </span>
        {/* Sin caja no hay nada enfocable: el reintento es la única parada de tabulador del
            callejón. En vacío no se ofrece —recargar no parametriza organismos. */}
        {mensaje && errorCarga && (
          <button
            type="button"
            onClick={recargar}
            className="flit-focus rounded-[999px] border bg-flit-card px-2 py-0.5 text-xs font-medium"
            style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-secondary)' }}
          >
            {ORGANISMOS_REINTENTO}
          </button>
        )}
      </div>

      {error && (
        <p id={idError} role="alert" className="mt-1 text-xs" style={{ color: 'var(--flit-danger-ink)' }}>
          {error}
        </p>
      )}
    </fieldset>
  );
}
