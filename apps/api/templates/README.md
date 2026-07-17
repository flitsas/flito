# Plantillas PDF — trámites traspaso

## FTRUNT (`ftrunt.pdf`)

Plantilla oficial Mintransporte para el **Formulario Único de Registro Nacional de Tránsito (FUR)**.

### Deploy

1. Obtener el PDF base FTRUNT vigente (misma versión que usa CEA System en producción).
2. Copiarlo a **`apps/api/templates/ftrunt.pdf`** en el servidor de la API antes del arranque.
3. Verificar permisos de lectura para el usuario del proceso (`pm2`, `node`, etc.).

### Modos de generación

| Variable | Comportamiento |
|---|---|
| `PDF_MODE=local` | Genera en proceso con `pdf-lib` sobre `ftrunt.pdf`. **Requiere la plantilla.** |
| `PDF_MODE=cea-proxy` (default si `CEA_DOCS_PROXY_ENABLED=true`) | Proxy a `cea.kyverum.com/api/transitos/ftrunt-internal`. No requiere plantilla local. |

Si `PDF_MODE=local` y falta la plantilla, la API intenta **fallback automático al proxy CEA** cuando `RUNT_INTERNAL_KEY` está configurada.

### Smoke post-deploy

```bash
curl -sS -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"orgNombre":"STT Medellín","orgCiudad":"Medellín","orgCodigo":"05001"}' \
  "https://operaciones.flitsas.com/api/tramites/{ID}/generar-fur"
```

Esperado: `200` y PDF en respuesta.
