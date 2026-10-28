import path from "node:path"
import { procesarTurno } from "./agent/loop.ts"
import { cargarSesion, enSerie, sessionSegura } from "./agent/session.ts"
import { leerConfig } from "./config.ts"
import { LlmError } from "./llm/adapter.ts"

const directory = path.resolve(import.meta.dir, "..")
const webRoot = path.resolve(directory, "web")
const config = leerConfig()

Bun.serve({
  port: config.port,
  hostname: "0.0.0.0",
  async fetch(req) {
    const url = new URL(req.url)
    try {
      if (req.method === "GET" && url.pathname === "/api/health") return json({ ok: true, provider: "google", model: config.model })
      if (req.method === "GET" && url.pathname.startsWith("/api/sessions/")) return await sesion(url.pathname.slice("/api/sessions/".length))
      if (req.method === "POST" && url.pathname === "/api/chat") return await chat(req)
      if (req.method === "GET") return await estatico(url.pathname)
      return json({ ok: false, error: "Ruta no encontrada." }, 404)
    } catch {
      return json({ ok: false, error: "No se pudo completar la solicitud." }, 500)
    }
  },
})

console.log(`Chat listo en http://localhost:${config.port} (google / ${config.model})`)

async function chat(req: Request): Promise<Response> {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return json({ ok: false, error: "El cuerpo debe ser JSON." }, 400)
  }
  if (body === null || typeof body !== "object") return json({ ok: false, error: "El cuerpo debe ser un objeto." }, 400)
  const datos = body as { sessionId?: unknown; message?: unknown }
  if (typeof datos.sessionId !== "string" || !sessionSegura(datos.sessionId)) {
    return json({ ok: false, error: "sessionId inválido." }, 400)
  }
  if (typeof datos.message !== "string" || datos.message.trim().length === 0) {
    return json({ ok: false, error: "Escribe un mensaje." }, 400)
  }
  const sessionId = datos.sessionId
  const message = datos.message.trim()
  try {
    const turno = await enSerie(sessionId, () => procesarTurno(directory, sessionId, message))
    return json(turno)
  } catch (error) {
    const reply = error instanceof LlmError ? error.message : "No pude consultar el modelo. La sesión sigue activa."
    return json({ reply, toolCalls: [], needsConfirmation: false })
  }
}

async function sesion(id: string): Promise<Response> {
  if (!sessionSegura(id)) return json({ ok: false, error: "sessionId inválido." }, 400)
  const archivo = Bun.file(path.join(directory, "out", "sessions", `${id}.json`))
  if (!(await archivo.exists())) return json({ ok: false, error: "Sesión no encontrada." }, 404)
  return json(await cargarSesion(directory, id))
}

async function estatico(pathname: string): Promise<Response> {
  const relativo = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "")
  const destino = path.resolve(webRoot, relativo)
  const comparacion = path.relative(webRoot, destino)
  if (comparacion.startsWith("..") || path.isAbsolute(comparacion)) return new Response("No encontrado", { status: 404 })
  const archivo = Bun.file(destino)
  if (!(await archivo.exists())) return new Response("No encontrado", { status: 404 })
  return new Response(archivo)
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  })
}
