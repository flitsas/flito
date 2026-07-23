// FLITO Logística (Fase 2 · Inc 3) — cola de escrituras offline para la PWA del mensajero.
//
// Las escrituras de campo (recoger/entregar/novedad/devolución) deben funcionar sin señal (RN-06/CA-06):
// se encolan en IndexedDB con una clave de idempotencia propia y se reenvían al recuperar conexión. El
// backend deduplica por esa clave (Idempotency-Key), así un reintento no duplica. La cola es visible
// para el mensajero (CA-15). Sin dependencias: IndexedDB a mano.

import { useEffect, useState } from 'react';

const DB_NAME = 'flito-offline';
const STORE = 'campo-pending';

export interface PendingOp { key: string; path: string; body: unknown; label: string; createdAt: number }

class HttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'key' }); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await openDB();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const r = fn(tx.objectStore(STORE));
    r.onsuccess = () => resolve(r.result as T);
    r.onerror = () => reject(r.error);
  });
}

const idbAdd = (op: PendingOp) => withStore<IDBValidKey>('readwrite', (s) => s.put(op));
const idbDelete = (key: string) => withStore<undefined>('readwrite', (s) => s.delete(key));
export const listaPendientes = () => withStore<PendingOp[]>('readonly', (s) => s.getAll());

// ── Notificación a la UI ─────────────────────────────────────────────────────
const listeners = new Set<() => void>();
function notify() { listeners.forEach((l) => l()); }

// ── Envío HTTP con clave de idempotencia ─────────────────────────────────────
async function postWithKey(path: string, body: unknown, key: string): Promise<unknown> {
  const token = localStorage.getItem('token');
  const res = await fetch(`/api${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  }); // fetch solo lanza en error de red; los HTTP se resuelven.
  if (!res.ok) { const e = await res.json().catch(() => ({})); throw new HttpError(res.status, (e as { error?: string }).error ?? `HTTP ${res.status}`); }
  return res.json().catch(() => ({}));
}

/**
 * Envía una escritura de campo. Con conexión, la manda directo (y devuelve la respuesta en `result`);
 * si no hay señal o falla la red, la encola para reenviarla luego. Un error HTTP (validación/permiso)
 * SÍ se propaga (no se encola).
 */
export async function submitCampo(path: string, body: unknown, label: string): Promise<{ queued: boolean; result?: unknown }> {
  const key = crypto.randomUUID();
  if (navigator.onLine) {
    try { const result = await postWithKey(path, body, key); return { queued: false, result }; }
    catch (e) { if (e instanceof HttpError) throw e; /* error de red → encolar */ }
  }
  await idbAdd({ key, path, body, label, createdAt: Date.now() });
  notify();
  return { queued: true };
}

/** Reenvía la cola. Éxito → borra; error HTTP → descarta (no reintentable); error de red → detiene. */
export async function flushQueue(): Promise<{ enviados: number; pendientes: number }> {
  const ops = await listaPendientes();
  let enviados = 0;
  for (const op of ops) {
    try { await postWithKey(op.path, op.body, op.key); await idbDelete(op.key); enviados += 1; notify(); }
    catch (e) {
      if (e instanceof HttpError) { await idbDelete(op.key); enviados += 1; notify(); } // permanente: no reintentar en bucle
      else break; // red: reintentar más tarde
    }
  }
  return { enviados, pendientes: (await listaPendientes()).length };
}

// Reintento automático al recuperar señal.
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => { flushQueue().catch(() => { /* se reintenta luego */ }); });
}

/** Hook de la cola: cuenta de pendientes + estado online + reintento manual (CA-15). */
export function usePendingQueue() {
  const [count, setCount] = useState(0);
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  const [flushing, setFlushing] = useState(false);

  useEffect(() => {
    let vivo = true;
    const refrescar = () => { listaPendientes().then((p) => { if (vivo) setCount(p.length); }).catch(() => {}); };
    refrescar();
    listeners.add(refrescar);
    const on = () => { setOnline(true); refrescar(); };
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => { vivo = false; listeners.delete(refrescar); window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);

  const flush = async () => { setFlushing(true); try { await flushQueue(); } finally { setFlushing(false); } };
  return { count, online, flushing, flush };
}
