// FLITO — Gestión de usuarios. La PÁGINA: carga la lista, monta los catálogos que se piden una vez
// por pantalla y decide qué modal está abierto. Nada más.
//
// La tabla, los tres formularios, el selector de permisos y el ámbito viven en `pages/users/`
// (HU #12175 / Feature #12072). Se partió porque el archivo llegó a 680 líneas efectivas contra el
// techo `max-lines: 800` de `eslint.config.mjs`, con cuatro historias en cola escribiendo encima.

import { useEffect, useState, useCallback } from 'react';
import toast from 'react-hot-toast';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import GradientButton from '../components/flit/GradientButton';
import { useOrganismosParametrizados, useProveedoresSoat } from './users/AtaduraFields';
import { useCompanias } from './users/CompaniaField';
import { formatErrors } from './users/UserFormShared';
import type { UserRole } from '../lib/permissions';
import type { ResumenUsuarios, User } from './users/types';
import UsersTable from './users/UsersTable';
import UsersToolbar from './users/UsersToolbar';
import CreateForm from './users/CreateUserForm';
import EditForm from './users/EditUserForm';
import PasswordForm from './users/PasswordForm';

export default function Users() {
  const { user: me } = useAuth();
  const companias = useCompanias();
  const proveedores = useProveedoresSoat();
  const organismos = useOrganismosParametrizados();
  const nombreCompania = (id: number) => companias.data?.find((c) => c.id === id)?.nombre ?? null;
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rol, setRol] = useState<UserRole | ''>('');
  const [total, setTotal] = useState<number | null>(null);
  const [resumen, setResumen] = useState<ResumenUsuarios | null>(null);
  const [descargando, setDescargando] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState<User | null>(null);
  const [pwdTarget, setPwdTarget] = useState<User | null>(null);

  /**
   * La query se arma SOLO con lo que está puesto: sin filtro la ruta vuelve a ser `/users` a secas.
   * No es cosmética —un `?rol=` vacío es un parámetro que el backend tiene que decidir si ignora, y
   * es la diferencia entre pedir «todos» y pedir «los de rol vacío»—. La comparten el listado y el
   * export, que es lo que garantiza que el archivo y la tabla no puedan separarse.
   *
   * Aquí NO va `porPagina`: sin ese parámetro el backend no pone `LIMIT` y el listado se comporta
   * como siempre. Esta pantalla no pagina todavía, y pedir una página sin controles para cambiarla
   * sería esconder usuarios.
   */
  const query = rol ? `?rol=${encodeURIComponent(rol)}` : '';

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // `/users` sigue devolviendo un ARRAY PLANO; el total de coincidencias viaja en la cabecera.
      const cabeceras: { total: string | null } = { total: null };
      const rows = await api.getConCabeceras<User[]>(`/users${query}`, (leer) => { cabeceras.total = leer('X-Total-Count'); });
      setUsers(rows);
      setTotal(totalDeCabecera(cabeceras.total, rows.length));
    } catch (e) {
      // Estado de error de la LISTA, no un toast: el toast se va solo y deja la tabla diciendo
      // «Sin usuarios», que es falso. `users` se vacía para que no queden filas de la carga previa
      // bajo un mensaje que dice que la carga falló.
      setError(formatErrors(e));
      setUsers([]);
      setTotal(null);
    }
    finally { setLoading(false); }
  }, [query]);

  /**
   * El resumen es información SECUNDARIA y falla en silencio: si no llega, no se pinta el conteo y
   * la pantalla sigue sirviendo. Robarle el estado de error a la lista por esto pondría un
   * «Reintentar» sobre una tabla que sí cargó.
   */
  const cargarResumen = useCallback(async () => {
    try {
      const crudo = await api.get<unknown>('/users/resumen');
      setResumen(esResumen(crudo) ? crudo : null);
    }
    catch { setResumen(null); }
  }, []);

  const recargar = useCallback(() => { load(); cargarResumen(); }, [load, cargarResumen]);

  useEffect(() => { recargar(); }, [recargar]);

  /**
   * Quién ve la descarga. La condición está AQUÍ, con nombre y una sola definición, en vez de
   * incrustada en el JSX: la HU #12170 la sustituye por la función de permiso y tiene que poder
   * cambiar una línea. Hoy es el rol que ya gobierna esta pantalla entera.
   */
  const puedeExportar = me?.role === 'admin';

  const descargar = async () => {
    setDescargando(true);
    try {
      // Binario por `api.download`, que ya resuelve el blob y la entrega al navegador con el object
      // URL liberado después de la descarga. Ni `fetch` suelto ni `window.open` con la URL a mano.
      await api.download(`/users/export${query}`, 'usuarios.xlsx');
    } catch (e) { toast.error(formatErrors(e)); }
    finally { setDescargando(false); }
  };

  const handleToggle = async (u: User) => {
    if (u.id === me?.id) { toast.error('No puede desactivarse a sí mismo'); return; }
    if (!confirm(`${u.active ? 'Desactivar' : 'Activar'} a ${u.name}?`)) return;
    try {
      await api.patch(`/users/${u.id}/toggle`);
      toast.success('Estado actualizado');
      // `recargar` y no `load`: activar o desactivar mueve el reparto activos/inactivos del resumen.
      recargar();
    } catch (e) { toast.error(formatErrors(e)); }
  };

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 lg:gap-6">
      <PageHeaderCard
        title="Gestión de usuarios"
        subtitle="Equipo y accesos del sistema"
        actions={
          <GradientButton type="button" onClick={() => setShowCreate(true)}>
            Nuevo usuario
          </GradientButton>
        }
      />

      <UsersToolbar
        rol={rol}
        onRol={setRol}
        resumen={resumen}
        total={total}
        puedeExportar={puedeExportar}
        descargando={descargando}
        onDescargar={descargar}
      />

      <UsersTable
        users={users}
        loading={loading}
        error={error}
        onReintentar={recargar}
        meId={me?.id}
        nombreCompania={nombreCompania}
        proveedores={proveedores}
        organismos={organismos}
        onEditar={setEditing}
        onContrasena={setPwdTarget}
        onAlternar={handleToggle}
      />

      {showCreate && <CreateForm companias={companias} proveedores={proveedores} organismos={organismos} onClose={() => setShowCreate(false)} onCreated={recargar} />}
      {editing && <EditForm user={editing} companias={companias} proveedores={proveedores} organismos={organismos} onClose={() => setEditing(null)} onSaved={recargar} />}
      {/* La contraseña no cambia rol ni estado: recarga la lista y NO el resumen. */}
      {pwdTarget && <PasswordForm user={pwdTarget} isSelf={pwdTarget.id === me?.id} onClose={() => setPwdTarget(null)} onSaved={load} />}
    </div>
  );
}

/**
 * ¿Lo que llegó es un resumen? La comprobación NO sobra por tener el contrato escrito.
 *
 * `api.get<ResumenUsuarios>` es una promesa del programador, no del servidor: `request` devuelve lo
 * que parseó y el tipo solo dice cómo pensamos leerlo. Cuando lo que llega es otra cosa —un proxy
 * que responde `[]`, una ruta que aún no existe en el entorno, el catch-all de los E2E— leer
 * `.porRol` de eso lanza dentro del render y la pantalla ENTERA se queda en blanco: se perdería la
 * tabla de usuarios por un conteo decorativo. Con la guarda, el conteo no se pinta y el resto sigue.
 *
 * Se comprueba la forma que desreferencia el ÁRBOL DE COMPONENTES, no solo este archivo: aquí el
 * objeto se pasa entero a `UsersToolbar`, y su `ConteoPorRol` lee además `activos` e `inactivos`.
 * Por eso los tres campos son obligatorios. Un `{ porRol: { admin: 7 } }` pelado pasaba la guarda
 * vieja y pintaba «Administrador: 7 · activos · inactivos»: dos etiquetas sin número, sin error y
 * sin aviso, que es justo el estado silenciosamente incompleto que esta guarda existe para evitar.
 * Se exige `number` finito porque un `NaN` no rompería el render pero se leería como un dato.
 *
 * `porRol` trae hoy los doce roles y los vacíos en `0`, así que aquí no se rellena ningún hueco: el
 * resumen llega entero o no se pinta.
 */
const esConteo = (valor: unknown): valor is number => typeof valor === 'number' && Number.isFinite(valor);

function esResumen(valor: unknown): valor is ResumenUsuarios {
  if (typeof valor !== 'object' || valor === null || Array.isArray(valor)) return false;
  const { porRol, activos, inactivos } = valor as { porRol?: unknown; activos?: unknown; inactivos?: unknown };
  if (typeof porRol !== 'object' || porRol === null || Array.isArray(porRol)) return false;
  return esConteo(activos) && esConteo(inactivos);
}

/**
 * El total de coincidencias tal y como lo declara `X-Total-Count`, con las filas recibidas de
 * respaldo.
 *
 * La cabecera puede no venir —un proxy que no la exponga, un backend anterior a la HU #12172— y
 * puede venir con basura. Se acepta solo un entero no negativo; cualquier otra cosa cae al número de
 * filas, que es un dato cierto aunque sea el de la página. Lo que no puede pasar es que se pinte
 * «NaN coinciden con el filtro».
 */
function totalDeCabecera(valor: string | null, filas: number): number {
  const n = Number(valor);
  return valor !== null && valor.trim() !== '' && Number.isInteger(n) && n >= 0 ? n : filas;
}
