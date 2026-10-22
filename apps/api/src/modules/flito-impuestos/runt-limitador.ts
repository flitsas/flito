// HU #12825 (AC3): tope GLOBAL de consultas al RUNT en vuelo en el proceso de la API, compartido
// por la cola de análisis post-envío y la certificación manual y por lote. Supuesto: la API corre
// en UN proceso (Dockerfile `node dist/server.js`, sin réplicas); con varias, el tope sería N×2 y
// habría que moverlo a Redis con un ADR.
//
// Se envuelve SOLO la llamada al RUNT, nunca la certificación entera: si un paso de la cola llamara
// a `certificarImpuesto` mientras ocupa un cupo, se bloquearía contra sí mismo.

import { CONCURRENCIA_CERTIFICACION } from '@operaciones/shared-types';
import { crearLimitador, type Limitador } from '../../shared/utils/limitador.js';

export type LimitadorRunt = Limitador;

export const limitadorRunt: LimitadorRunt = crearLimitador(CONCURRENCIA_CERTIFICACION);
