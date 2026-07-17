// RUM — Web Vitals de campo (FIONA PR2).
//
// Captura LCP / INP / CLS / FCP / TTFB con la librería oficial `web-vitals`
// (maneja bfcache, atribución de interacción y ventanas de sesión de CLS, que un
// colector casero haría mal) y las envía a `POST /api/rum` vía sendBeacon.
//
// - Solo en producción.
// - Muestreo por sesión (20%) para acotar volumen sin sesgar el p75.
// - Best-effort: cualquier fallo de telemetría es silencioso, nunca afecta al usuario.

import { onLCP, onINP, onCLS, onFCP, onTTFB, type Metric } from 'web-vitals';

const SAMPLE_RATE = 0.2;
const ENDPOINT = '/api/rum';

function sessionId(): string {
  try {
    let s = sessionStorage.getItem('rum_sid');
    if (!s) {
      s = (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`).slice(0, 40);
      sessionStorage.setItem('rum_sid', s);
    }
    return s;
  } catch { return ''; }
}

function isSampled(): boolean {
  try {
    let v = sessionStorage.getItem('rum_sampled');
    if (v === null) {
      v = Math.random() < SAMPLE_RATE ? '1' : '0';
      sessionStorage.setItem('rum_sampled', v);
    }
    return v === '1';
  } catch { return Math.random() < SAMPLE_RATE; }
}

function deviceClass(): string {
  try { return window.matchMedia('(max-width: 767px)').matches ? 'mobile' : 'desktop'; }
  catch { return 'desktop'; }
}

function effectiveConn(): string | undefined {
  const c = (navigator as unknown as { connection?: { effectiveType?: string } }).connection;
  return c?.effectiveType;
}

function report(m: Metric): void {
  const body = JSON.stringify({
    metric: m.name,
    value: m.value,
    rating: m.rating,
    route: location.pathname,
    navType: m.navigationType,
    device: deviceClass(),
    conn: effectiveConn(),
    sid: sessionId(),
  });
  try {
    if (navigator.sendBeacon) {
      navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'application/json' }));
    } else {
      void fetch(ENDPOINT, { method: 'POST', body, keepalive: true, headers: { 'Content-Type': 'application/json' } });
    }
  } catch { /* best-effort */ }
}

export function initRum(): void {
  if (import.meta.env.DEV) return;
  if (!isSampled()) return;
  onLCP(report);
  onINP(report);
  onCLS(report);
  onFCP(report);
  onTTFB(report);
}
