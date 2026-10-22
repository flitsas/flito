// FLITO — «Descargar certificados» en ZIP sobre las filas marcadas de la cola de Impuestos
// (HU #13206, Feature #12954). Endpoint de la HU #13205: `POST /api/flito/impuestos/certificados/zip`.
//
// Es la HERMANA de «Descargar soportes» (`DescargarSoportesZip.tsx`) y se calca de ella: mismo
// candado `enVuelo` contra el doble clic, misma tarjeta `AvisoVisible`, mismo guardia del nombre
// servido (`esNombreDeExport`), mismo reparto entre `role="status"` (espera y éxito) y
// `role="alert"` (error). No reutiliza `useDescargaZip` tal cual porque aquel hook habla de TIPOS de
// soporte y su aviso de error no conoce el 409 con lista de omitidos; lo que cambia es eso y el copy.
//
// Tres decisiones de la spec UX (`docs/ux/flito-impuestos-zip-certificados-runt.md`):
//   · **Durante la descarga, `aria-disabled` y no `disabled`** (AC5): un `disabled` nativo saca el
//     botón del orden de tabulación y el foco cae en `<body>` justo cuando el usuario espera. El
//     candado `enVuelo` es el que de verdad impide la segunda petición.
//   · **El uuid nunca se pinta.** En el 409 la causa `no_disponible` trae el uuid del registro: se
//     traduce a la placa de la fila marcada o a «un registro».
//   · **Copy propio para 400 / 403 / 429**: el texto del servidor es el genérico de la familia ZIP
//     («documentos») y el 429 no tiene el pulido del producto.
//
// Los ids viajan en el CUERPO del POST; nada va en la URL (AGENTS.md §14).

import { useCallback, useRef, useState } from 'react';
import { FileCheck } from 'lucide-react';
import {
  CABECERA_CERTIFICADOS_OMITIDOS, CODIGO_ZIP_DEMASIADOS_REGISTROS, CODIGO_ZIP_SIN_CERTIFICADOS,
  CausaCertificadoOmitido, ZIP_SOPORTES_MAX_REGISTROS,
} from '@operaciones/shared-types';
import { ApiError, api } from '../../lib/api';
import { AvisoVisible, avisoDeError, esNombreDeExport, type AvisoExport } from './ExportarCola';
import { flitBtnSecondary, flitBtnSecondaryStyle } from '../flit/flitPageKit';

const RUTA = '/flito/impuestos/certificados/zip';
/** Mismo techo que el ZIP de soportes: el servidor genera hasta 300 PDF antes del primer byte. */
const ZIP_TIMEOUT_MS = 600_000;
const PREFIJO_ZIP = 'certificados-runt';
const NOMBRE_RESPALDO = 'certificados-runt.zip';
/** Identificadores por causa en la tarjeta del 409; el resto se resume en «y N más». */
const MAX_POR_CAUSA = 20;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Un bloque de la tarjeta del 409: una causa, sus identificadores (ya traducidos) y qué hacer. */
export interface GrupoOmitidos {
  causa: CausaCertificadoOmitido;
  rotulo: string;
  total: number;
  identificadores: string[];
  siguientePaso: string;
}

export interface AvisoCertificados extends AvisoExport {
  /** Solo en el 409: los omitidos agrupados por causa. Vacío = el 409 llegó sin lista legible. */
  grupos?: GrupoOmitidos[];
}

/** Cómo resolver un uuid a la placa que el usuario ve en la tabla. */
export type PlacaDe = (id: string) => string | null;

const COPY_CAUSA: Record<CausaCertificadoOmitido, { rotulo: string; siguientePaso: string }> = {
  [CausaCertificadoOmitido.SIN_CERTIFICACION_VIGENTE]: {
    rotulo: 'Sin certificación vigente',
    siguientePaso: 'Certifícalas con «Certificar» en la barra o en la fila, y vuelve a descargar.',
  },
  [CausaCertificadoOmitido.NO_DISPONIBLE]: {
    rotulo: 'Ya no están en tu cola',
    siguientePaso: 'Cambiaron de estado u organismo. Actualiza la página y vuelve a marcarlas.',
  },
};
const ORDEN_CAUSAS: CausaCertificadoOmitido[] = [
  CausaCertificadoOmitido.SIN_CERTIFICACION_VIGENTE, CausaCertificadoOmitido.NO_DISPONIBLE,
];

/** Un entero no negativo de una cabecera, o `null`. Nunca se completa lo que no vino. */
function cifraDeCabecera(bruto: string | null): number | null {
  const n = bruto === null || bruto.trim() === '' ? Number.NaN : Number(bruto);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

function codigoDe(e: unknown): string | null {
  if (!(e instanceof ApiError)) return null;
  const cuerpo = e.rawDetails as { codigo?: unknown } | null | undefined;
  return typeof cuerpo?.codigo === 'string' ? cuerpo.codigo : null;
}

const plural = (n: number, uno: string, varios: string) => (n === 1 ? uno : varios);

export function textoDeTopeCertificados(marcadas: number): string {
  return `Solo se pueden descargar los certificados de ${ZIP_SOPORTES_MAX_REGISTROS} registros a la `
    + `vez y marcaste ${marcadas}. Marca menos filas y vuelve a intentarlo.`;
}

/**
 * El identificador que se PINTA. `no_disponible` trae el uuid: se resuelve a placa o a
 * «un registro». Por defensa, cualquier identificador con forma de uuid recibe el mismo trato.
 */
function identificadorVisible(bruto: string, causa: CausaCertificadoOmitido, placaDe: PlacaDe): string {
  if (causa === CausaCertificadoOmitido.NO_DISPONIBLE || UUID.test(bruto)) {
    return placaDe(bruto) ?? 'un registro';
  }
  return bruto;
}

/** Los omitidos del 409 agrupados por causa, en orden fijo. Lo ilegible se descarta. */
export function agruparOmitidos(bruto: unknown, placaDe: PlacaDe): GrupoOmitidos[] {
  if (!Array.isArray(bruto)) return [];
  const porCausa = new Map<CausaCertificadoOmitido, string[]>();
  for (const item of bruto) {
    const o = item as { identificador?: unknown; causa?: unknown } | null;
    if (!o || typeof o.identificador !== 'string') continue;
    const causa = ORDEN_CAUSAS.find((c) => c === o.causa);
    if (!causa) continue;
    const lista = porCausa.get(causa) ?? [];
    lista.push(identificadorVisible(o.identificador, causa, placaDe));
    porCausa.set(causa, lista);
  }
  return ORDEN_CAUSAS.filter((c) => porCausa.has(c)).map((causa) => {
    const ids = porCausa.get(causa)!;
    return { causa, total: ids.length, identificadores: ids.slice(0, MAX_POR_CAUSA), ...COPY_CAUSA[causa] };
  });
}

/** Qué se le dice al usuario cuando el ZIP de certificados falla. Nunca el texto crudo del API. */
export function avisoDeCertificados(e: unknown, marcadas: number, placaDe: PlacaDe): AvisoCertificados {
  const codigo = codigoDe(e);
  if (codigo === CODIGO_ZIP_SIN_CERTIFICADOS) {
    const cuerpo = (e as ApiError).rawDetails as { omitidos?: unknown } | null | undefined;
    return {
      tono: 'error',
      reintentable: false,
      texto: marcadas === 1
        ? 'La fila marcada no tiene un certificado para descargar. No se descargó nada.'
        : `Ninguna de las ${marcadas} filas marcadas tiene un certificado para descargar. No se descargó nada.`,
      grupos: agruparOmitidos(cuerpo?.omitidos, placaDe),
    };
  }
  if (codigo === CODIGO_ZIP_DEMASIADOS_REGISTROS) {
    return { tono: 'error', reintentable: false, texto: textoDeTopeCertificados(marcadas) };
  }
  if (e instanceof ApiError && e.status === 429) {
    return {
      tono: 'error',
      reintentable: true,
      texto: 'Hiciste varias descargas de certificados seguidas. Espera 1 minuto y vuelve a intentarlo.',
    };
  }
  if (e instanceof ApiError && e.status === 403) {
    return {
      tono: 'error',
      reintentable: false,
      texto: 'No tienes permiso para descargar certificados RUNT. Pídeselo a un administrador.',
    };
  }
  // Solo los respaldos `tiempo` / `otro`: 422/429/403 ya se atendieron arriba, así que
  // `avisoDeError` no llega a hacer eco de ningún texto del servidor.
  const { tono, reintentable, texto } = avisoDeError(e, {
    tiempo: 'El ZIP de certificados tardó demasiado en prepararse. Vuelve a intentarlo; si sigue '
      + 'pasando, marca menos filas.',
  });
  return { tono, reintentable, texto };
}

/** Banda de éxito. Cifras solo si la cabecera es un entero ≥ 0 y no supera lo pedido. */
export function avisoDeExitoCertificados(nombre: string, omitidos: number | null, marcadas: number): AvisoCertificados {
  if (omitidos === null || omitidos > marcadas) {
    return { tono: 'ok', reintentable: false, texto: `ZIP descargado: ${nombre}.` };
  }
  if (omitidos === 0) {
    return {
      tono: 'ok',
      reintentable: false,
      texto: `ZIP descargado: ${nombre} — ${marcadas} ${plural(marcadas, 'certificado', 'certificados')}.`,
    };
  }
  const incluidos = marcadas - omitidos;
  return {
    tono: 'aviso',
    reintentable: false,
    texto: `ZIP descargado: ${nombre} — ${incluidos} de las ${marcadas} filas marcadas `
      + `${plural(incluidos, 'tenía', 'tenían')} certificado; `
      + `${plural(omitidos, 'la otra quedó fuera', `las otras ${omitidos} quedaron fuera`)}. `
      + `En omitidos.csv, dentro del ZIP, está ${plural(omitidos, 'cuál', 'cuáles')} y por qué.`,
  };
}

export interface EstadoDescargaCertificados {
  ocupado: boolean;
  aviso: AvisoCertificados | null;
  marcadas: number;
  descargar: (ids: string[], placaDe: PlacaDe) => void;
  reintentar: () => void;
  descartar: () => void;
}

/**
 * Estado de la descarga con el candado del doble clic (`ref`, no el `disabled`: ver
 * `useDescargaZip`). `ultima` guarda ids y resolutor de placas para que «Reintentar la descarga»
 * repita EXACTAMENTE la misma petición.
 */
export function useDescargaCertificados(): EstadoDescargaCertificados {
  const [ocupado, setOcupado] = useState(false);
  const [aviso, setAviso] = useState<AvisoCertificados | null>(null);
  const [marcadas, setMarcadas] = useState(0);
  const enVuelo = useRef(false);
  const ultima = useRef<{ ids: string[]; placaDe: PlacaDe } | null>(null);

  const descargar = useCallback((ids: string[], placaDe: PlacaDe) => {
    if (enVuelo.current || ids.length === 0) return;
    setMarcadas(ids.length);
    // El tope se ataja aquí, sin gastar la petición (AC3).
    if (ids.length > ZIP_SOPORTES_MAX_REGISTROS) {
      setAviso({ tono: 'error', reintentable: false, texto: textoDeTopeCertificados(ids.length) });
      return;
    }
    enVuelo.current = true;
    ultima.current = { ids, placaDe };
    setOcupado(true);
    setAviso(null);

    let omitidos: number | null = null;
    api.downloadPostNamed(
      RUTA,
      NOMBRE_RESPALDO,
      { ids },
      (n) => esNombreDeExport(PREFIJO_ZIP, n, 'zip'),
      (leer) => { omitidos = cifraDeCabecera(leer(CABECERA_CERTIFICADOS_OMITIDOS)); },
      ZIP_TIMEOUT_MS,
    )
      .then((nombre) => setAviso(avisoDeExitoCertificados(nombre, omitidos, ids.length)))
      .catch((e) => setAviso(avisoDeCertificados(e, ids.length, placaDe)))
      .finally(() => {
        enVuelo.current = false;
        setOcupado(false);
      });
  }, []);

  const reintentar = useCallback(() => {
    const previa = ultima.current;
    if (previa) descargar(previa.ids, previa.placaDe);
  }, [descargar]);

  const descartar = useCallback(() => setAviso(null), []);

  return { ocupado, aviso, marcadas, descargar, reintentar, descartar };
}

/**
 * El botón de la barra de selección. Secundario y pegado a «Descargar soportes».
 *
 * Mientras descarga: `aria-disabled` + `aria-busy`, el foco se queda y se ve (`flit-focus`), y el
 * clic no hace nada. El kit ya trae `aria-disabled:` para cursor y hover;
 * aquí se añade solo la opacidad del `:disabled`.
 */
export function DescargarCertificadosZip(
  { ids, ocupado, onDescargar, llenaEnMovil = false }:
  { ids: string[]; ocupado: boolean; onDescargar: (ids: string[]) => void; llenaEnMovil?: boolean },
) {
  const n = ids.length;
  const ancho = llenaEnMovil ? 'w-full justify-center sm:w-auto' : '';
  const registros = `${n} ${plural(n, 'registro', 'registros')}`;
  return (
    <div className={`flex flex-col items-start gap-1 ${llenaEnMovil ? 'w-full sm:w-auto' : ''}`}>
      <button
        type="button"
        className={`${flitBtnSecondary} ${ancho} aria-disabled:opacity-50`}
        style={flitBtnSecondaryStyle}
        onClick={() => { if (!ocupado) onDescargar(ids); }}
        disabled={!ocupado && n === 0}
        aria-disabled={ocupado || undefined}
        aria-busy={ocupado || undefined}
        aria-label={ocupado
          ? `Preparando el ZIP de certificados de ${registros}`
          : `Descargar certificados RUNT de ${registros} ${plural(n, 'marcado', 'marcados')}`}
      >
        <FileCheck size={16} aria-hidden="true" className="shrink-0" />
        {ocupado ? 'Preparando certificados…' : `Descargar certificados (${n})`}
      </button>
    </div>
  );
}

const estiloTarjeta = {
  borderRadius: 'var(--flit-radius-card)',
  border: '1px solid var(--flit-border-soft)',
  boxShadow: 'var(--flit-shadow-card)',
} as const;

/** La lista del 409: un `li` por causa (no por placa), con su siguiente paso. */
function ListaOmitidos({ grupos }: { grupos: GrupoOmitidos[] }) {
  if (grupos.length === 0) {
    return (
      <p className="mt-2 text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
        Revisa en la cola cuáles no tienen el chip «Certificado».
      </p>
    );
  }
  return (
    <ul className="mt-3 space-y-3">
      {grupos.map((g) => {
        const resto = g.total - g.identificadores.length;
        return (
          <li key={g.causa} className="break-words text-sm">
            <span className="font-medium" style={{ color: 'var(--flit-text-primary)' }}>
              {g.rotulo} ({g.total}):
            </span>{' '}
            <span style={{ color: 'var(--flit-text-primary)' }}>
              {g.identificadores.join(', ')}{resto > 0 ? ` y ${resto} más` : ''}
            </span>
            <span className="mt-0.5 block" style={{ color: 'var(--flit-text-secondary)' }}>
              {g.siguientePaso}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Espera + resultado, con su propia región `role="status"` siempre montada (no comparte la de
 * soportes: dos descargas a la vez no se pisan el texto). El error va por `role="alert"` de
 * `AvisoVisible` y no se repite en la polite.
 */
export function AvisoCertificadosZip(
  { ocupado, marcadas, aviso, onReintentar, onDescartar }:
  {
    ocupado: boolean; marcadas: number; aviso: AvisoCertificados | null;
    onReintentar: () => void; onDescartar: () => void;
  },
) {
  const esError = aviso?.tono === 'error';
  const preparando = `Preparando el ZIP de certificados de ${marcadas} ${plural(marcadas, 'registro', 'registros')}…`;
  const anuncio = ocupado ? preparando : (aviso && !esError ? aviso.texto : '');

  return (
    <>
      <p className="sr-only" role="status" data-testid="anuncio-certificados-zip">{anuncio}</p>
      {ocupado && (
        <div className="bg-flit-card px-6 py-4" style={estiloTarjeta} data-testid="espera-certificados-zip">
          <p className="text-sm font-medium" style={{ color: 'var(--flit-text-primary)' }}>{preparando}</p>
          <p className="mt-1 text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
            Se arma un PDF por registro antes de empezar la descarga; puede tardar un par de minutos.
            Puedes seguir usando la cola.
          </p>
        </div>
      )}
      {!ocupado && aviso && (
        <AvisoVisible aviso={aviso} onReintentar={onReintentar} onDescartar={onDescartar}>
          {aviso.grupos && <ListaOmitidos grupos={aviso.grupos} />}
        </AvisoVisible>
      )}
    </>
  );
}
