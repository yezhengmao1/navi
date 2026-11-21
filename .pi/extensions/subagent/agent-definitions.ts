import { Type } from 'typebox';
import type { AgentConfig } from './agents.ts';

export interface AgentDefinition {
  name: string;
  instructions: string;
  model?: string;
  tools?: string[];
}

export const AgentDefinitionsSchema = Type.Array(Type.Object({
  name: Type.String({ description: 'Dynamic agent name referenced by agent/tasks/chain' }),
  instructions: Type.String({ description: 'Task-specific role instructions; no saved role file needed' }),
  model: Type.Optional(Type.String()),
  tools: Type.Optional(Type.Array(Type.String())),
}), { maxItems: 8, description: 'Ephemeral role definitions, overriding same-name saved roles. Not written to role files. Scheduled definitions are captured for that schedule only.' });

/** Shared role resolution for immediate and scheduled subagents. */
export function withAgentDefinitions(saved: AgentConfig[], definitions: AgentDefinition[] = []): AgentConfig[] {
  if (!Array.isArray(definitions) || definitions.length > 8) throw new Error('At most 8 dynamic definitions are allowed');
  const agents = [...saved];
  const names = new Set<string>();
  for (const definition of definitions) {
    if (!definition || typeof definition.name !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(definition.name) ||
        typeof definition.instructions !== 'string' || !definition.instructions.trim() || names.has(definition.name))
      throw new Error('Dynamic definitions require unique valid names and nonempty instructions');
    if (definition.model !== undefined && typeof definition.model !== 'string') throw new Error('Dynamic model must be a string');
    if (definition.tools !== undefined && (!Array.isArray(definition.tools) || definition.tools.some(tool => typeof tool !== 'string')))
      throw new Error('Dynamic tools must be an array of strings');
    names.add(definition.name);
    const existing = agents.findIndex(agent => agent.name === definition.name);
    if (existing >= 0) agents.splice(existing, 1);
    agents.push({ name: definition.name, description: 'Dynamic task-specific agent', systemPrompt: definition.instructions,
      model: definition.model, tools: definition.tools ? [...definition.tools] : undefined, source: 'user', filePath: '<inline-definition>' });
  }
  return agents;
}
