# Registro como proveedor

Agente conversacional que prepara el registro de Periferia como proveedor: lee la solicitud, llena Excel o PDF desde el repositorio maestro, arma el paquete de firma y solo simula el envío si una persona lo confirma.

## Arranque local

Requiere [Bun](https://bun.sh) 1.3 o superior.

```bash
bun install
cp .env.example .env
```

En Windows, copia el archivo: `Copy-Item .env.example .env`.

Edita `.env` y pon tu clave en `GEMINI_API_KEY`. La clave no se commitea, no viaja al front y no se escribe en los logs.

```bash
bun run dev
```

Abre http://localhost:3000. El mismo proceso sirve el chat y la API.

## Variables

| Variable | Uso |
|---|---|
| `GEMINI_API_KEY` | Clave del proveedor. Solo en el backend. |
| `GEMINI_MODEL` | Modelo. Por defecto `gemini-2.5-flash`. |
| `MAX_TOOL_ITERATIONS` | Tope de vueltas herramienta-modelo por turno. Por defecto 25. |
| `MAX_SESSION_TOKENS` | Tope aproximado de tokens por sesión. Por defecto 100000. |
| `PORT` | Puerto HTTP. Por defecto 3000. |

## Demo sin modelo

```bash
bun install && bun run demo.ts
```

Recorre los cuatro casos de `fixtures/reto-01/casos/`, limpia `out/` al inicio y no usa la clave. Comprueba además que `modulo/` no diverja del prompt, del conocimiento ni de las herramientas.

## API

| Método | Ruta | Cuerpo / respuesta |
|---|---|---|
| `POST` | `/api/chat` | `{ sessionId, message }` → `{ reply, toolCalls, needsConfirmation }` |
| `GET` | `/api/sessions/:id` | Historial de la sesión |
| `GET` | `/api/health` | `{ ok: true, provider, model }` sin la clave |

`sessionId` acepta letras, números, `_` y `-`, hasta 80 caracteres. El chat del navegador usa un UUID guardado en `localStorage`.

## Link público

Todavía no hay URL desplegada: esta máquina no tiene sesión de Render ni la clave de Gemini. El servicio se publica con el blueprint [`render.yaml`](render.yaml):

1. Sube el repositorio a un remoto que Render pueda leer.
2. New → Blueprint y selecciona este repo.
3. Cuando Render pida `GEMINI_API_KEY`, pégala en el panel. No la pongas en el repositorio.
4. Usa un plan que no se duerma durante la defensa.
5. Comprueba `https://<tu-servicio>.onrender.com/api/health` y el chat en la raíz.

En local también puedes construir la imagen:

```bash
docker compose up --build
```

La imagen no incluye `.env`. Pasa la clave como variable del entorno.

## Qué produce un caso

`bun run demo.ts` deja, por caso, `out/<caso>/` con el formulario o `valores-portal.md`, `mapeo.json`, `log.jsonl` y `out/<caso>/paquete/` (`checklist.md`, `borrador-correo.md`, formulario y soportes encontrados). El envío simulado solo aparece si la confirmación es explícita.

El planteamiento está en [`SOLUCION.md`](SOLUCION.md). El enunciado original está en `PRD-01-agente-registro-proveedor 3/`.
