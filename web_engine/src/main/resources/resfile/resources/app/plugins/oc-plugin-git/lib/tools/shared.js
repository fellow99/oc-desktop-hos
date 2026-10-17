/**
 * 21 个工具的公共片段：JSON Schema 形状与结果包装。
 * 说明：上游对插件工具的输入走 `defineTool`/JSON Schema 校验，所以这里只写纯 JSON Schema，
 * 不引入任何 schema 库（插件是随包投放的独立 ESM）。
 */

export const DIR_PROPERTY = {
  type: "string",
  description: "Repository directory, relative to the workspace root. Defaults to the session directory.",
}

export const PATHS_PROPERTY = {
  type: "array",
  items: { type: "string" },
  description: "Paths relative to the repository root.",
}

export function objectSchema(properties, required = []) {
  return { type: "object", properties: { dir: DIR_PROPERTY, ...properties }, required, additionalProperties: false }
}

/** 结果包装（content 必填，metadata 为结构化摘要） */
export function text(content, metadata) {
  return metadata === undefined ? { content } : { content, metadata }
}
