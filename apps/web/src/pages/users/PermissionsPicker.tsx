// FLITO — selector de excepciones por usuario sobre el cuadro del rol (HU #12087 / Feature #12072).
// Cinco estados por casilla (§4-2 del diseño). Catálogo desde el padre; cuadro del rol con caché aquí.
//
// **Esto NO es kit.** Un único consumidor: los formularios de alta/edición de usuario.

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { EfectoPermisoUsuario, FuncionDeUsuario } from '@operaciones/shared-types';
import { errorMessage, permisosApi, type GrupoDeFunciones } from '../../lib/api';
import FlitAcordeon from '../../components/flit/FlitAcordeon';
import { etiquetaModulo, modulosVisibles } from '../roles-permisos/modulos';
export type CatalogoFuncionesEstado = {
  grupos: GrupoDeFunciones[] | null;
  error: string | null;
  recargar: () => void;
};

type EstadoCasilla = 'rol' | 'quitado' | 'anadido' | 'no' | 'sin_efecto';

const ETIQUETA: Record<EstadoCasilla, string> = {
  rol: 'Lo trae el rol',
  quitado: 'Quitado',
  anadido: 'Añadido',
  no: '',
  sin_efecto: 'Sin efecto',
};

const COPY_AYUDA =
  'Las funciones marcadas como "Lo trae el rol" vienen con el rol. Desmárcalas para quitárselas solo a este usuario, o marca otras para añadírselas.';
const COPY_ERROR = 'No se pudo cargar el catálogo de funciones o el cuadro del rol.';
const COPY_CARGANDO = 'Cargando funciones del rol…';

function estadoDe(enRol: boolean, efecto: EfectoPermisoUsuario | undefined): EstadoCasilla {
  if (enRol && !efecto) return 'rol';
  if (enRol && efecto === 'revocar') return 'quitado';
  if (!enRol && efecto === 'conceder') return 'anadido';
  if (!enRol && !efecto) return 'no';
  return 'sin_efecto';
}

function marcadaDe(enRol: boolean, efecto: EfectoPermisoUsuario | undefined): boolean {
  return enRol ? efecto !== 'revocar' : efecto === 'conceder';
}

/** Mapa codigo → efecto a partir del array de excepciones. */
export function mapaExcepciones(lista: FuncionDeUsuario[]): Map<string, EfectoPermisoUsuario> {
  return new Map(lista.map((f) => [f.codigo, f.efecto]));
}

export default function PermissionsPicker({
  role, catalogo, excepciones, onChange, onDisponibleChange,
}: {
  /** Código del rol en `permisos_roles` (sistema o personalizado). */
  role: string;
  catalogo: CatalogoFuncionesEstado;
  excepciones: FuncionDeUsuario[];
  onChange: (next: FuncionDeUsuario[]) => void;
  /** `false` si catálogo/cuadro fallaron: el form guarda sin tocar `funciones`. */
  onDisponibleChange?: (ok: boolean) => void;
}) {
  const cache = useRef<Map<string, string[]>>(new Map());
  const [cuadro, setCuadro] = useState<string[] | null>(null);
  const [errorCuadro, setErrorCuadro] = useState<string | null>(null);
  const [cargandoCuadro, setCargandoCuadro] = useState(false);
  const [abiertos, setAbiertos] = useState<Set<string>>(() => new Set());
  const exc = useMemo(() => mapaExcepciones(excepciones), [excepciones]);

  const cargarCuadro = useCallback(async (codigo: string) => {
    const cached = cache.current.get(codigo);
    if (cached) { setCuadro(cached); setErrorCuadro(null); return; }
    setCargandoCuadro(true);
    setErrorCuadro(null);
    try {
      const r = await permisosApi.cuadroDelRol(codigo);
      cache.current.set(codigo, r.funciones);
      setCuadro(r.funciones);
    } catch (e) {
      setCuadro(null);
      setErrorCuadro(errorMessage(e));
    } finally {
      setCargandoCuadro(false);
    }
  }, []);

  useEffect(() => { void cargarCuadro(role); }, [role, cargarCuadro]);

  const error = catalogo.error ?? errorCuadro;
  const cargando = !error && (catalogo.grupos === null || cargandoCuadro);
  const listo = !cargando && !error && catalogo.grupos !== null && cuadro !== null;

  useEffect(() => { onDisponibleChange?.(listo); }, [listo, onDisponibleChange]);

  const enRolSet = useMemo(() => new Set(cuadro ?? []), [cuadro]);
  const grupos = useMemo(
    () => (catalogo.grupos ? modulosVisibles(catalogo.grupos) : []),
    [catalogo.grupos],
  );

  const reintentar = () => {
    cache.current.delete(role);
    catalogo.recargar();
    void cargarCuadro(role);
  };

  const aplicar = (codigo: string, efecto: EfectoPermisoUsuario | null) => {
    const next = excepciones.filter((f) => f.codigo !== codigo);
    if (efecto) next.push({ codigo, efecto });
    onChange(next);
  };

  const toggle = (codigo: string) => {
    const enRol = enRolSet.has(codigo);
    const efecto = exc.get(codigo);
    const marcada = marcadaDe(enRol, efecto);
    const deseado = !marcada;
    const siguiente: EfectoPermisoUsuario | null =
      deseado === enRol ? null : (deseado ? 'conceder' : 'revocar');
    aplicar(codigo, siguiente);
  };

  const quitarAdicionales = () => {
    onChange(excepciones.filter((f) => f.efecto !== 'conceder'));
  };

  const hayConceder = excepciones.some((f) => f.efecto === 'conceder');

  if (cargando) {
    return (
      <div className="rounded-xl p-3 text-xs" style={{ border: '1px solid var(--flit-border-soft)', color: 'var(--flit-text-muted)' }} role="status">
        {COPY_CARGANDO}
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-2 rounded-xl p-3" style={{ border: '1px solid var(--flit-border-soft)' }} role="alert">
        <p className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{COPY_ERROR}</p>
        <p className="text-[10px]" style={{ color: 'var(--flit-text-muted)' }}>{error}</p>
        <button type="button" onClick={reintentar} className="text-xs font-semibold hover:underline" style={{ color: 'var(--flit-blue)' }}>
          Reintentar
        </button>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <span className="block text-xs font-semibold" style={{ color: 'var(--flit-text-primary)' }}>Permisos individuales</span>
        {hayConceder && (
          <button type="button" onClick={quitarAdicionales} className="text-[10px] hover:underline" style={{ color: 'var(--flit-blue)' }}>
            Quitar adicionales
          </button>
        )}
      </div>
      <div className="max-h-72 space-y-2 overflow-y-auto">
        {grupos.map((g) => {
          const etiqueta = etiquetaModulo(g.modulo);
          const abierto = abiertos.has(g.modulo);
          const marcadas = g.funciones.filter((f) => marcadaDe(enRolSet.has(f.codigo), exc.get(f.codigo))).length;
          return (
            <FlitAcordeon
              key={g.modulo}
              titulo={etiqueta}
              cantidad={g.funciones.length}
              descripcion={`${marcadas} de ${g.funciones.length} marcadas`}
              abierto={abierto}
              onToggle={() => setAbiertos((prev) => {
                const n = new Set(prev);
                if (n.has(g.modulo)) n.delete(g.modulo); else n.add(g.modulo);
                return n;
              })}
            >
              <fieldset className="flex flex-col gap-2 px-1 pb-1">
                <legend className="sr-only">Funciones de {etiqueta}</legend>
                {g.funciones.map((f) => (
                  <Casilla
                    key={f.codigo}
                    codigo={f.codigo}
                    nombre={f.nombreNegocio}
                    enRol={enRolSet.has(f.codigo)}
                    efecto={exc.get(f.codigo)}
                    onToggle={() => toggle(f.codigo)}
                  />
                ))}
              </fieldset>
            </FlitAcordeon>
          );
        })}
      </div>
      <p className="mt-1 text-[10px]" style={{ color: 'var(--flit-text-muted)' }}>{COPY_AYUDA}</p>
    </div>
  );
}

function Casilla({ codigo, nombre, enRol, efecto, onToggle }: {
  codigo: string;
  nombre: string;
  enRol: boolean;
  efecto: EfectoPermisoUsuario | undefined;
  onToggle: () => void;
}) {
  const id = useId();
  const estado = estadoDe(enRol, efecto);
  const marcada = marcadaDe(enRol, efecto);
  const etiqueta = ETIQUETA[estado];
  const tinta =
    estado === 'rol' ? 'var(--flit-success)'
      : estado === 'quitado' || estado === 'anadido' ? 'var(--flit-blue)'
        : estado === 'sin_efecto' ? 'var(--flit-text-muted)'
          : 'var(--flit-text-secondary)';

  return (
    <label htmlFor={id} className="flex cursor-pointer items-start gap-2 rounded-lg px-2 py-1.5 text-xs hover:bg-[color:var(--flit-bg-app)]" style={{ color: tinta }}>
      <input
        id={id}
        type="checkbox"
        className="flit-focus mt-0.5 h-4 w-4 shrink-0 rounded"
        data-codigo={codigo}
        checked={marcada}
        onChange={onToggle}
        style={{ accentColor: 'var(--flit-blue)' }}
      />
      <span className="flex-1 font-medium" style={{ color: 'var(--flit-text-primary)' }}>
        {nombre}
        <span className="sr-only"> · {etiqueta || 'sin marcar'}</span>
      </span>
      {etiqueta && (
        <span className="shrink-0 text-[10px] font-semibold" style={{ color: tinta }}>{etiqueta}</span>
      )}
    </label>
  );
}
