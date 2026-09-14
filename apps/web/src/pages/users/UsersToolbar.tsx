// FLITO — la barra del listado de usuarios: filtro por rol, conteo por rol y descarga del `.xlsx`.
// HU #12172 / Feature #12072.
// HU #12088: el filtro usa roles del catálogo API (activos), no solo USER_ROLES compilado.
//
// Vive aparte de `UsersTable` porque no es la tabla: sobrevive a los cuatro estados de la lista —se
// sigue pudiendo quitar el filtro con la tabla en error o vacía—, y meterla dentro obligaría a
// pintarla en cada rama de ese `tbody`.
//
// **Esto NO es kit.** Props tipadas, sin estado propio salvo el foco, un único consumidor.
//
// UX slim (extensión de pantalla existente): la primaria sigue siendo «Nuevo usuario», en el
// encabezado. La descarga es secundaria y se pinta como tal —borde, sin relleno—; el conteo es
// texto con los mismos chips de la columna «Rol», no tarjetas nuevas.

import StatusChip from '../../components/flit/StatusChip';
import { ROLES, ROLE_TONE, etiquetaRol, type ResumenUsuarios, type RolOpcion, type VistaBajas } from './types';

const VISTAS_BAJA: { value: VistaBajas; label: string }[] = [
  { value: 'en_alta', label: 'En alta' },
  { value: 'dados_de_baja', label: 'Dados de baja' },
  { value: 'todos', label: 'Todos' },
];

export default function UsersToolbar({ rol, onRol, vistaBajas, onVistaBajas, rolesCatalogo, resumen, total, puedeExportar, descargando, onDescargar }: {
  rol: string;
  onRol: (r: string) => void;
  /** HU #12089: En alta (default) / Dados de baja / Todos. */
  vistaBajas: VistaBajas;
  onVistaBajas: (v: VistaBajas) => void;
  rolesCatalogo: RolOpcion[] | null;
  resumen: ResumenUsuarios | null;
  total: number | null;
  puedeExportar: boolean;
  descargando: boolean;
  onDescargar: () => void;
}) {
  const opcionesFiltro = (rolesCatalogo ?? []).filter((r) => r.activo);
  const fallback = opcionesFiltro.length === 0 ? ROLES : opcionesFiltro;
  const filtrado = rol !== '' || vistaBajas !== 'en_alta';

  return (
    <div
      className="flex flex-col gap-4 bg-white px-4 py-4"
      style={{ borderRadius: 'var(--flit-radius-card)', boxShadow: 'var(--flit-shadow-card)', border: '1px solid var(--flit-border-soft)' }}
    >
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <label htmlFor="filtro-rol" className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--flit-text-secondary)' }}>
              Rol
            </label>
            <select
              id="filtro-rol"
              value={rol}
              onChange={(e) => onRol(e.target.value)}
              className="flit-focus min-w-[220px] rounded-[10px] border px-3 py-2 text-sm"
              style={{ borderColor: 'var(--flit-border-soft)', color: 'var(--flit-text-primary)' }}
            >
              <option value="">Todos los roles</option>
              {fallback.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="filtro-vista-bajas" className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--flit-text-secondary)' }}>
              Vista
            </label>
            <select
              id="filtro-vista-bajas"
              value={vistaBajas}
              onChange={(e) => onVistaBajas(e.target.value as VistaBajas)}
              className="flit-focus min-w-[180px] rounded-[10px] border px-3 py-2 text-sm"
              style={{ borderColor: 'var(--flit-border-soft)', color: 'var(--flit-text-primary)' }}
            >
              {VISTAS_BAJA.map((v) => <option key={v.value} value={v.value}>{v.label}</option>)}
            </select>
          </div>
        </div>

        {/* La condición de quién ve la descarga la decide la PÁGINA (ver `Users.tsx`); aquí solo se
            obedece. Si no la tiene, el botón no se pinta: no se pinta deshabilitado. */}
        {puedeExportar && (
          <div className="flex flex-col items-end gap-1">
            <button
              type="button"
              onClick={onDescargar}
              disabled={descargando}
              aria-describedby="alcance-descarga"
              className="flit-focus rounded-[10px] border px-4 py-2 text-sm font-semibold transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-50"
              style={{ borderColor: 'var(--flit-border-soft)', color: 'var(--flit-text-secondary)' }}
            >
              {descargando ? 'Generando...' : 'Descargar Excel'}
            </button>
            {/* El archivo NO es «lo que veo»: `GET /users/export` ignora la paginación a propósito y
                baja el filtro COMPLETO. El texto lo dice porque el botón, solo, se leería como que
                trae las filas visibles — y ese malentendido se descubre abriendo el archivo. */}
            <span id="alcance-descarga" className="text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>
              Todas las coincidencias del filtro
            </span>
          </div>
        )}
      </div>

      <ConteoPorRol resumen={resumen} total={total} filtrado={filtrado} rolesCatalogo={rolesCatalogo} />
    </div>
  );
}

/**
 * El conteo por rol. Se pinta desde `/users/resumen`, que cuenta el CENSO ENTERO y no la página:
 * por eso no cambia al filtrar, y por eso al filtrar se añade aparte cuántas filas coinciden
 * (`X-Total-Count`). Mezclar ambos números en una sola línea haría que «Admin 3» significara una
 * cosa distinta según el filtro puesto.
 *
 * Los ceros no se pintan. Las etiquetas salen del catálogo API cuando está disponible.
 */
function ConteoPorRol({ resumen, total, filtrado, rolesCatalogo }: {
  resumen: ResumenUsuarios | null;
  total: number | null;
  filtrado: boolean;
  rolesCatalogo: RolOpcion[] | null;
}) {
  if (!resumen) return null;
  const conUsuarios = Object.entries(resumen.porRol)
    .filter(([, n]) => (n ?? 0) > 0)
    .map(([codigo, n]) => ({ codigo, n: n as number, label: etiquetaRol(codigo, rolesCatalogo) }))
    .sort((a, b) => a.label.localeCompare(b.label, 'es'));
  return (
    <div className="flex flex-wrap items-center gap-2" aria-label="Usuarios por rol">
      <span className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--flit-text-secondary)' }}>
        Usuarios por rol
      </span>
      {conUsuarios.length === 0
        ? <span className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>Sin usuarios registrados</span>
        : conUsuarios.map((r) => (
          <StatusChip key={r.codigo} tone={ROLE_TONE[r.codigo] ?? 'neutral'}>
            {r.label}: {r.n}
          </StatusChip>
        ))}
      <span className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>
        {resumen.activos} activos · {resumen.inactivos} inactivos
        {filtrado && total !== null && ` · ${total} coinciden con el filtro`}
      </span>
    </div>
  );
}
