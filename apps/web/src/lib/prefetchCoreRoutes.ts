// SPRINT-PERF-UX-NAV-2026 (FIONA) — prefetch en idle de los chunks de las rutas
// core tras autenticar. Mantiene el code-splitting de #144 (no son imports
// estáticos: el budget del chunk `index` no se toca), pero al visitar Dashboard/
// Vehículos/Trámites/Bandeja el chunk ya está en caché → navegación instantánea.
//
// Se ejecuta UNA sola vez (guard de módulo). Usa requestIdleCallback para no
// competir con el render/hidratación inicial; cae a setTimeout donde no existe.

let prefetched = false;

type IdleCb = (cb: () => void) => void;

export function prefetchCoreRoutes(): void {
  if (prefetched || typeof window === 'undefined') return;
  prefetched = true;

  const idle: IdleCb =
    typeof window.requestIdleCallback === 'function'
      ? (cb) => window.requestIdleCallback(cb, { timeout: 2000 })
      : (cb) => window.setTimeout(cb, 200);

  idle(() => {
    // import() dinámico: warma la caché del bundler/navegador sin renderizar.
    // Los errores de red se ignoran — es una optimización best-effort.
    void import('../pages/Dashboard').catch(() => {});
    void import('../pages/Vehicles').catch(() => {});
    void import('../pages/TramiteDigital').catch(() => {});
    void import('../pages/TransitoBandeja').catch(() => {});
  });
}
