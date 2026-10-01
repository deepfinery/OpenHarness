import type { ChatMessage } from './llm.js';

type LoadedSkill = { id: string; name: string; instructions: string };

/** Only configured, explicitly loaded skill snapshots become protected operating instructions. */
export function withLoadedSkills(messages: ChatMessage[], skills: LoadedSkill[]): ChatMessage[] {
  if (!skills.length) return messages;
  const instructions = skills
    .map((skill) => `Loaded skill ${JSON.stringify(skill.name)}:\n${skill.instructions}`)
    .join('\n\n');
  const result = messages.map((message) =>
    message.role === 'tool' &&
    message.name === 'load_skill' &&
    skills.some((skill) => message.content.startsWith(`<skill name="${skill.name}">`))
      ? {
          ...message,
          content:
            'Skill loading result: the successfully loaded instructions are retained in the system context.',
        }
      : message,
  );
  result.splice(result[0]?.role === 'system' ? 1 : 0, 0, {
    role: 'system',
    content: `${instructions}\n\nCompletion audit: follow the loaded skill's mandatory phases, exact scope, data requirements and output contract through every pass, including final reporting. Before claiming completion, check each required deliverable against recorded evidence. Missing or inaccessible state is not evidence of completion. If mandatory work is unfinished, begin RUN INCOMPLETE, identify the missing work and obey the skill's restrictions on incomplete reports. Do not substitute a generic summary or ask the user to choose the next step when the skill already defines it.`,
  });
  return result;
}
