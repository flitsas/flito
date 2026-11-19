// FLITO — «Permisos de este usuario»: excepciones por usuario sobre el árbol del rol (HU #12087 →
// HU #13430, Feature #13416, AC4).
//
// Mismo árbol que Roles y permisos, en modo usuario: la casilla muestra lo que el usuario TENDRÁ
// (`(rol ∪ añadidos) \ quitados`) y la etiqueta dice de dónde sale (Del rol / Añadido / Quitado /
// Añadido · sin efecto). P-25: la cadena del rol manda, así que un «Añadido» bajo un ancestro que el
// usuario no tiene es «sin efecto» y nombra el ancestro que le falta (delta §5).
//
// Datos: con el rol que el usuario ya tiene, `GET /users/:id/arbol` (guarda del módulo `usuarios`;
// `heredado` = lo marca su rol). Al crear o al cambiar el rol en el formulario, `GET
// /permisos/roles/:codigo/arbol` del rol elegido. Las excepciones viven en el formulario (`excepciones`)
// y viajan en el `PATCH /users/:id` como hasta ahora.
//
// HU #13970: las funciones exclusivas del Administrador (`exclusivaAdmin`) no admiten excepción. Con un
// rol que no es el Administrador se ven desmarcadas y bloqueadas; con el Administrador, concedidas por
// el rol y bloqueadas. Una excepción heredada sobre una exclusiva no se pinta ni se reenvía.
//
// **Esto NO es kit.** Consumidores: los formularios de alta y de edición de usuario.

import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import type { FuncionDeUsuario } from '@operaciones/shared-types';
import { permisosApi, type GrupoDeFunciones } from '../../lib/api';
import { flitBtnSecondarySm, flitBtnSecondaryStyle } from '../../components/flit/flitPageKit';
import ArbolPermisos, { type FocoArbol } from '../roles-permisos/ArbolPermisos';
import {
  alternarExcepcion, conExclusivas, indexar, marcadosDelApi, marcadosDelUsuario, normalizar, resumenExcepciones, resumenUsuario,
  sinExclusivas, tratoExclusivasDe, type Efecto, type Indice, type Nodo,
} from '../roles-permisos/arbol';

/** Catálogo plano de funciones (una vez por página): ya no pinta el bloque; lo usa `CambioRolExcepciones` para los nombres. */
export type CatalogoFuncionesEstado = {
  grupos: GrupoDeFunciones[] | null;
  error: string | null;
  recargar: () => void;
};

export const COPY_ERROR_PERMISOS =
  'No se pudieron cargar los permisos del rol. Puedes guardar los demás datos del usuario; sus permisos quedarán como estaban.';
const vacioDelRol = (rol: string) => `El rol ${rol} no trae nada marcado. Marca aquí lo que este usuario deba tener, o asígnale otro rol.`;

interface Datos { arbol: Nodo[]; rol: Set<string>; rolNombre: string }

/** Lo que el API marca como heredado del rol (modo usuario). */
function heredados(nodos: readonly { codigo: string; heredado?: boolean; hijos?: readonly unknown[] }[]): string[] {
  return nodos.flatMap((n) => [
    ...(n.heredado ? [n.codigo] : []),
    ...heredados((n.hijos ?? []) as readonly { codigo: string; heredado?: boolean; hijos?: readonly unknown[] }[]),
  ]);
}

async function pedir(role: string, userId: number | undefined, rolOriginal: string | undefined): Promise<Datos> {
  if (userId !== undefined && role === rolOriginal) {
    const r = await permisosApi.arbolDelUsuario(userId);
    return {
      arbol: normalizar(r.arbol), rol: new Set(heredados(r.arbol)), rolNombre: '',
    };
  }
  const r = await permisosApi.arbolDelRol(role);
  return {
    arbol: normalizar(r.arbol), rol: new Set(marcadosDelApi(r.arbol)), rolNombre: r.rol.nombre,
  };
}

export default function PermissionsPicker({
  role, rolNombre, userId, rolOriginal, quien, excepciones, onChange, onDisponibleChange, foco, onIndice,
}: {
  /** Código del rol elegido en el formulario. */
  role: string;
  /** Nombre visible del rol (del catálogo de roles del formulario); si falta, el del API o el código. */
  rolNombre?: string;
  /** Edición: el usuario y el rol que tiene guardado (para leer su árbol con la guarda de `usuarios`). */
  userId?: number;
  rolOriginal?: string;
  /** Para los textos de lector de pantalla («· usuario …»). Nunca va a la URL ni a la consola. */
  quien: string;
  excepciones: FuncionDeUsuario[];
  onChange: (next: FuncionDeUsuario[]) => void;
  /** `false` si el árbol falló: el form guarda sin tocar `funciones`. */
  onDisponibleChange?: (ok: boolean) => void;
  /** «Mostrar dónde está» del aviso 409 del modal. */
  foco?: FocoArbol | null;
  /** El índice del árbol cargado, para nombrar el nodo del 409. */
  onIndice?: (indice: Indice) => void;
}) {
  const [datos, setDatos] = useState<Datos | null>(null);
  const [estado, setEstado] = useState<'cargando' | 'error' | 'ok'>('cargando');
  const [intento, setIntento] = useState(0);
  const idTitulo = useId();

  useEffect(() => {
    let vivo = true;
    setEstado('cargando');
    pedir(role, userId, rolOriginal)
      .then((d) => { if (vivo) { setDatos(d); setEstado('ok'); } })
      .catch(() => { if (vivo) { setDatos(null); setEstado('error'); } });
    return () => { vivo = false; };
  }, [role, userId, rolOriginal, intento]);

  useEffect(() => { onDisponibleChange?.(estado === 'ok'); }, [estado, onDisponibleChange]);

  const indice = useMemo(() => indexar(datos?.arbol ?? []), [datos]);
  useEffect(() => { if (datos) onIndice?.(indice); }, [datos, indice, onIndice]);

  const trato = tratoExclusivasDe(role);
  const mapa = useMemo(
    () => new Map<string, Efecto>(sinExclusivas(excepciones, indice).map((f) => [f.codigo, f.efecto])),
    [excepciones, indice],
  );
  // Lo que da el rol, con la regla de las exclusivas aplicada (todas en el Administrador, ninguna en otro).
  const rolSet = useMemo(() => (datos ? conExclusivas(datos.rol, indice, trato) : undefined), [datos, indice, trato]);
  const marcados = useMemo(() => marcadosDelUsuario(rolSet ?? new Set(), mapa), [rolSet, mapa]);
  const modo = useMemo(
    () => ({ tipo: 'usuario' as const, quien, rol: rolSet ?? new Set<string>(), excepciones: mapa }),
    [quien, rolSet, mapa],
  );
  // Al abrir, se despliegan los ancestros de cada excepción (ficha full); el resto, plegado.
  const abiertosIniciales = useMemo(
    () => (datos ? sinExclusivas(excepciones, indice).flatMap((e) => indice.ancestros.get(e.codigo) ?? []) : []),
    // Solo al cargar el árbol: desplegar en cada clic movería lo que el administrador tiene delante.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [datos, indice],
  );

  const alternar = useCallback((codigo: string) => {
    if (!rolSet || indice.porCodigo.get(codigo)?.exclusivaAdmin) return;
    const siguiente = alternarExcepcion(codigo, rolSet, mapa);
    onChange([...siguiente].map(([c, efecto]) => ({ codigo: c, efecto })));
  }, [rolSet, mapa, onChange, indice]);

  if (estado === 'cargando') {
    return (
      <div role="status" aria-busy="true" aria-label="Cargando los permisos del rol" className="rounded-xl p-3" style={{ border: '1px solid var(--flit-border-soft)' }}>
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className={i > 0 ? 'border-t py-2' : 'pb-2'} style={{ borderColor: 'var(--flit-border-soft)' }}>
            <div className="h-6 animate-pulse rounded-[10px]" style={{ background: 'var(--flit-bg-app)' }} />
          </div>
        ))}
      </div>
    );
  }

  if (estado === 'error' || !datos || !rolSet) {
    return (
      <div role="alert" className="flex flex-wrap items-start gap-3 rounded-xl p-3" style={{ border: '1px solid var(--flit-border-soft)' }}>
        <p className="min-w-0 flex-[1_1_14rem] text-sm" style={{ color: 'var(--flit-danger-ink)' }}>{COPY_ERROR_PERMISOS}</p>
        <button type="button" className={flitBtnSecondarySm} style={flitBtnSecondaryStyle} onClick={() => setIntento((n) => n + 1)}>Reintentar</button>
      </div>
    );
  }

  const nombreRol = rolNombre || datos.rolNombre || role;
  const todos = [...indice.porCodigo.keys()];
  const resumen = resumenExcepciones(todos, rolSet, mapa, indice);
  const hayExcepciones = mapa.size > 0;
  const vacio = rolSet.size === 0 && !hayExcepciones;

  return (
    <section aria-labelledby={idTitulo} className="flex flex-col gap-2">
      <h3 id={idTitulo} className="text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>Permisos de este usuario</h3>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="min-w-0 flex-[1_1_14rem] text-sm" style={{ color: 'var(--flit-text-secondary)' }} data-resumen="excepciones">
          {vacio ? vacioDelRol(nombreRol) : resumenUsuario(nombreRol, resumen)}
        </p>
        {hayExcepciones && (
          <button type="button" className={flitBtnSecondarySm} style={flitBtnSecondaryStyle} onClick={() => onChange([])}>
            Quitar las excepciones
          </button>
        )}
      </div>
      <div className="border-t pt-2" style={{ borderColor: 'var(--flit-border-soft)' }}>
        <ArbolPermisos
          key={`${role}-${intento}`}
          arbol={datos.arbol}
          indice={indice}
          marcados={marcados}
          modo={modo}
          editable
          onToggle={alternar}
          abiertosIniciales={abiertosIniciales}
          foco={foco}
          exclusivas={trato}
        />
      </div>
    </section>
  );
}
