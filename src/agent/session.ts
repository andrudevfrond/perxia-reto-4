import path from "node:path"
import { asegurarDir } from "../tools/datos.ts"

export type StoredToolCall = {
  id: string
  name: string
  args: Record<string, unknown>
  result: string
}

export type StoredMessage = {
  role: "user" | "assistant"
  content: string
  toolCalls?: StoredToolCall[]
}

export type Session = {
  id: string
  messages: StoredMessage[]
  createdAt: string
  updatedAt: string
}

export function sessionSegura(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,80}$/.test(id)
}

function ruta(directory: string, id: string): string {
  return path.join(directory, "out", "sessions", `${id}.json`)
}

export async function cargarSesion(directory: string, id: string): Promise<Session> {
  const archivo = Bun.file(ruta(directory, id))
  if (!(await archivo.exists())) {
    const ahora = new Date().toISOString()
    return { id, messages: [], createdAt: ahora, updatedAt: ahora }
  }
  const data = JSON.parse(await archivo.text()) as Session
  return data
}

export async function guardarSesion(directory: string, session: Session): Promise<void> {
  session.updatedAt = new Date().toISOString()
  const destino = ruta(directory, session.id)
  await asegurarDir(path.dirname(destino))
  await Bun.write(destino, JSON.stringify(session, null, 2))
}

const colas = new Map<string, Promise<void>>()

export function enSerie<T>(id: string, tarea: () => Promise<T>): Promise<T> {
  const previa = colas.get(id) ?? Promise.resolve()
  const actual = previa.then(tarea, tarea)
  colas.set(
    id,
    actual.then(
      () => undefined,
      () => undefined,
    ),
  )
  return actual
}
