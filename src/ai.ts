import AdmZip from 'adm-zip'
import fs from 'fs'
import mongoose from 'mongoose'
const EXT = /\.(py|js|jsx|ts|tsx|java|c|cpp|h|hpp|cs|go|rs|php|rb|html|css|sql|json|md|txt|yml|yaml)$/i
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i
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

// Persist the source files extracted from uploaded ZIPs with the submission.
// Evaluation then uses MongoDB data directly instead of depending on a later
// Cloudinary download from a short-lived server process.
export function extractSubmissionFiles(buffer: Buffer) {
  const files: Array<{ path: string; content: string }> = []
  let total = 0
  for (const entry of new AdmZip(buffer).getEntries()) {
    if (entry.isDirectory || SKIP.test(entry.entryName) || !EXT.test(entry.entryName)) continue
    const content = entry.getData().toString('utf8').slice(0, 12000)
    if (total + content.length > 120000) break
    files.push({ path: entry.entryName, content })
    total += content.length
  }
  return files
}

async function submissionCode(sub: any) {
  let buf: Buffer | null = null
  if (Array.isArray(sub.code_files) && sub.code_files.length) {
    let code = ''
    for (const file of sub.code_files) {
      if (typeof file?.path !== 'string' || typeof file?.content !== 'string') continue
      code += `\n=== FILE: ${file.path} ===\n${file.content.slice(0, 12000)}\n`
    }
    if (code) return code
  }
  if (sub.zip_path && fs.existsSync(sub.zip_path)) buf = fs.readFileSync(sub.zip_path)
  // Try every available storage location. Older records can contain a stale
  // Cloudinary URL alongside a still-valid GridFS file or GitHub link.
  if (!buf && sub.cloudinary_url) {
    try {
      const r = await fetch(sub.cloudinary_url)
      if (r.ok) buf = Buffer.from(await r.arrayBuffer())
      else console.warn(`Submission ZIP download returned HTTP ${r.status} from Cloudinary.`)
    } catch (error: any) {
      console.warn('Submission ZIP download from Cloudinary failed:', error?.message || error)
    }
  }
  if (!buf && sub.file_id && mongoose.connection.db) {
    try {
      const bucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: 'submissions' })
      buf = await new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = []
        const stream = bucket.openDownloadStream(sub.file_id)
        stream.on('data', chunk => chunks.push(Buffer.from(chunk)))
        stream.once('error', reject)
        stream.once('end', () => resolve(Buffer.concat(chunks)))
      })
    } catch (error: any) {
      console.warn('Submission ZIP download from GridFS failed:', error?.message || error)
    }
  }
  if (!buf && sub.github_url) {
    try {
      const m = sub.github_url.match(/github\.com\/([^/]+)\/([^/#?]+)/i)
      if (m) {
        const r = await fetch(`https://codeload.github.com/${m[1]}/${m[2].replace(/\.git$/, '')}/zip/HEAD`)
        if (r.ok) buf = Buffer.from(await r.arrayBuffer())
        else console.warn(`GitHub archive download returned HTTP ${r.status}.`)
      }
    } catch (error: any) {
      console.warn('Submission ZIP download from GitHub failed:', error?.message || error)
    }
  }
  if (!buf) {
    console.error('submissionCode: could not read submission. sub fields →', {
      has_code_files: Array.isArray(sub.code_files) && sub.code_files.length > 0,
      zip_path: sub.zip_path || null,
      cloudinary_url: sub.cloudinary_url || null,
      file_id: sub.file_id || null,
      github_url: sub.github_url || null,
    })
    throw new Error('No readable submission (upload a ZIP or a public GitHub repo).')
  }
  let code = ''
  const images: string[] = []
  for (const e of new AdmZip(buf).getEntries()) {
    if (e.isDirectory || SKIP.test(e.entryName)) continue
    if (IMAGE_EXT.test(e.entryName)) {
      images.push(`${e.entryName} (${e.header.size} bytes)`)
      continue
    }
    if (!EXT.test(e.entryName)) continue
    const t = e.getData().toString('utf8').slice(0, 12000)
    if (code.length + t.length > 120000) break
    code += `\n=== FILE: ${e.entryName} ===\n${t}\n`
  }
  if (!code) throw new Error('No source files found in the submission.')
  if (images.length) code += `\n=== IMAGE ASSETS INCLUDED IN ZIP ===\n${images.join('\n')}\n`
  return code
}

async function evaluateSubmissionNow(sub: any, A: any) {
  return evaluateSource(await submissionCode(sub), A)
}

export const providerResponse = async (prompt: string) => {
  const provider = (process.env.AI_PROVIDER || (process.env.GEMINI_API_KEY ? 'gemini' : process.env.ANTHROPIC_API_KEY ? 'anthropic' : 'ollama')).toLowerCase()
  if (!['gemini', 'anthropic', 'ollama'].includes(provider)) throw new Error(`Unsupported AI_PROVIDER "${provider}".`)
  if (provider === 'gemini' && !process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not configured for AI evaluation.')
  if (provider === 'anthropic' && !process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not configured for AI evaluation.')
  const maxAttempts = Math.min(5, Math.max(1, Number(process.env.AI_RETRY_ATTEMPTS || 4)))
  let geminiModel = process.env.GEMINI_MODEL || 'gemini-3.8-flash'
  const geminiFallbackModel = process.env.GEMINI_FALLBACK_MODEL || 'gemini-3.6-flash'
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), Number(process.env.AI_TIMEOUT_MS || 180000))
    let r: Response
    try {
      r = provider === 'gemini'
        ? await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY!)}`, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({ contents:[{parts:[{text:prompt}]}], generationConfig:{responseMimeType:'application/json'} }), signal:controller.signal })
        : provider === 'anthropic'
        ? await fetch('https://api.anthropic.com/v1/messages', { method:'POST', headers:{'x-api-key':process.env.ANTHROPIC_API_KEY!, 'anthropic-version':'2023-06-01','content-type':'application/json'}, body:JSON.stringify({ model:process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5-20250929', max_tokens:4000, messages:[{role:'user',content:prompt}]}), signal:controller.signal })
        : await fetch(`${process.env.OLLAMA_URL || 'http://127.0.0.1:11434'}/api/generate`, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({model:process.env.OLLAMA_MODEL || 'llama3.2', prompt, stream:false, format:'json'}), signal:controller.signal })
    } catch (error: any) {
      if (error?.name === 'AbortError') throw new Error('AI evaluation timed out.')
      if (attempt === maxAttempts) throw new Error(`Could not connect to the ${provider} AI provider: ${error?.message || 'network request failed'}`)
      await new Promise(resolve => setTimeout(resolve, Math.min(1000 * (2 ** (attempt - 1)), 5000)))
      continue
    } finally {
      clearTimeout(timer)
    }

    const out: any = await r.json().catch(() => ({}))
    if (!r.ok) {
      const msg: string = out.error?.message ?? out.message ?? 'AI request failed'
      const lowerMsg = msg.toLowerCase()
      const quotaFailure = lowerMsg.includes('quota') || lowerMsg.includes('daily limit') || lowerMsg.includes('billing')
      const modelUnavailable = provider === 'gemini' && [404, 410].includes(r.status)
      const temporaryFailure = [408, 425, 429, 500, 502, 503, 504, 529].includes(r.status)
        || lowerMsg.includes('high demand') || lowerMsg.includes('overloaded') || lowerMsg.includes('temporarily unavailable')
      if (!quotaFailure && (temporaryFailure || modelUnavailable) && provider === 'gemini' && geminiModel !== geminiFallbackModel) {
        console.warn(`Gemini model ${geminiModel} is unavailable (${r.status}); retrying with ${geminiFallbackModel}.`)
        geminiModel = geminiFallbackModel
        continue
      }
      if (temporaryFailure && !quotaFailure && attempt < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, Math.min(1000 * (2 ** (attempt - 1)), 5000)))
        continue
      }
      if (quotaFailure) throw new Error('AI quota exceeded. Please try again later or ask your admin to configure another AI provider.')
      throw new Error(temporaryFailure ? `AI provider is still overloaded after ${attempt} attempts. Please retry shortly.` : msg)
    }
    const text = provider === 'ollama' ? out.response ?? '' : provider === 'anthropic' ? out.content?.map((c:any)=>c.text ?? '').join('') ?? '' : out.candidates?.[0]?.content?.parts?.map((p:any)=>p.text ?? '').join('') ?? ''
    const start = text.indexOf('{'); const end = text.lastIndexOf('}')
    if (start < 0 || end < start) throw new Error('AI returned invalid JSON.')
    return JSON.parse(text.slice(start, end + 1))
  }
  throw new Error('AI provider is temporarily unavailable. Please retry shortly.')
}

export async function generateTheoryQuestions(sub: any, A: any) {
  const count = Math.min(10, Math.max(4, Number(A.theory_question_count || 5)))
  const code = await submissionCode(sub)
  const result = await providerResponse(`Generate exactly ${count} non-repetitive theory questions about this student's actual implementation. Test what, why, and how; reference concrete files, functions, data flow, or design choices visible in the submission. Do not invent facts or ask generic questions. Return only JSON: {"questions":[{"id":"q1","question":"..."}]}. CODE:\n${code.slice(0, 120000)}`)
  if (!Array.isArray(result.questions) || result.questions.length !== count) throw new Error('AI returned an invalid theory question set.')
  return result.questions.map((q:any, i:number) => ({ id: `theory-${i + 1}`, question: String(q.question || '').trim() })).filter((q:any) => q.question)
}

export async function evaluateTheory(sub: any, A: any, practical: any) {
  const questions = sub.theory_questions || []; const answers = sub.theory_answers || []
  const result = await providerResponse(`Evaluate each theory answer against the student's submitted code and question. Award the available marks fairly and explain errors or missing concepts. Return only JSON with exactly one result per question: {"criteria":[{"question_id":"...","score":0,"feedback":"..."}],"strengths":[],"weaknesses":[],"suggestions":[],"mentor_recommendations":"","summary":""}. Each question is worth ${Number(A.theory_marks || 30) / Math.max(1, questions.length)} marks. QUESTIONS AND ANSWERS:\n${questions.map((q:any,i:number)=>`${q.id}: ${q.question}\nANSWER: ${answers[i] || ''}`).join('\n')}\nCODE:\n${(await submissionCode(sub)).slice(0, 120000)}`)
  const per = Number(A.theory_marks || 30) / Math.max(1, questions.length)
  const theoryCriteria = questions.map((q:any,i:number) => { const x = result.criteria?.find((c:any)=>c.question_id === q.id) || {}; return { question_id:q.id, question:q.question, answer:answers[i] || '', max:per, score:Math.min(Math.max(Number(x.score)||0,0),per), feedback:String(x.feedback || '') } })
  const theoryTotal = theoryCriteria.reduce((s:any,c:any)=>s+c.score,0)
  const configuredPracticalMax = Number(A.practical_marks || practical.max || 0)
  const practicalScale = practical.max ? configuredPracticalMax / practical.max : 1
  const practicalCriteria = practical.criteria.map((criterion:any) => ({ ...criterion, max: criterion.max * practicalScale, score: criterion.score * practicalScale }))
  const practicalTotal = practicalCriteria.reduce((s:any,c:any)=>s+c.score,0)
  const total = practicalTotal + theoryTotal; const max = configuredPracticalMax + Number(A.theory_marks || 30)
  return { ...practical, ...result, criteria: practicalCriteria, theory_criteria:theoryCriteria, theory_total:theoryTotal, theory_max:Number(A.theory_marks || 30), practical_total:practicalTotal, practical_max:configuredPracticalMax, total, max, performance_level: total/max*100 < 30 ? 'Basic' : total/max*100 < 70 ? 'Average' : total/max*100 < 85 ? 'Good' : 'Excellent' }
}

async function evaluateSource(code: string, A: any) {
  const rubric = A.rubric.map((c: any) => JSON.stringify({
    criterion_id: String(c.id),
    name: c.name,
    maximum_marks: Number(c.marks),
    requirements: c.description,
  })).join('\n')
  const questions = A.questions.map((q: any, i: number) => `${i + 1}. ${q.title}: ${q.description} ${q.instructions}`).join('\n')
  const prompt = `You are an independent, strict, and unbiased evaluator.

Evaluate the complete submitted source archive objectively against only the assessment requirements and rubric below. Inspect the actual files and code before judging each criterion. Do not assume a feature is missing without checking relevant files, and do not claim a feature is working without evidence. If the archive does not provide enough evidence to verify a requirement, state that limitation explicitly rather than guessing.

Evaluate every rubric criterion separately using only its assigned maximum marks. Treat each criterion as an independent item: copy its exact criterion_id and name, never merge criterion names, and never create, omit, or rename criteria. Award full marks when the requirement is demonstrably satisfied, fair partial marks for a partially implemented requirement, and zero only when it is absent or clearly fails. Do not introduce unstated requirements, optional improvements, style preferences, or best practices as deductions. Do not penalize the same defect twice. Keep praise and deductions consistent.

Use the complete archive, including every relevant source file, configuration file, route, component, and test. A requirement is not missing merely because it is not shown in one file or because you did not find it on a first pass. Do not infer implementation from the assessment text, filenames, comments, or a student's claim. Conversely, do not report an omission unless you checked the relevant files and can name the exact inspected evidence. Distinguish an implemented endpoint from a similar but different endpoint, and distinguish an unverified runtime behavior from source-code evidence.

For every criterion, feedback must identify the exact requirement assessed, the evidence (file path and relevant implementation or observation), and why the awarded score is justified. For every deduction, explicitly state the unsatisfied requirement, evidence, why it falls short, and the marks deducted. Include these deduction explanations in the criterion feedback or weaknesses.

Provide a concise summary, 2-3 genuine evidence-based strengths, actual weaknesses, specific actionable improvements required to reach full marks, and mentor recommendations. Do not use generic praise or unsupported claims. If something cannot be verified from the submission, say so.

The final maximum is the sum of the rubric criteria maximum_marks, not a separate assessment total. The final performance level must be calculated exclusively from the final percentage: 0-29 = Basic, 30-69 = Average, 70-84 = Good, 85-100 = Excellent. Calculate the percentage from the awarded total and rubric maximum before choosing the level. The criteria scores must sum to the awarded total. Do not use "Bad"; use "Basic".

ASSESSMENT REQUIREMENTS:
ASSESSMENT: ${A.title} (${A.language}, ${A.difficulty})\nQUESTIONS:\n${questions}\nRUBRIC:\n${rubric}\n\nSTUDENT CODE:${code}
The rubric criteria in the output must be exactly the same count and order as the rubric input. Scores must be numbers from 0 through that criterion's maximum, and their sum must equal the total. Respond with ONLY valid JSON matching this shape: {"criteria":[{"criterion_id":"<exact rubric criterion_id>","level":"excellent|good|average|needs_improvement","score":<number 0..max>,"feedback":"<requirement, files inspected, evidence, score justification, and—if deducted—the exact shortfall, reason, and marks deducted>","evidence":"<file path(s) + relevant implementation, or explicit verification limitation>"}],"strengths":["<genuine demonstrated strength with evidence>"],"weaknesses":["<actual weakness or deduction: requirement; inspected evidence; why it falls short; marks deducted>"],"suggestions":["<specific improvement required to reach full marks>"],"mentor_recommendations":"<clear next learning step and mentor focus>","summary":"<2-3 evidence-based sentences>","performance_level":"Basic|Average|Good|Excellent"}`
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
  if (!r.ok) {
    const msg: string = out.error?.message ?? out.message ?? 'AI request failed'
    if (r.status === 429 || msg.toLowerCase().includes('quota') || msg.toLowerCase().includes('rate')) {
      throw new Error('AI quota exceeded. The free-tier daily limit has been reached. Please try again later or ask your admin to upgrade the AI plan.')
    }
    throw new Error(msg)
  }
  const text = provider === 'ollama'
    ? out.response ?? ''
    : provider === 'anthropic'
    ? out.content.map((c: any) => c.text ?? '').join('')
    : out.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? '').join('') ?? ''
  const ai = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1))
  const criteria = A.rubric.map((c: any) => { const x = ai.criteria.find((y: any) => y.criterion_id === c.id) ?? {}
    return { criterion_id: c.id, name: c.name, max: c.marks, score: Math.min(Math.max(Number(x.score) || 0, 0), c.marks), level: x.level ?? 'average', feedback: x.feedback ?? '', evidence: x.evidence ?? '' } })
  const total = criteria.reduce((t: number, c: any) => t + c.score, 0)
  const max = criteria.reduce((t: number, c: any) => t + c.max, 0)
  const percentage = max ? total / max * 100 : 0
  const performance_level = percentage < 30 ? 'Basic' : percentage < 70 ? 'Average' : percentage < 85 ? 'Good' : 'Excellent'
  return { criteria, total, max, strengths: ai.strengths ?? [], weaknesses: ai.weaknesses ?? [], suggestions: ai.suggestions ?? [], mentor_recommendations: ai.mentor_recommendations ?? '', summary: ai.summary ?? '', performance_level }
}
