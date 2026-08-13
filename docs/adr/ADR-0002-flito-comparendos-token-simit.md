# ADR-0002 — Token SIMIT Verifik: cifrado en reposo y trazabilidad

## Estado

**Aceptado** — Feature [#11492](https://dev.azure.com/FlitDevOps/FLIT%20-%20FLITO/_workitems/edit/11492) (17a).  
Aprobado por Líder Técnico (2026-08-13): cipher AES-GCM en BD; hosts Verifik/UTS por env.

## Contexto

CF-03 exige token SIMIT editable en configuración de app, persistente, con trazabilidad de última actualización (quién/cuándo), y **nunca** en logs ni en listados. El Feature marca el riesgo de token en BD como Alto. El monorepo ya cifra secretos con AES-256-GCM + AAD (`siigoCredenciales`, `rndcCredenciales`, helpers en `shared/utils/crypto.ts`).

## Decisión

1. Persistir el token en `flito_comparendos_token_simit` como `token_cipher` + `iv` + `auth_tag` + `aad_nonce` + `key_version`.
2. Clave maestra dedicada `COMPARENDOS_ENC_KEY` (64 hex / 32 bytes), análoga a `SIIGO_ENC_KEY` — sin derivar de otras keys en producción; fallo explícito si falta al cifrar/descifrar.
3. Una sola fila `activo=true` (unique index parcial); rotación = desactivar anterior + insertar nueva (historial de “quién/cuándo”).
4. API: `GET` solo metadatos (`configurado`, `actualizadoEn`, `actualizadoPor`); `PUT` recibe plaintext una vez, cifra, no lo re-emite.
5. Runtime: envolver el secreto con `Redacted`; logs de sync sin Authorization ni token.
6. Hosts Verifik/UTS siempre por `process.env` / `config` (nunca hardcode). Token **no** vive solo en env en PDN: env puede bootstrappear dev, pero la fuente de verdad operativa es la fila cifrada.

## Alternativas consideradas

| Alternativa | Pros | Contras |
|---|---|---|
| A) Solo env (`VERIFIK_SIMIT_TOKEN`) | Simple, sin cipher en BD | No editable con trazabilidad en app; rota con redeploy; no cumple CF-03 |
| B) Texto plano en BD + audit | Editable | Riesgo Alto; incompatible con práctica Siigo/RNDC |
| C) **Cipher AES-GCM en BD (elegida)** | Cumple CF-03; patrón existente | Requiere key de entorno y rotación documentada |
| D) Reutilizar `SIIGO_ENC_KEY` / `RNDC_ENC_KEY` | Menos vars | Acopla rotación de dominios distintos; blast radius |

## Consecuencias

- **Positivas:** Paridad con Siigo; token ausente de respuestas de listado; audit `resource=flito_comparendos_token`.
- **Negativas:** Operación debe provisionar `COMPARENDOS_ENC_KEY` en cada ambiente antes de PUT/sync real.
- **Security pre-PR:** obligatorio `security-agent` (Feature).
- **Supersedes:** ninguno.
