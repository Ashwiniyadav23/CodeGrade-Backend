import AdmZip from 'adm-zip'
import fs from 'fs'
import mongoose from 'mongoose'
const EXT = /\.(py|js|jsx|ts|tsx|java|c|cpp|h|hpp|cs|go|rs|php|rb|html|css|sql|json|md|txt|yml|yaml)$/i
const SKIP = /(node_modules|\.git\/|dist\/|build\/|package-lock|\.min\.|venv\/|__pycache__)/
let activeJobs = 0
const waitingJobs: Array<() => void> = []
const maxConcurrentJobs = Number(process.env.AI_MAX_CONCURRENT || 2)

async function withAiLimit<T>(job: () => Promise<T>): Promise<T> {
  if (activeJobs >= maxConcurrentJobs) await new Promise<void>(resolve => waitingJobs.push(resolve))
  activeJobs++
  try { return await job() } finally {
    activeJobs--
    waitingJobs.shift()?.()
  }
}

export async function evaluateSubmission(sub: any, A: any) {
  return withAiLimit(() => evaluateSubmissionNow(sub, A))
}

async function evaluateSubmissionNow(sub: any, A: any) {
  let buf: Buffer | null = null
  if (sub.zip_path && fs.existsSync(sub.zip_path)) buf = fs.readFileSync(sub.zip_path)
  else if (sub.file_id && mongoose.connection.db) {
    const bucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: 'submissions' })
    buf = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = []
      const stream = bucket.openDownloadStream(sub.file_id)
      stream.on('data', chunk => chunks.push(Buffer.from(chunk)))
      stream.once('error', reject)
      stream.once('end', () => resolve(Buffer.concat(chunks)))
    })
  }
  else if (sub.github_url) {
    const m = sub.github_url.match(/github\.com\/([^/]+)\/([^/#?]+)/)
    if (m) { const r = await fetch(`https://codeload.github.com/${m[1]}/${m[2].replace(/\.git$/, '')}/zip/HEAD`); if (r.ok) buf = Buffer.from(await r.arrayBuffer()) }
  }
  if (!buf) throw new Error('No readable submission (upload a ZIP or a public GitHub repo).')
  let code = ''
  for (const e of new AdmZip(buf).getEntries()) {
    if (e.isDirectory || !EXT.test(e.entryName) || SKIP.test(e.entryName)) continue
    const t = e.getData().toString('utf8').slice(0, 12000)
    if (code.length + t.length > 120000) break
    code += `\n=== FILE: ${e.entryName} ===\n${t}\n`
  }
  if (!code) throw new Error('No source files found in the submission.')
  const rubric = A.rubric.map((c: any) => `- id:${c.id} | ${c.name} | max ${c.marks} | ${c.description}\n   Excellent: ${c.levels?.excellent}\n   Good: ${c.levels?.good}\n   Average: ${c.levels?.average}\n   Needs Improvement: ${c.levels?.needs_improvement}`).join('\n')
  const questions = A.questions.map((q: any, i: number) => `${i + 1}. ${q.title}: ${q.description} ${q.instructions}`).join('\n')
  const prompt = `You are an experienced Full-Stack Development Mentor, Technical Evaluator, and Student Performance Assessor.

Evaluate only the submitted code and evidence. Compare it against every assessment requirement and rubric criterion. Do not assume missing functionality exists, invent achievements or errors, or penalize the same issue twice. Award fair partial marks for partial implementations and explain specific technical evidence.

Write a concise summary of implemented functionality, missing or incorrect functionality, understanding, readiness, and the most important improvement area. Provide 2-3 evidence-based strengths, specific weaknesses explaining why each matters, actionable improvement suggestions with practical exercises, and mentor recommendations covering readiness, concepts to revise, practice tasks, and whether guided or independent practice is appropriate.

The final performance level must be calculated exclusively from the final percentage: 0-29 = Basic, 30-69 = Average, 70-84 = Good, 85-100 = Excellent. Calculate the percentage from the awarded total and maximum before choosing the level. The criteria scores must sum to the awarded total. Do not use "Bad"; use "Basic".

ASSESSMENT REQUIREMENTS:
ASSESSMENT: ${A.title} (${A.language}, ${A.difficulty})\nQUESTIONS:\n${questions}\nRUBRIC:\n${rubric}\n\nSTUDENT CODE:${code}
Respond with ONLY valid JSON: {"criteria":[{"criterion_id":"<id>","level":"excellent|good|average|needs_improvement","score":<number 0..max>,"feedback":"<specific evidence-based justification>","evidence":"<file + short snippet or observation>"}],"strengths":[""],"weaknesses":[""],"suggestions":[""],"mentor_recommendations":"<clear next learning step and mentor focus>","summary":"<2-3 sentences>","performance_level":"Basic|Average|Good|Excellent"}`
  const provider = (process.env.AI_PROVIDER || (process.env.GEMINI_API_KEY ? 'gemini' : process.env.ANTHROPIC_API_KEY ? 'anthropic' : 'ollama')).toLowerCase()
  if (provider !== 'ollama' && provider !== 'anthropic' && provider !== 'gemini') {
    throw new Error(`Unsupported AI_PROVIDER "${provider}". Use "gemini", "anthropic", or "ollama".`)
  }
  if (provider === 'anthropic' && !process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not configured for AI evaluation.')
  }
  if (provider === 'gemini' && !process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not configured for AI evaluation.')
  }
  if (provider === 'ollama' && process.env.RENDER && /127\.0\.0\.1|localhost/.test(process.env.OLLAMA_URL || '')) {
    throw new Error('OLLAMA_URL points to localhost in the deployed backend. Configure a publicly reachable Ollama URL or set AI_PROVIDER=gemini.')
  }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), Number(process.env.AI_TIMEOUT_MS || 180000))
  let r: Response
  try {
    r = provider === 'ollama'
      ? await fetch(`${process.env.OLLAMA_URL || 'http://127.0.0.1:11434'}/api/generate`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: process.env.OLLAMA_MODEL || 'llama3.2', prompt, stream: false, format: 'json' }),
          signal: controller.signal,
        })
      : provider === 'anthropic'
      ? await fetch('https://api.anthropic.com/v1/messages', { method: 'POST',
          headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY!, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
          body: JSON.stringify({ model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5-20250929', max_tokens: 4000, messages: [{ role: 'user', content: prompt }] }),
          signal: controller.signal,
        })
      : await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${process.env.GEMINI_MODEL || 'gemini-2.0-flash'}:generateContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY!)}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: 'application/json' } }),
          signal: controller.signal,
        })
  } catch (error: any) {
    if (error?.name === 'AbortError') throw new Error('AI evaluation timed out. Increase AI_TIMEOUT_MS or use a faster model.')
    throw new Error(`Could not connect to the ${provider} AI provider: ${error?.message || 'network request failed'}`)
  } finally {
    clearTimeout(timeout)
  }
  const out: any = await r.json()
  if (!r.ok) throw new Error(out.error?.message ?? out.message ?? 'AI request failed')
  const text = provider === 'ollama'
    ? out.response ?? ''
    : provider === 'anthropic'
    ? out.content.map((c: any) => c.text ?? '').join('')
    : out.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? '').join('') ?? ''
  const ai = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1))
  const criteria = A.rubric.map((c: any) => { const x = ai.criteria.find((y: any) => y.criterion_id === c.id) ?? {}
    return { criterion_id: c.id, name: c.name, max: c.marks, score: Math.min(Math.max(Number(x.score) || 0, 0), c.marks), level: x.level ?? 'average', feedback: x.feedback ?? '', evidence: x.evidence ?? '' } })
  const total = criteria.reduce((t: number, c: any) => t + c.score, 0)
  const max = Number(A.max_marks) || criteria.reduce((t: number, c: any) => t + c.max, 0)
  const percentage = max ? total / max * 100 : 0
  const performance_level = percentage < 30 ? 'Basic' : percentage < 70 ? 'Average' : percentage < 85 ? 'Good' : 'Excellent'
  return { criteria, total, max, strengths: ai.strengths ?? [], weaknesses: ai.weaknesses ?? [], suggestions: ai.suggestions ?? [], mentor_recommendations: ai.mentor_recommendations ?? '', summary: ai.summary ?? '', performance_level }
}
