import { z } from "zod"
import { anexarLog, type ToolContext } from "./datos.ts"
import * as proveedor from "./proveedor.ts"

export type ToolDefinition = {
  description: string
  args: Record<string, z.ZodType>
  execute: (args: Record<string, unknown>, ctx: ToolContext) => Promise<string>
}

function esHerramienta(valor: unknown): valor is ToolDefinition {
  if (valor === null || typeof valor !== "object") return false
  const candidato = valor as Partial<ToolDefinition>
  return typeof candidato.description === "string" && typeof candidato.execute === "function" && !!candidato.args
}

const registro = new Map<string, ToolDefinition>()
for (const [nombre, valor] of Object.entries(proveedor)) {
  if (esHerramienta(valor)) registro.set(`proveedor_${nombre}`, valor)
}

export function listarHerramientas(): { nombre: string; tool: ToolDefinition }[] {
  return [...registro.entries()].map(([nombre, tool]) => ({ nombre, tool }))
}

export async function ejecutar(nombre: string, args: unknown, ctx: ToolContext): Promise<string> {
  const tool = registro.get(nombre)
  const registroArgs = args !== null && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {}
  if (!tool) {
    const body = { ok: false, error: `Herramienta desconocida: ${nombre}.` }
    const caso = typeof registroArgs.caso === "string" ? registroArgs.caso : undefined
    await anexarLog(ctx.directory, caso, {
      ts: new Date().toISOString(),
      herramienta: nombre,
      ok: false,
      resumen: body.error,
    })
    return JSON.stringify(body)
  }
  return tool.execute(registroArgs, ctx)
}
