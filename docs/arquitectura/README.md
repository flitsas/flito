# Arquitectura de FLITO

Esta carpeta guarda documentos de diseño, runbooks e inventarios de FLITO. Además tiene el modelo de arquitectura como
código en [LikeC4](https://likec4.dev), la fuente de los diagramas que se publican en Flit Atlas. **El repo es público:**
lo que se escribe aquí queda a la vista de todos.

| Archivo | Qué tiene |
|---|---|
| `likec4.config.json` | Proyecto `flito` |
| `specification.c4` | Tipos y tags comunes. **Copia idéntica** de `arquitectura/landscape/specification.c4` de `flitsas/flit`: no la edites solo aquí |
| `contexto.c4` | Actores, externos y las piezas de FLIT con las que habla FLITO (tag `#referencia`) |
| `model.c4` | Sistema FLITO y sus contenedores |
| `componentes/api.c4` | Grupos funcionales de `apps/api`, la vista `flito_api_componentes` y su detalle |
| `dinamicas/sync-flit.c4` | Flujos `flujo_sync_flito_flit` y `flujo_sync_flito_flit1` |
| `views.c4` | Vistas `flito_contexto`, `flito_contenedores` y el detalle de fuentes, entidades y terceros |
| `tools/validar-metadata.mjs` | Reglas que `likec4 validate` no revisa |

El landscape de la empresa y el modelo de FLIT 2.0 viven en `flitsas/flit`.

## Cómo editar y validar

Edita los `.c4` y corre, desde la raíz del repo:

```bash
npx --yes likec4@1.59.4 validate docs/arquitectura
npx --yes likec4@1.59.4 start docs/arquitectura     # abre las vistas en el navegador

npx --yes likec4@1.59.4 export json --project flito -o /tmp/flito.json docs/arquitectura
node docs/arquitectura/tools/validar-metadata.mjs /tmp/flito.json docs/arquitectura
```

El workflow `.github/workflows/arquitectura.yml` hace lo mismo en cada PR que toque estos archivos y además compara
`specification.c4` con la de `flitsas/flit` (rama `develop`). La versión de LikeC4 está fijada en `1.59.4`: para subirla,
cámbiala en el workflow y en este README, con una versión de al menos dos semanas de publicada.

## Reglas del modelo

- **Nada de** IP, puertos internos de administración, hosts internos, secretos ni rutas de secretos. Tampoco nombres de
  personas: `owner` lleva un rol o un equipo. El validador busca lo que tiene forma de IP, token o correo, pero no lo
  reemplaza: revisa tu diff.
- **Modela lo que está en el código.** Lo que no puedas comprobar lleva la marca `[por verificar]`.
- **Metadatos obligatorios:** `owner`, `repo` (sistema), `repo_path` (contenedor; debe existir), `criticidad`
  (`critica`, `alta`, `media`, `baja`), `datos_personales` (`si` exige `#pii`, y al revés) y `k8s_workload` (aplicación y
  servicio: nombre exacto del Deployment, la llave del drift). `aplicativo` lleva el slug del catálogo de Atlas si existe. `adr` es opcional y cada ADR debe existir en el repo.
- **Relaciones:** verbo u objeto en español, de 60 caracteres como máximo. `-[grpc]->` para gRPC y `-[async]->` para el
  bus y los webhooks.

Tags: `#pii` · `#critico` · `#legado` · `#objetivo` (aún no en producción) · `#vigente` (camino actual que será
reemplazado) · `#temporal` · `#ia` · `#externo_publico` · `#suite` · `#referencia`.

## Publicación en Atlas

El job `publicar` de `arquitectura.yml` llama al workflow reutilizable `atlas-publicar-arquitectura.yml@v1` de `flitsas/flit-atlas`, una
vez por proyecto, en push a `develop`, `staging` o `release`, solo si están `ATLAS_URL` y `ATLAS_PUBLICAR_ARQUITECTURA=true`. Hoy no publica: la
segunda variable no existe. `metadata.aplicativo` lleva el slug del elemento en el catálogo de Atlas; si no hay slug, no se inventa.

## Que se lea sin zoom

Atlas muestra cada vista en un marco de 928 px de ancho. Una vista de resumen lleva hasta unos 15 nodos, agrupados con el tipo `grupo`, y
`navigateTo` hacia su detalle. Los elementos usan `size sm` y `textSize xl` desde la especificación. `likec4 validate` no avisa de una vista
ilegible: dibújala con `likec4 export png`, encógela a 928 px y mírala antes de subirla.
