export type AppConfig = {
  apiKey: string
  model: string
  maxIterations: number
  maxTokens: number
  port: number
}

function entero(nombre: string, defecto: number): number {
  const valor = Number(process.env[nombre])
  if (!Number.isFinite(valor) || valor <= 0) return defecto
  return Math.floor(valor)
}

export function leerConfig(): AppConfig {
  return {
    apiKey: process.env.GEMINI_API_KEY ?? "",
    model: process.env.GEMINI_MODEL?.trim() || "gemini-2.5-flash",
    maxIterations: entero("MAX_TOOL_ITERATIONS", 25),
    maxTokens: entero("MAX_SESSION_TOKENS", 100_000),
    port: entero("PORT", 3000),
  }
}

export function limpiarSecreto(texto: string): string {
  const clave = process.env.GEMINI_API_KEY
  let limpio = texto
  if (clave && clave.length > 0) limpio = limpio.split(clave).join("[clave]")
  return limpio.replace(/AIza[\w-]{20,}/g, "[clave]")
}
