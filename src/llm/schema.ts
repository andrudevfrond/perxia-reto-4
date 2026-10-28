import { z } from "zod"
import { zodToJsonSchema } from "zod-to-json-schema"

export function parametrosDe(args: Record<string, z.ZodType>): Record<string, unknown> {
  const json: unknown = zodToJsonSchema(z.object(args), { target: "openApi3" })
  if (json === null || typeof json !== "object" || Array.isArray(json)) {
    return { type: "object", properties: {} }
  }
  const { $schema: _esquema, ...resto } = json as Record<string, unknown>
  return resto
}
