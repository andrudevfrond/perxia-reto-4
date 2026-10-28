import path from "node:path"
import { leerConfig } from "../config.ts"
import { LlmError, type LlmAdapter, type LlmTurn } from "../llm/adapter.ts"
import { GoogleAdapter } from "../llm/google.ts"
import { parametrosDe } from "../llm/schema.ts"
import { esConfirmacionExplicita, type ToolContext } from "../tools/datos.ts"
import { ejecutar, listarHerramientas } from "../tools/registry.ts"
import { cargarSesion, guardarSesion, type Session, type StoredToolCall } from "./session.ts"

const PREGUNTA = "¿Confirmas el envío del paquete para firma?"

export type ToolCallPublica = {
  name: string
  args: Record<string, unknown>
  result: string
}

export type Turno = {
  reply: string
  toolCalls: ToolCallPublica[]
  needsConfirmation: boolean
}

export async function cargarSystem(directory: string): Promise<string> {
  const prompt = await Bun.file(path.join(directory, "agent", "prompt.md")).text()
  const conocimiento = await Bun.file(path.join(directory, "src", "knowledge", "registro-proveedor.md")).text()
  return `${prompt.trim()}\n\n---\n\n# Conocimiento del proceso\n\n${conocimiento.trim()}\n`
}

export function crearAdaptador(): LlmAdapter {
  const config = leerConfig()
  if (!config.apiKey) throw new LlmError("Falta GEMINI_API_KEY en el servidor.")
  return new GoogleAdapter(config.apiKey, config.model)
}

export async function procesarTurno(directory: string, sessionId: string, message: string): Promise<Turno> {
  const config = leerConfig()
  const session = await cargarSesion(directory, sessionId)
  const system = await cargarSystem(directory)
  session.messages.push({ role: "user", content: message })
  let adapter: LlmAdapter
  try {
    adapter = crearAdaptador()
  } catch (error) {
    const reply = error instanceof LlmError ? error.message : "No pude consultar el modelo. La sesión sigue activa."
    session.messages.push({ role: "assistant", content: reply })
    await guardarSesion(directory, session)
    return { reply, toolCalls: [], needsConfirmation: false }
  }
  const confirmadoPorUsuario = esConfirmacionExplicita(message)
  const ctx: ToolContext = { directory, sessionId, confirmadoPorUsuario }
  const toolCalls: ToolCallPublica[] = []
  let armoPaquete = false
  let envioOk = false
  let reply = ""

  if (estimarTokens(session, system) > config.maxTokens) {
    reply = "Esta sesión llegó al tope de tokens. Abre una sesión nueva para seguir."
    session.messages.push({ role: "assistant", content: reply })
    await guardarSesion(directory, session)
    return { reply, toolCalls, needsConfirmation: false }
  }

  const herramientas = listarHerramientas().map(({ nombre, tool }) => ({
    name: nombre,
    description: tool.description,
    parameters: parametrosDe(tool.args),
  }))

  for (let i = 0; i < config.maxIterations; i += 1) {
    if (estimarTokens(session, system) > config.maxTokens) {
      reply = "Esta sesión llegó al tope de tokens. Abre una sesión nueva para seguir."
      session.messages.push({ role: "assistant", content: reply })
      break
    }

    let respuesta
    try {
      respuesta = await adapter.enviar(aContenido(session), herramientas, system)
    } catch (error) {
      reply = error instanceof LlmError ? error.message : "No pude consultar el modelo. La sesión sigue activa."
      session.messages.push({ role: "assistant", content: reply })
      break
    }

    if (respuesta.toolCalls.length === 0) {
      reply = respuesta.text.trim() || "No obtuve una respuesta del modelo."
      session.messages.push({ role: "assistant", content: reply })
      break
    }

    const ejecutadas: StoredToolCall[] = []
    for (const llamada of respuesta.toolCalls) {
      const result = await ejecutar(llamada.name, llamada.args, ctx)
      ejecutadas.push({ id: llamada.id, name: llamada.name, args: llamada.args, result })
      toolCalls.push({ name: llamada.name, args: llamada.args, result })
      const cuerpo = parseResultado(result)
      if (llamada.name === "proveedor_armar_paquete" && cuerpo.ok) armoPaquete = true
      if (llamada.name === "proveedor_simular_envio" && cuerpo.ok) envioOk = true
    }
    session.messages.push({
      role: "assistant",
      content: respuesta.text.trim(),
      toolCalls: ejecutadas,
    })

    if (i === config.maxIterations - 1) {
      reply = resumenTope(toolCalls)
      session.messages.push({ role: "assistant", content: reply })
    }
  }

  if (!envioOk && armoPaquete && !reply.includes("¿Confirmas el envío")) {
    reply = reply ? `${reply}\n\n${PREGUNTA}` : PREGUNTA
    const ultima = session.messages[session.messages.length - 1]
    if (ultima && ultima.role === "assistant" && !ultima.toolCalls?.length) ultima.content = reply
    else session.messages.push({ role: "assistant", content: PREGUNTA })
  }

  await guardarSesion(directory, session)
  return {
    reply,
    toolCalls,
    needsConfirmation: reply.includes("¿Confirmas el envío") && !envioOk,
  }
}

function estimarTokens(session: Session, system: string): number {
  return Math.ceil((JSON.stringify(session.messages).length + system.length) / 4)
}

function aContenido(session: Session): LlmTurn[] {
  const contenido: LlmTurn[] = []
  for (const mensaje of session.messages) {
    if (mensaje.role === "user") {
      contenido.push({ role: "user", parts: [{ text: mensaje.content }] })
      continue
    }
    const partes: LlmTurn["parts"] = []
    if (mensaje.content.trim()) partes.push({ text: mensaje.content })
    for (const llamada of mensaje.toolCalls ?? []) {
      partes.push({ functionCall: { id: llamada.id, name: llamada.name, args: llamada.args } })
    }
    if (partes.length > 0) contenido.push({ role: "model", parts: partes })
    if (mensaje.toolCalls && mensaje.toolCalls.length > 0) {
      contenido.push({
        role: "user",
        parts: mensaje.toolCalls.map((llamada) => ({
          functionResponse: {
            id: llamada.id,
            name: llamada.name,
            response: parseResultado(llamada.result),
          },
        })),
      })
    }
  }
  return contenido
}

function parseResultado(texto: string): Record<string, unknown> {
  try {
    const valor: unknown = JSON.parse(texto)
    if (valor !== null && typeof valor === "object" && !Array.isArray(valor)) return valor as Record<string, unknown>
  } catch {
    return { ok: false, error: "La herramienta no devolvió JSON." }
  }
  return { ok: false, error: "La herramienta no devolvió un objeto JSON." }
}

function resumenTope(toolCalls: ToolCallPublica[]): string {
  if (toolCalls.length === 0) {
    return "Llegué al tope de iteraciones de este turno y no alcancé a consultar herramientas."
  }
  const lineas = toolCalls.map((llamada) => `- ${llamada.name}`)
  return `Llegué al tope de iteraciones de este turno. Esto es lo que alcancé a consultar:\n${lineas.join("\n")}`
}
