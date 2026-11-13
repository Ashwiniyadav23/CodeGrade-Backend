import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import mongoose from 'mongoose'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import multer from 'multer'
import path from 'path'
import fs from 'fs'
import { User, Assessment, Assignment, Submission, Evaluation } from './models.js'
import { evaluateSubmission, evaluateTheory, generateTheoryQuestions, generateVivaQuestions, continueViva, generateVivaModification, evaluateViva } from './ai.js'

const SECRET = process.env.JWT_SECRET || 'dev-secret'
const uploadRoot = process.env.VERCEL ? '/tmp/codegrade/uploads' : path.resolve('uploads')
fs.mkdirSync(path.join(uploadRoot, 'starters'), { recursive: true })
fs.mkdirSync(path.join(uploadRoot, 'submissions'), { recursive: true })
const frontendOrigins = (process.env.FRONTEND_ORIGIN || 'http://localhost:5173,http://localhost:5174,http://localhost:5175')
  .split(',').map(origin => origin.trim()).filter(Boolean)
const app = express(); app.disable('x-powered-by'); app.use(cors({
  origin: (origin, callback) => callback(null, !origin || frontendOrigins.includes(origin)),
  methods: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
})); app.options('*', cors()); app.use(express.json({ limit: '5mb' }))
app.use((_req, res, next) => { res.setTimeout(180000, () => { if (!res.headersSent) res.status(504).json({ error: 'Request timed out' }) }); next() })
const h = (fn: any) => (req: any, res: any, next: any) => Promise.resolve(fn(req, res, next)).catch(next)
const activeExecutions = new Map<string, string>()
const connectDatabase = async () => {
  if (mongoose.connection.readyState === 1) return
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/codegrade', {
    maxPoolSize: Number(process.env.MONGO_MAX_POOL_SIZE || 100),
    minPoolSize: Number(process.env.MONGO_MIN_POOL_SIZE || 10),
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 180000,
  })
}
app.use(async (_req, _res, next) => {
  try { await connectDatabase(); next() } catch (error) { next(error) }
})
const sign = (u: any) => jwt.sign({ id: u.id }, SECRET, { expiresIn: '7d' })
const auth = (...roles: string[]) => async (req: any, res: any, next: any) => {
  try { const { id } = jwt.verify((req.headers.authorization || '').replace('Bearer ', ''), SECRET) as any; const u = await User.findById(id); if (!u) throw 0
    if (roles.length && !roles.includes(u.role)) return res.status(403).json({ error: 'Forbidden' }); req.user = u; next() } catch { res.status(401).json({ error: 'Unauthorized' }) } }
const storage = (dir: string, zipOnly: boolean) => multer({ limits: { fileSize: 50 * 1024 * 1024 },
  storage: multer.diskStorage({ destination: path.join(uploadRoot, dir), filename: (req: any, f, cb) => cb(null, `${req.user.id}-${Date.now()}${path.extname(f.originalname)}`) }),
  fileFilter: (_r, f, cb) => cb(null, !zipOnly || f.originalname.toLowerCase().endsWith('.zip')) })

app.use('/uploads/starters', express.static(path.join(uploadRoot, 'starters')))   // starter files are public; submissions are not
app.get('/api/health', (_req, res) => res.json({ ok: true, database: mongoose.connection.readyState === 1 }))

// ---------- Auth ----------
app.post('/api/auth/register', h(async (req: any, res: any) => {
  const { email, password, full_name, batch } = req.body
  if (!email || !password || password.length < 6) return res.status(400).json({ error: 'Email and a 6+ character password are required' })
  if (await User.findOne({ email: email.toLowerCase() })) return res.status(400).json({ error: 'Email already registered' })
  const role = process.env.ADMIN_EMAIL && email.toLowerCase() === process.env.ADMIN_EMAIL.toLowerCase() ? 'admin' : 'student'
  const u = await User.create({ email, full_name, batch, role, password_hash: await bcrypt.hash(password, 10) }); res.json({ token: sign(u) }) }))
app.post('/api/auth/login', h(async (req: any, res: any) => {
  const u = await User.findOne({ email: (req.body.email || '').toLowerCase() })
  if (!u || !(await bcrypt.compare(req.body.password || '', u.password_hash))) return res.status(400).json({ error: 'Invalid email or password' }); res.json({ token: sign(u) }) }))
app.get('/api/auth/me', auth(), (req: any, res) => res.json(req.user))
app.get('/api/students', auth('admin'), h(async (_q: any, res: any) => res.json(await User.find({ role: 'student' }).sort('full_name'))))
app.post('/api/upload/starter', auth('admin'), storage('starters', false).single('file'), (req: any, res) => res.json({ url: `/uploads/starters/${req.file.filename}` }))

// ---------- Assessments ----------
app.get('/api/assessments', auth(), h(async (req: any, res: any) => {
  if (req.user.role === 'admin') return res.json(await Assessment.find().sort('-created_at'))
  const ids = (await Assignment.find({ student: req.user.id })).map(a => a.assessment)
  const list = await Assessment.find({ _id: { $in: ids } }).sort('deadline')
  const out = await Promise.all(list.map(async a => {
    const s = await Submission.findOne({ assessment: a.id, student: req.user.id }).sort('-created_at')
    const ev = s && await Evaluation.findOne({ submission: s.id })
    return { ...a.toJSON(), status: s?.status, total: ev?.total } })); res.json(out) }))
app.post('/api/assessments', auth('admin'), h(async (req: any, res: any) => res.json(await Assessment.create({ ...req.body, created_by: req.user.id }))))
app.get('/api/assessments/:id', auth('admin'), h(async (req: any, res: any) => res.json(await Assessment.findById(req.params.id))))
app.put('/api/assessments/:id', auth('admin'), h(async (req: any, res: any) => res.json(await Assessment.findByIdAndUpdate(req.params.id, req.body, { new: true }))))
app.delete('/api/assessments/:id', auth('admin'), h(async (req: any, res: any) => {
  const subs = await Submission.find({ assessment: req.params.id })
  const bucket = mongoose.connection.db && new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: 'submissions' })
  for (const s of subs) {
    if (s.zip_path && fs.existsSync(s.zip_path)) fs.unlinkSync(s.zip_path)
    if (s.file_id && bucket) await bucket.delete(s.file_id).catch(() => undefined)
  }
  await Evaluation.deleteMany({ submission: { $in: subs.map(s => s.id) } }); await Submission.deleteMany({ assessment: req.params.id })
  await Assignment.deleteMany({ assessment: req.params.id }); await Assessment.findByIdAndDelete(req.params.id); res.json({ ok: true }) }))

// ---------- Assignment distribution ----------
app.get('/api/assessments/:id/assignments', auth('admin'), h(async (req: any, res: any) => res.json((await Assignment.find({ assessment: req.params.id })).map(a => String(a.student)))))
app.put('/api/assessments/:id/assignments', auth('admin'), h(async (req: any, res: any) => {
  const ids: string[] = req.body.studentIds || []
  await Assignment.deleteMany({ assessment: req.params.id, student: { $nin: ids } })
  for (const s of ids) await Assignment.updateOne({ assessment: req.params.id, student: s }, { $setOnInsert: { assessment: req.params.id, student: s } }, { upsert: true })
  res.json({ ok: true }) }))

// ---------- Student view + submission ----------
app.get('/api/assessments/:id/my', auth('student'), h(async (req: any, res: any) => {
  if (!(await Assignment.findOne({ assessment: req.params.id, student: req.user.id }))) return res.status(403).json({ error: 'Not assigned to you' })
  const assessment = await Assessment.findById(req.params.id)
  const submission = await Submission.findOne({ assessment: req.params.id, student: req.user.id }).sort('-created_at')
  const evaluation = submission && await Evaluation.findOne({ submission: submission.id })
  res.json({ assessment, submission, evaluation: evaluation ?? null }) }))
const validateCodeFiles = (files: any) => {
  if (!Array.isArray(files) || !files.length || files.length > 30) throw new Error('Add between 1 and 30 files.')
  const total = files.reduce((size: number, file: any) => {
    if (!file || typeof file.path !== 'string' || typeof file.content !== 'string' || !file.path.trim()) throw new Error('Each file needs a path and text content.')
    const normalized = path.posix.normalize(file.path.replaceAll('\\', '/'))
    if (normalized.startsWith('../') || normalized.startsWith('/') || normalized.includes('/../')) throw new Error('Invalid file path.')
    if (file.content.length > 200000) throw new Error('Each file must be smaller than 200 KB.')
    return size + file.content.length
  }, 0)
  if (total > 1000000) throw new Error('Workspace must be smaller than 1 MB.')
  return files.map((file: any) => ({ path: path.posix.normalize(file.path.replaceAll('\\', '/')), content: file.content }))
}
const assignedAssessment = async (req: any) => {
  const A = await Assessment.findById(req.params.id)
  if (!A || !(await Assignment.findOne({ assessment: A.id, student: req.user.id }))) return null
  return A
}
const evaluateAndStore = async (submission: any, assessment: any) => {
  if (!assessment.rubric.length) return null
  submission.status = 'evaluating'
  await submission.save()
  try {
    const practical = await evaluateSubmission(submission, assessment)
    const existing: any = await Evaluation.findOne({ submission: submission.id })
    const result: any = submission.theory_submitted ? await evaluateTheory(submission, assessment, practical) : practical
    if (existing?.viva_criteria?.length) {
      result.viva_criteria = existing.viva_criteria; result.viva_total = existing.viva_total; result.viva_max = existing.viva_max
      result.total = Number(result.total || 0) + Number(existing.viva_total || 0)
      result.max = Number(result.max || 0) + Number(existing.viva_max || 0)
      const percentage = result.max ? result.total / result.max * 100 : 0
      result.performance_level = percentage < 30 ? 'Basic' : percentage < 70 ? 'Average' : percentage < 85 ? 'Good' : 'Excellent'
    }
    const evaluation = await Evaluation.findOneAndUpdate(
      { submission: submission.id },
      { ...result, status: 'draft' },
      { upsert: true, new: true },
    )
    submission.status = 'review'
    await submission.save()
    return evaluation
  } catch (error) {
    submission.status = 'submitted'
    await submission.save()
    throw error
  }
  const prepareViva = async (submission: any, assessment: any) => {
    if (!assessment.viva_enabled || submission.viva_questions?.length) return
    submission.viva_questions = await generateVivaQuestions(submission, assessment)
    submission.viva_status = 'not_started'
    await submission.save()
  }
  const storeVivaEvaluation = async (submission: any, assessment: any) => {
    const viva = await evaluateViva(submission, assessment)
    const existing: any = await Evaluation.findOne({ submission: submission.id })
    const practicalTotal = Number(existing?.practical_total ?? existing?.total ?? 0)
    const practicalMax = Number(existing?.practical_max ?? existing?.max ?? assessment.practical_marks ?? 0)
    const theoryTotal = Number(existing?.theory_total || 0)
    const theoryMax = Number(existing?.theory_max || 0)
    const total = practicalTotal + theoryTotal + viva.viva_total
    const max = practicalMax + theoryMax + viva.viva_max
    const performance_level = total / Math.max(1, max) * 100 < 30 ? 'Basic' : total / Math.max(1, max) * 100 < 70 ? 'Average' : total / Math.max(1, max) * 100 < 85 ? 'Good' : 'Excellent'
    return Evaluation.findOneAndUpdate({ submission: submission.id }, { ...viva, criteria:existing?.criteria || [], practical_total:practicalTotal, practical_max:practicalMax, theory_criteria:existing?.theory_criteria || [], theory_total:theoryTotal, theory_max:theoryMax, total, max, performance_level, status:'draft' }, { upsert:true, new:true })
  }
}
app.get('/api/assessments/:id/workspace', auth('student'), h(async (req: any, res: any) => {
  if (!await assignedAssessment(req)) return res.status(403).json({ error: 'Not assigned to you' })
  const submission = await Submission.findOne({ assessment: req.params.id, student: req.user.id }).sort('-created_at')
  res.json({ files: submission?.code_files ?? [{ path: 'index.js', content: '// Start coding here\n' }], submitted: submission?.status === 'submitted' || submission?.status === 'review' || submission?.status === 'published' })
}))
app.post('/api/assessments/:id/theory', auth('student'), h(async (req: any, res: any) => {
  const A = await assignedAssessment(req)
  if (!A || !A.theory_enabled) return res.status(400).json({ error: 'Theory assessment is not enabled.' })
  const submission = await Submission.findOne({ assessment: A.id, student: req.user.id }).sort('-created_at')
  if (!submission || !submission.theory_questions?.length) return res.status(400).json({ error: 'Submit a ZIP before answering theory questions.' })
  const answers = req.body.answers
  if (!Array.isArray(answers) || answers.length !== submission.theory_questions.length || answers.some((answer: any) => typeof answer !== 'string' || !answer.trim())) {
    return res.status(400).json({ error: 'Answer every theory question before submitting.' })
  }
  submission.theory_answers = answers.map((answer: string) => answer.trim().slice(0, 10000))
  submission.theory_submitted = true
  await submission.save()
  const evaluation = await evaluateAndStore(submission, A)
  res.json({ submission, evaluation })
}))
app.get('/api/assessments/:id/viva', auth('student'), h(async (req: any, res: any) => {
  const A = await assignedAssessment(req)
  if (!A || !A.viva_enabled) return res.status(400).json({ error:'Practical viva is not enabled.' })
  const submission = await Submission.findOne({ assessment:A.id, student:req.user.id }).sort('-created_at')
  if (!submission?.viva_questions?.length) return res.status(400).json({ error:'Submit your code before starting the viva.' })
  res.json({ status:submission.viva_status, question:submission.viva_status === 'active' ? submission.viva_questions[submission.viva_question_index] : null, messages:submission.viva_messages, modificationTask:submission.viva_modification_task || null, modificationSubmitted:submission.viva_modification_submitted })
}))
app.post('/api/assessments/:id/viva/start', auth('student'), h(async (req: any, res: any) => {
  const A = await assignedAssessment(req)
  if (!A || !A.viva_enabled) return res.status(400).json({ error:'Practical viva is not enabled.' })
  const submission = await Submission.findOne({ assessment:A.id, student:req.user.id }).sort('-created_at')
  if (!submission?.viva_questions?.length) return res.status(400).json({ error:'Submit your code before starting the viva.' })
  if (submission.viva_status === 'completed') return res.json({ status:'completed', messages:submission.viva_messages, modificationTask:submission.viva_modification_task })
  submission.viva_status = 'active'
  if (!submission.viva_messages?.length) submission.viva_messages.push({ role:'ai', question_id:submission.viva_questions[0].id, text:submission.viva_questions[0].question, kind:'opening', created_at:new Date() })
  await submission.save()
  res.json({ status:'active', question:submission.viva_questions[submission.viva_question_index], messages:submission.viva_messages })
}))
app.post('/api/assessments/:id/viva/answer', auth('student'), h(async (req: any, res: any) => {
  const A = await assignedAssessment(req)
  if (!A || !A.viva_enabled) return res.status(400).json({ error:'Practical viva is not enabled.' })
  const submission = await Submission.findOne({ assessment:A.id, student:req.user.id }).sort('-created_at')
  const answer = typeof req.body.answer === 'string' ? req.body.answer.trim().slice(0,10000) : ''
  if (!submission || submission.viva_status !== 'active' || !answer) return res.status(400).json({ error:'An active viva and non-empty answer are required.' })
  const question = submission.viva_questions[submission.viva_question_index]
  submission.viva_messages.push({ role:'student', question_id:question.id, text:answer, created_at:new Date() })
  const next = await continueViva(submission, A)
  if (next.done) {
    submission.viva_status = 'modification'
    submission.viva_modification_task = await generateVivaModification(submission, A)
    await submission.save()
    return res.json({ status:'modification', messages:submission.viva_messages, modificationTask:submission.viva_modification_task })
  }
  submission.viva_messages.push({ role:'ai', question_id:question.id, text:next.question, kind:next.kind, created_at:new Date() })
  await submission.save()
  res.json({ status:'active', question:{ id:question.id, question:next.question, type:next.kind }, messages:submission.viva_messages })
}))
app.post('/api/assessments/:id/viva/modification', auth('student'), h(async (req: any, res: any) => {
  const A = await assignedAssessment(req)
  if (!A || !A.viva_enabled) return res.status(400).json({ error:'Practical viva is not enabled.' })
  const submission = await Submission.findOne({ assessment:A.id, student:req.user.id }).sort('-created_at')
  if (!submission || submission.viva_status !== 'modification') return res.status(400).json({ error:'Complete the viva questions first.' })
  const files = validateCodeFiles(req.body.files)
  submission.viva_modification_files = files; submission.viva_modification_submitted = true; submission.viva_status = 'completed'
  submission.viva_messages.push({ role:'student', question_id:'viva-modification', text:'Submitted code modification.', created_at:new Date() })
  await submission.save()
  const evaluation = await storeVivaEvaluation(submission, A)
  res.json({ status:'completed', evaluation, messages:submission.viva_messages })
}))
app.put('/api/assessments/:id/workspace', auth('student'), h(async (req: any, res: any) => {
  const A = await assignedAssessment(req)
  if (!A) return res.status(403).json({ error: 'Not assigned to you' })
  if (A.deadline && A.deadline < new Date()) return res.status(400).json({ error: 'The deadline has passed' })
  const files = validateCodeFiles(req.body.files)
  const existing = await Submission.findOne({ assessment: A.id, student: req.user.id }).sort('-created_at')
  if (existing?.status === 'submitted' && !A.allow_resubmit) return res.status(400).json({ error: 'Resubmission is not allowed' })
  const submission = existing && existing.status === 'workspace'
    ? await Submission.findByIdAndUpdate(existing.id, { code_files: files }, { new: true })
    : await Submission.create({ assessment: A.id, student: req.user.id, code_files: files, version: (existing?.version ?? 0) + 1, status: 'workspace' })
  res.json({ ok: true, submission })
}))
app.post('/api/assessments/:id/workspace/submit', auth('student'), h(async (req: any, res: any) => {
  const A = await assignedAssessment(req)
  if (!A) return res.status(403).json({ error: 'Not assigned to you' })
  if (A.deadline && A.deadline < new Date()) return res.status(400).json({ error: 'The deadline has passed' })
  const files = validateCodeFiles(req.body.files)
  const existing = await Submission.findOne({ assessment: A.id, student: req.user.id }).sort('-created_at')
  if (existing?.status === 'submitted' && !A.allow_resubmit) return res.status(400).json({ error: 'Resubmission is not allowed' })
  const submission = existing && existing.status === 'workspace'
    ? await Submission.findByIdAndUpdate(existing.id, { code_files: files, status: 'submitted' }, { new: true })
    : await Submission.create({ assessment: A.id, student: req.user.id, code_files: files, version: (existing?.version ?? 0) + 1, status: 'submitted' })
  await prepareViva(submission, A)
  if (A.theory_enabled) {
    submission.theory_questions = await generateTheoryQuestions(submission, A)
    submission.status = 'theory_pending'
    await submission.save()
    return res.json({ submission, evaluation: null })
  }
  const evaluation = await evaluateAndStore(submission, A)
  res.json({ submission, evaluation })
}))
app.post('/api/assessments/:id/workspace/run', auth('student'), h(async (req: any, res: any) => {
  if (!await assignedAssessment(req)) return res.status(403).json({ error: 'Not assigned to you' })
  const files = validateCodeFiles(req.body.files)
  const payload = JSON.stringify({ files, entrypoint: req.body.entrypoint || undefined, command: req.body.command || undefined, language: 'javascript' })
  const serviceUrl = process.env.EXECUTION_SERVICE_URL
  if (!serviceUrl) return res.status(503).json({ error: 'Secure execution is not configured. Set EXECUTION_SERVICE_URL to the isolated runner.' })
  const executionId = `${String(req.user.id)}-${Date.now()}`
  activeExecutions.set(String(req.user.id), executionId)
  let response: Response
  try {
    response = await fetch(serviceUrl, { method: 'POST', headers: { 'content-type': 'application/json', ...(process.env.EXECUTION_SERVICE_TOKEN ? { authorization: `Bearer ${process.env.EXECUTION_SERVICE_TOKEN}` } : {}) }, body: JSON.stringify({ ...JSON.parse(payload), executionId }), signal: AbortSignal.timeout(45000) })
  } catch (error: any) {
    return res.status(502).json({ error: `Execution service unavailable: ${error.message || 'connection failed'}`, status: 'runner_unavailable' })
  }
  const body: any = await response.json().catch(() => ({}))
  if (!response.ok) return res.status(502).json({ error: body.error || 'Execution service rejected the request', status: body.status || 'runner_error' })
  activeExecutions.delete(String(req.user.id))
  return res.json({ output: String(body.output || '').slice(0, 20000), error: String(body.error || '').slice(0, 20000), status: body.status || 'completed', exitCode: body.exitCode ?? null, durationMs: Number(body.durationMs) || 0 })
}))
app.post('/api/assessments/:id/workspace/stop', auth('student'), h(async (req: any, res: any) => {
  if (!await assignedAssessment(req)) return res.status(403).json({ error: 'Not assigned to you' })
  const executionId = activeExecutions.get(String(req.user.id))
  if (!executionId) return res.json({ ok: true, stopped: false })
  const serviceUrl = process.env.EXECUTION_SERVICE_URL
  if (!serviceUrl) return res.status(503).json({ error: 'Secure execution is not configured.' })
  try {
    const response = await fetch(`${serviceUrl.replace(/\/$/, '')}/${executionId}/stop`, { method: 'POST', headers: process.env.EXECUTION_SERVICE_TOKEN ? { authorization: `Bearer ${process.env.EXECUTION_SERVICE_TOKEN}` } : {}, signal: AbortSignal.timeout(5000) })
    const body = await response.json().catch(() => ({}))
    activeExecutions.delete(String(req.user.id))
    res.status(response.ok ? 200 : 502).json(body)
  } catch (error: any) {
    res.status(502).json({ error: `Execution service unavailable: ${error.message || 'connection failed'}` })
  }
}))
app.post('/api/assessments/:id/submissions', auth('student'), storage('submissions', true).single('file'), h(async (req: any, res: any) => {
  const fail = (code: number, error: string) => { if (req.file) fs.unlinkSync(req.file.path); return res.status(code).json({ error }) }
  const A = await Assessment.findById(req.params.id)
  if (!A || !(await Assignment.findOne({ assessment: A.id, student: req.user.id }))) return fail(403, 'Not assigned to you')
  if (A.deadline && A.deadline < new Date()) return fail(400, 'The deadline has passed')
  const prev = await Submission.findOne({ assessment: A.id, student: req.user.id }).sort('-created_at')
  if (prev && !A.allow_resubmit) return fail(400, 'Resubmission is not allowed')
  if (!req.file && !req.body.github_url) return fail(400, 'Upload a ZIP file or add a GitHub link')
  let file_id
  if (req.file) {
    const bucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: 'submissions' })
    const upload = bucket.openUploadStream(req.file.filename, { contentType: req.file.mimetype })
    await new Promise<void>((resolve, reject) => {
      upload.once('finish', resolve)
      upload.once('error', reject)
      upload.end(fs.readFileSync(req.file.path))
    })
    file_id = upload.id
    fs.unlinkSync(req.file.path)
  }
  const submission = await Submission.create({ assessment: A.id, student: req.user.id, file_id, github_url: req.body.github_url || undefined, version: (prev?.version ?? 0) + 1 })
  await prepareViva(submission, A)
  if (A.theory_enabled) {
    submission.theory_questions = await generateTheoryQuestions(submission, A)
    submission.status = 'theory_pending'
    await submission.save()
    return res.json({ submission, evaluation: null })
  }
  const evaluation = await evaluateAndStore(submission, A)
  res.json({ submission, evaluation })
}))

// ---------- Admin: submissions, AI evaluation, publishing ----------
app.get('/api/submissions', auth('admin'), h(async (_q: any, res: any) => {
  const subs = await Submission.find().sort('-created_at').populate('assessment', 'title max_marks').populate('student', 'full_name batch')
  const evs = await Evaluation.find({ submission: { $in: subs.map(s => s.id) } })
  res.json(subs.map(s => ({ ...s.toJSON(), total: evs.find(e => String(e.submission) === s.id)?.total }))) }))
app.get('/api/submissions/:id', auth('admin'), h(async (req: any, res: any) => {
  const submission = await Submission.findById(req.params.id).populate('assessment', 'title max_marks').populate('student', 'full_name email')
  res.json({ submission, evaluation: await Evaluation.findOne({ submission: req.params.id }) }) }))
app.get('/api/submissions/:id/download', auth('admin'), h(async (req: any, res: any) => {
  const s = await Submission.findById(req.params.id)
  if (!s) return res.status(404).json({ error: 'Submission not found' })
  if (s.zip_path && fs.existsSync(s.zip_path)) return res.download(path.resolve(s.zip_path))
  if (!s.file_id) return res.status(404).json({ error: 'No file' })
  const bucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: 'submissions' })
  res.setHeader('Content-Type', 'application/zip')
  res.setHeader('Content-Disposition', 'attachment; filename="submission.zip"')
  bucket.openDownloadStream(s.file_id).on('error', () => { if (!res.headersSent) res.status(404).json({ error: 'No file' }) }).pipe(res)
}))
app.post('/api/submissions/:id/evaluate', auth('admin'), h(async (req: any, res: any) => {
  const s = await Submission.findById(req.params.id); const A = await Assessment.findById(s!.assessment)
  if (!A!.rubric.length) return res.status(400).json({ error: 'Add rubric criteria to this assessment first' })
  try { await evaluateAndStore(s, A); res.json({ ok: true })
  } catch (e: any) { res.status(500).json({ error: e.message }) } }))
app.put('/api/submissions/:id/evaluation', auth('admin'), h(async (req: any, res: any) => {
  const b = req.body
  if (!Array.isArray(b.criteria)) return res.status(400).json({ error: 'Evaluation criteria are required' })
  const criteria = b.criteria.map((c: any) => ({ ...c, score: Math.min(Math.max(Number(c.score) || 0, 0), Number(c.max) || 0) }))
  const practical_total = criteria.reduce((t: number, c: any) => t + c.score, 0)
  const practical_max = criteria.reduce((t: number, c: any) => t + Number(c.max || 0), 0)
  const theory_criteria = Array.isArray(b.theory_criteria) ? b.theory_criteria.map((c: any) => ({ ...c, score: Math.min(Math.max(Number(c.score) || 0, 0), Number(c.max) || 0) })) : []
  const theory_total = theory_criteria.reduce((t: number, c: any) => t + c.score, 0)
  const theory_max = theory_criteria.reduce((t: number, c: any) => t + Number(c.max || 0), 0)
  const viva_criteria = Array.isArray(b.viva_criteria) ? b.viva_criteria.map((c: any) => ({ ...c, score: Math.min(Math.max(Number(c.score) || 0, 0), Number(c.max) || 0) })) : []
  const viva_total = viva_criteria.reduce((t: number, c: any) => t + c.score, 0)
  const viva_max = viva_criteria.reduce((t: number, c: any) => t + Number(c.max || 0), 0)
  const total = practical_total + theory_total + viva_total
  const max = practical_max + theory_max + viva_max
  const percentage = max ? total / max * 100 : 0
  const performance_level = percentage < 30 ? 'Basic' : percentage < 70 ? 'Average' : percentage < 85 ? 'Good' : 'Excellent'
  const ev = await Evaluation.findOneAndUpdate({ submission: req.params.id }, { criteria, total, max, practical_total, practical_max, theory_criteria, theory_total, theory_max, viva_criteria, viva_total, viva_max, performance_level,
    strengths: b.strengths, weaknesses: b.weaknesses, suggestions: b.suggestions, mentor_recommendations: b.mentor_recommendations,
    summary: b.summary, status: b.publish ? 'published' : 'draft' }, { new: true })
  await Submission.findByIdAndUpdate(req.params.id, { status: b.publish ? 'published' : 'review' }); res.json(ev) }))

app.use((e: any, _q: any, res: any, _n: any) => { console.error(e); res.status(500).json({ error: e.message || 'Server error' }) })

if (!process.env.VERCEL) {
  connectDatabase().then(() => app.listen(process.env.PORT || 5000, () => console.log('API on :' + (process.env.PORT || 5000))))
    .catch(error => { console.error('Database connection failed:', error); process.exitCode = 1 })
}

export default app
