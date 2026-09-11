// FLITO — el selector de permisos individuales del formulario de usuario.
// Extraído de `pages/Users.tsx` sin cambios. HU #12175 / Feature #12072.
//
// Sale a archivo propio porque es la superficie que la HU #12087 reescribe entera (la rejilla de
// tres estados): con el selector aquí, esa historia toca este archivo y no la página.
//
// **Esto NO es kit.** Props tipadas, sin estado global, un único consumidor (los dos formularios
// de usuario de esta carpeta). Es además el lenguaje visual que `AtaduraFields.tsx` calca.

import { PAGES, PAGE_GROUPS, ROLE_DEFAULT_PAGES, type PageSlug, type UserRole } from '../../lib/permissions';

export default function PermissionsPicker({ role, extraPages, onChange }: { role: UserRole; extraPages: PageSlug[]; onChange: (pages: PageSlug[]) => void }) {
  const rolePages = new Set<PageSlug>(ROLE_DEFAULT_PAGES[role] ?? []);
  const extraSet = new Set<PageSlug>(extraPages);

  if (role === 'admin') {
    return (
      <div className="rounded-xl p-3" style={{ border: '1px solid rgba(79,116,201,0.35)', background: 'rgba(79,116,201,0.10)' }}>
        <p className="text-xs font-semibold" style={{ color: 'var(--flit-blue)' }}>Acceso total</p>
        <p className="text-[10px]" style={{ color: 'var(--flit-blue)', opacity: 0.85 }}>El rol Administrador tiene acceso a todas las páginas. No requiere permisos individuales.</p>
      </div>
    );
  }

  const toggle = (slug: PageSlug) => {
    if (rolePages.has(slug)) return;
    const next = new Set(extraSet);
    if (next.has(slug)) next.delete(slug); else next.add(slug);
    onChange(Array.from(next));
  };

  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <span className="block text-xs font-semibold" style={{ color: 'var(--flit-text-primary)' }}>Permisos individuales</span>
        {extraPages.length > 0 && (
          <button type="button" onClick={() => onChange([])} className="text-[10px] hover:underline" style={{ color: 'var(--flit-blue)' }}>Quitar adicionales</button>
        )}
      </div>
      <div className="max-h-60 space-y-3 overflow-y-auto rounded-xl bg-white p-3" style={{ border: '1px solid var(--flit-border-soft)' }}>
        {PAGE_GROUPS.map((g) => (
          <div key={g.label}>
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.2em]" style={{ color: 'var(--flit-text-muted)' }}>{g.label}</p>
            <div className="grid grid-cols-2 gap-1">
              {g.pages.map((p) => {
                const fromRole = rolePages.has(p);
                const isChecked = fromRole || extraSet.has(p);
                const style = fromRole
                  ? { color: 'var(--flit-success)', background: 'rgba(112,207,58,0.14)', cursor: 'default' as const }
                  : isChecked
                    ? { color: 'var(--flit-blue)', background: 'rgba(79,116,201,0.12)' }
                    : { color: 'var(--flit-text-secondary)' };
                return (
                  <label key={p} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1 text-xs hover:bg-[color:var(--flit-bg-app)]" style={style}>
                    <input type="checkbox" checked={isChecked} disabled={fromRole}
                      onChange={() => toggle(p)} className="rounded" style={{ accentColor: 'var(--flit-blue)' }} />
                    <span className="flex-1">{PAGES[p]}</span>
                    {fromRole && <span className="text-[9px] font-bold" style={{ color: 'var(--flit-success)' }}>ROL</span>}
                  </label>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <p className="mt-1 text-[10px]" style={{ color: 'var(--flit-text-muted)' }}>
        Las páginas marcadas como "ROL" vienen incluidas con el rol base. Marca adicionales para ampliar el acceso.
      </p>
    </div>
  );
}
