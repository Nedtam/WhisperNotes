// 笔记模板
import type { AppSettings, NoteLength, NoteTemplate } from '@shared/types'

export interface NoteLengthMeta {
  id: NoteLength
  name: string
  desc: string
}

/** 长度档元信息（文案 key；界面用的名字/描述在渲染层 i18n 的 org.len.* 里） */
export const NOTE_LENGTHS: NoteLengthMeta[] = [
  { id: 'concise', name: 'org.len.concise', desc: 'org.len.conciseDesc' },
  { id: 'standard', name: 'org.len.standard', desc: 'org.len.standardDesc' },
  { id: 'detailed', name: 'org.len.detailed', desc: 'org.len.detailedDesc' }
]

/** 长度档指令（追加到 system prompt） */
export function lengthRule(length: NoteLength | undefined): string {
  switch (length ?? 'standard') {
    case 'concise':
      return `
LENGTH MODE: CONCISE.
- Target: about one page or less (aim ≤ 25% of the transcript length, roughly 250-450 words for a typical lecture).
- Keep ONLY: main conclusions, definitions of key terms, important numbers/names, and action items.
- Cut: examples (keep at most 1 tiny example per major section, or none), repetitions, transition sentences, and secondary detail.
- Every bullet must contain exactly one piece of information. Prefer short bullets over paragraphs.`
    case 'detailed':
      return `
LENGTH MODE: DETAILED.
- Do NOT compress. Expand section by section so the note is complete (typically 2-4x the standard length).
- Keep: every definition, every example, every number, every named person/term, and lecturer's key sentences (quote them in the same language when wording matters).
- Include a "Possible confusions / comparison table" where concepts contrast, and a "Glossary" of terms defined in class.
- Longer paragraphs are acceptable; favor completeness and fidelity over brevity. Never drop content for the sake of length.`
    default:
      return `
LENGTH MODE: STANDARD.
- Cover every section heading and concept with a clear definition; include key numbers and names.
- Keep at most 1-2 examples per section (enough to make ideas concrete, no exhaustive lists).
- Bullets should normally stay under two lines; avoid repetition.`
  }
}

/** 课件参考注入（页号标注） */
export function slidesRule(slidesContext: string | undefined): string {
  if (!slidesContext) return ''
  return `
The lecturer's slide deck is provided below as reference, labelled by page/slide number.
- Use it to verify terminology, names, spellings and numbers you hear, and to fill structural headings.
- You MAY include slide-only content that clarifies the lecture, marked like (课件 p.N); never invent page numbers you cannot match.
- If transcript and slides conflict, trust the spoken transcript and keep the slide wording as an alternative in parentheses.

=== Slide deck reference ===
${slidesContext}
`
}

export const BUILTIN_TEMPLATES: NoteTemplate[] = [
  {
    id: 'study',
    name: '学习笔记（推荐）',
    description: '结构化 Markdown：主题/要点/定义/例子 + Key takeaways',
    systemPrompt: `You are an expert study-note assistant. Turn the classroom transcript into clean, well-structured Markdown study notes.

Rules:
- Cover every key idea, definition, formula, example, number and name that actually appears. Never invent content or facts.
- Structure with clear headings and bullet lists; bold important terms.
- Fix transcription artifacts silently (repetitions, fillers, broken words) but keep the lecturer's meaning and wording where sensible.
- Write in the same language as the transcript.
- End with a short "Key takeaways" bullet list.
Output Markdown only.`
  },
  {
    id: 'outline',
    name: '大纲 Outline',
    description: '层级大纲：一、二级标题与要点',
    systemPrompt: `You are an outline assistant. Convert the classroom transcript into a hierarchical Markdown outline that preserves the lecture structure and all substantive points, definitions and examples. Do not invent content. Same language as transcript. Output Markdown only.`
  },
  {
    id: 'cornell',
    name: '康奈尔 Cornell',
    description: 'Notes / Cues / Summary 三段式',
    systemPrompt: `You are a Cornell note-taking assistant. From the transcript produce three Markdown sections:
1) "## Notes" — detailed key content organized in bullets;
2) "## Cues & Questions" — short cues and self-test questions for each major section;
3) "## Summary" — a 5-8 sentence summary.
Never invent facts. Same language as the transcript. Output Markdown only.`
  },
  {
    id: 'actions',
    name: '要点 + 行动项',
    description: 'Key points / action items / open questions',
    systemPrompt: `You are a lecture digest assistant. From the transcript produce Markdown with:
- "## Key Points" — the essential ideas (bullets, bold terms),
- "## Definitions & Terms" — terms the lecturer defined,
- "## Action Items / Reminders" — anything the lecturer asked students to do or remember,
- "## Open Questions" — unresolved questions or discussion threads.
Never invent content. Same language as transcript. Output Markdown only.`
  }
]

function buildSystemPrompt(tpl: NoteTemplate, title: string): string {
  return tpl.systemPrompt.replaceAll('{title}', title)
}

export function getEffectiveTemplate(settings: AppSettings): NoteTemplate {
  const { llm } = settings
  const builtin = BUILTIN_TEMPLATES.find((t) => t.id === llm.templateId)
  if (builtin) return builtin
  return {
    id: 'custom',
    name: '自定义模板',
    description: '用户在设置里编写的提示词',
    systemPrompt: llm.customTemplate || BUILTIN_TEMPLATES[0].systemPrompt
  }
}

export function templateForId(id: string, custom: string): NoteTemplate {
  return BUILTIN_TEMPLATES.find((t) => t.id === id) ?? {
    id: 'custom',
    name: '自定义模板',
    description: '',
    systemPrompt: custom || BUILTIN_TEMPLATES[0].systemPrompt
  }
}

export { buildSystemPrompt }
