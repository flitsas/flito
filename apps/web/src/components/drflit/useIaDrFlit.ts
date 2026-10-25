import { useCallback, useEffect, useRef, useState } from 'react';
import {
  FUNCIONES_DRFLIT, type CitaDrFlit, type CupoIaDrFlit, type EstadoAutorizacionDrFlit, type FuncionDrFlit,
} from '@operaciones/shared-types';
import { alLimpiarDrFlit } from '../../lib/drFlitAlmacen';
import { prepararEnvioIa, valoresGestionDelEnvio } from '../../lib/drFlitIa';
import type { ValorDetectado } from '../../lib/drFlitGestion';
import {
  aceptarAutorizacionIa, consultarAutorizacionIa, enviarChatIa, esVersionNoVigente,
} from '../../lib/drFlitIaChat';
import type { ErrorAutorizacion } from './DrFlitAutorizacion';
import { funcionNoHabilitada } from './drFlitFunciones';

type MapaMascara = ReturnType<typeof prepararEnvioIa>['mapa'];

// Dr. Flit IA — estado de la IA en el panel (HU #13857 IA-5; spec `docs/ux/flito-dr-flit-f4-ia.md`).
// Decide si una pregunta va al chat (`enUso`: IA disponible + autorización `ia` vigente + cupo), lleva
// la vista «Antes de usar la IA» y los avisos A/B/C del pie (IA.3). Toda falla de la IA devuelve
// `respaldo`: el panel responde con F3/F6 sin aviso (AC7). HU #13858 (IA-6): `soporte` y `gestion`
// vuelven como resultado propio (oferta de F5 / F6) en vez de caer al respaldo. Nada de esto escribe en consola.
//
// Memoria de la pestaña (no `sessionStorage`): si ya se ofreció la autorización, si la IA se apagó o
// el cupo se agotó en esta sesión, y el mapa de máscara POR ENVÍO (id del mensaje → mapa), que solo
// sirve para restaurar en pantalla los valores del reply (AC9). Se borra al terminar el chat o salir.

interface MemoriaIa {
  userId: number | undefined;
  ofrecida: boolean;
  apagada: boolean;
  agotada: boolean;
  mapas: Map<string, MapaMascara>;
}

const memoria: MemoriaIa = { userId: undefined, ofrecida: false, apagada: false, agotada: false, mapas: new Map() };

function memoriaDe(userId: number | undefined): MemoriaIa {
  if (memoria.userId !== userId) {
    Object.assign(memoria, { userId, ofrecida: false, apagada: false, agotada: false, mapas: new Map() });
  }
  return memoria;
}

/** «Terminar chat» / cierre de sesión: los mapas de máscara se olvidan (la sesión de IA sigue). */
export function olvidarMapasIa(): void {
  memoria.mapas = new Map();
}
alLimpiarDrFlit(olvidarMapasIa);

/** Mapa del envío que produjo la respuesta `id` (o `undefined` tras recargar: «(placa oculta)»). */
export function mapaDeRespuesta(id: string): MapaMascara | undefined {
  return memoria.mapas.get(id);
}

export function recordarMapa(id: string, mapa: MapaMascara): void {
  memoria.mapas.set(id, mapa);
}

export type ResultadoIa =
  | {
    tipo: 'ia'; intent: 'duda' | 'no_claro'; reply: string | null; enManuales: boolean; citas: CitaDrFlit[];
    mapa: MapaMascara;
  }
  /** HU #13858 (IA-6 AC1): oferta de soporte de F5; `reply` con tokens (se restaura con `mapa`). */
  | { tipo: 'soporte'; reply: string | null; mapa: MapaMascara }
  /** IA-6 AC2/AC4/AC5: valores del mensaje de ESTE envío, del mapa local (vacío = «necesito la placa…»). */
  | { tipo: 'gestion'; valores: ValorDetectado[] }
  /** IA-6 AC6: gestión por documento → solo enlaces a los módulos, sin consulta. */
  | { tipo: 'documento' }
  /** HU #13942: la IA no tiene manuales con qué responder (degradado `sin-manuales`, copy 4). */
  | { tipo: 'sin-manuales' }
  /** HU #13942: 403 `drflit-funcion-no-habilitada` con el panel abierto (copy 6; la IA se apaga). */
  | { tipo: 'retirada'; funcion: FuncionDrFlit }
  | { tipo: 'respaldo' };

/** A: cupo agotado · B: sin aceptar · C: la versión cambió (428). Precedencia C > A > B (IA.3). */
export type AvisoIa = 'A' | 'B' | 'C' | null;

type Fase = 'cargando' | 'sin-ia' | 'lista';

interface EstadoAut {
  recargando: boolean;
  enviando: boolean;
  error: ErrorAutorizacion;
}

const AUT_INICIAL: EstadoAut = { recargando: false, enviando: false, error: null };

export interface IaDrFlit {
  /** La siguiente pregunta va al chat. */
  enUso: boolean;
  aviso: AvisoIa;
  /** Restantes a mostrar (1–5) o `null` (sin línea de cupo). */
  cupoBajo: number | null;
  vista: 'chat' | 'autorizacion';
  textoVigente: string | null;
  aut: EstadoAut;
  abrirAutorizacion: () => void;
  ahoraNo: () => void;
  aceptar: () => void;
  reintentarAutorizacion: () => void;
  preguntar: (texto: string, previos: Parameters<typeof prepararEnvioIa>[1]) => Promise<ResultadoIa>;
}

/**
 * `habilitada` = el usuario tiene `drflit.ia.usar` (HU #13942). Sin ella el hook queda en `sin-ia` sin
 * pedir nada (cero `GET/POST /autorizacion?finalidad=ia`). `alRetirar`: un 403 de función al aceptar la
 * autorización; la IA se apaga y el panel pone el copy 6 en la conversación.
 */
export function useIaDrFlit(
  userId: number | undefined, alVolverAlChat: (anuncio: string) => void, habilitada = true, alRetirar?: () => void,
): IaDrFlit {
  const [fase, setFase] = useState<Fase>('cargando');
  const [datos, setDatos] = useState<EstadoAutorizacionDrFlit | null>(null);
  const [autorizado, setAutorizado] = useState(false);
  const [condiciones, setCondiciones] = useState(false);
  const [cupo, setCupo] = useState<CupoIaDrFlit | null>(null);
  const [agotada, setAgotada] = useState(() => memoriaDe(userId).agotada);
  const [vista, setVista] = useState<'chat' | 'autorizacion'>('chat');
  const [aut, setAut] = useState<EstadoAut>(AUT_INICIAL);
  const vivo = useRef(true);
  const volver = useRef(alVolverAlChat);
  const retirar = useRef(alRetirar);
  useEffect(() => {
    volver.current = alVolverAlChat;
    retirar.current = alRetirar;
  });

  const apagar = useCallback(() => {
    memoriaDe(userId).apagada = true;
    setFase('sin-ia');
    setVista('chat');
  }, [userId]);

  const marcarCupo = useCallback((c: CupoIaDrFlit | null) => {
    if (!c) return;
    setCupo(c);
    const sinCupo = c.restantes <= 0;
    memoriaDe(userId).agotada = sinCupo;
    setAgotada(sinCupo);
  }, [userId]);

  // Estado al abrir el panel. Si el GET falla: sin IA y sin aviso en esta apertura (IA.4).
  useEffect(() => {
    vivo.current = true;
    const mem = memoriaDe(userId);
    if (userId === undefined || mem.apagada || !habilitada) {
      setFase('sin-ia');
      return () => { vivo.current = false; };
    }
    consultarAutorizacionIa().then(
      (d) => {
        if (!vivo.current) return;
        if (!d.ia?.disponible) {
          setFase('sin-ia');
          return;
        }
        setDatos(d);
        setAutorizado(d.autorizado);
        if (d.ia.cupo) marcarCupo(d.ia.cupo);
        setFase('lista');
        if (!d.autorizado && !mem.ofrecida) {
          mem.ofrecida = true;
          setVista('autorizacion');
        }
      },
      () => {
        if (vivo.current) setFase('sin-ia');
      },
    );
    return () => { vivo.current = false; };
  }, [userId, marcarCupo, habilitada]);

  const recargarTexto = useCallback(() => {
    setAut({ recargando: true, enviando: false, error: null });
    consultarAutorizacionIa().then(
      (d) => {
        if (!vivo.current) return;
        if (!d.ia?.disponible) {
          apagar();
          return;
        }
        setDatos(d);
        setAut(AUT_INICIAL);
      },
      () => {
        if (vivo.current) setAut({ recargando: false, enviando: false, error: 'red' });
      },
    );
  }, [apagar]);

  const abrirAutorizacion = useCallback(() => {
    setVista('autorizacion');
    // Tras un 428 el texto mostrado ya no es el vigente: se recarga antes de poder aceptar.
    if (condiciones) recargarTexto();
    else setAut(AUT_INICIAL);
  }, [condiciones, recargarTexto]);

  const ahoraNo = useCallback(() => {
    setVista('chat');
    setAut(AUT_INICIAL);
    volver.current('');
  }, []);

  const aceptar = useCallback(() => {
    if (!datos || aut.enviando || aut.recargando) return;
    setAut({ recargando: false, enviando: true, error: null });
    aceptarAutorizacionIa(datos.versionVigente).then(
      () => {
        if (!vivo.current) return;
        setAutorizado(true);
        setCondiciones(false);
        setAut(AUT_INICIAL);
        setVista('chat');
        volver.current('Respuestas con IA activadas.');
      },
      (e) => {
        if (!vivo.current) return;
        if (funcionNoHabilitada(e)) {
          setAut(AUT_INICIAL);
          setFase('sin-ia');
          setVista('chat');
          retirar.current?.();
          return;
        }
        setAut({ recargando: false, enviando: false, error: esVersionNoVigente(e) ? 'version' : 'red' });
      },
    );
  }, [datos, aut.enviando, aut.recargando]);

  const reintentarAutorizacion = useCallback(() => {
    if (aut.error === 'version') recargarTexto();
    else aceptar();
  }, [aut.error, recargarTexto, aceptar]);

  const enUso = habilitada && fase === 'lista' && autorizado && !agotada;

  const preguntar = useCallback(async (texto: string, previos: Parameters<typeof prepararEnvioIa>[1]) => {
    const { envio, mapa } = prepararEnvioIa(texto, previos);
    const r = await enviarChatIa(envio);
    if (r.tipo === 'autorizacion-requerida') {
      setAutorizado(false);
      setCondiciones(true);
      return { tipo: 'respaldo' } as const;
    }
    if (r.tipo === 'falla') {
      const funcion = funcionNoHabilitada(r.causa);
      if (!funcion) return { tipo: 'respaldo' } as const;
      if (funcion === FUNCIONES_DRFLIT.usarIa) setFase('sin-ia');
      return { tipo: 'retirada', funcion } as const;
    }
    const resp = r.respuesta;
    if (resp.degradado === 'ia-apagada') {
      apagar();
      return { tipo: 'respaldo' } as const;
    }
    if (resp.degradado === 'cupo-agotado') {
      memoriaDe(userId).agotada = true;
      setAgotada(true);
      return { tipo: 'respaldo' } as const;
    }
    if (resp.degradado === 'sin-manuales') return { tipo: 'sin-manuales' } as const;
    marcarCupo(resp.cupo);
    // ia-timeout / ia-error / respuesta-invalida (o intent desconocido): modo de F3/F6 (IA-6 AC7).
    if (resp.degradado || !resp.intent) return { tipo: 'respaldo' } as const;
    if (resp.intent === 'soporte') return { tipo: 'soporte', reply: resp.reply, mapa } as const;
    if (resp.intent === 'gestion') {
      if (resp.gestionTarget === 'cliente') return { tipo: 'documento' } as const;
      // El valor sale del mapa local y SOLO del mensaje de este envío, nunca del modelo (AC2).
      return { tipo: 'gestion', valores: valoresGestionDelEnvio(resp.gestionRef, resp.gestionTarget, envio.mensaje, mapa) } as const;
    }
    if (resp.intent !== 'duda' && resp.intent !== 'no_claro') return { tipo: 'respaldo' } as const;
    return {
      tipo: 'ia', intent: resp.intent, reply: resp.reply, enManuales: resp.enManuales === true,
      citas: resp.citas.slice(0, 3), mapa,
    } as const;
  }, [userId, apagar, marcarCupo]);

  const aviso: AvisoIa = fase !== 'lista' || !habilitada ? null
    : condiciones ? 'C'
      : autorizado && agotada ? 'A'
        : !autorizado ? 'B' : null;
  const restantes = cupo?.restantes ?? null;
  const cupoBajo = enUso && restantes !== null && restantes >= 1 && restantes <= 5 ? restantes : null;

  return {
    enUso, aviso, cupoBajo, vista: fase === 'lista' && habilitada ? vista : 'chat', textoVigente: datos?.textoVigente ?? null, aut,
    abrirAutorizacion, ahoraNo, aceptar, reintentarAutorizacion, preguntar,
  };
}
