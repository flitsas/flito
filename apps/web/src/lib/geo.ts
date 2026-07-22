// FLITO Logística (Fase 2 · Inc 4) — ubicación best-effort para los eventos de recogida/entrega.
// RN-07: solo se captura en el evento puntual, nunca como rastreo continuo. Si el mensajero niega el
// permiso o no hay señal GPS, se resuelve vacío y la operación continúa (best-effort, §9.5).

export function obtenerUbicacion(): Promise<{ lat?: string; lng?: string }> {
  return new Promise((resolve) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) { resolve({}); return; }
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude.toFixed(7), lng: p.coords.longitude.toFixed(7) }),
      () => resolve({}), // permiso negado / sin señal → continúa sin GPS
      { timeout: 6000, maximumAge: 60000, enableHighAccuracy: false },
    );
  });
}
