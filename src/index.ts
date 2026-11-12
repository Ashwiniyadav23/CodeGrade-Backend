import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import mongoose from 'mongoose'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import multer from 'multer'
import path from 'path'
import fs from 'fs'
import { User, Assessment, Assignment, Submission, Evaluation } from './models'
import { evaluateSubmission } from './ai'

const SECRET = process.env.JWT_SECRET || 'dev-secret'
const frontendOrigins = (process.env.FRONTEND_ORIGIN || 'http://localhost:5173,http://localhost:5174,http://localhost:5175')
  .split(',').map(origin => origin.trim()).filter(Boolean)
const app = express(); app.disable('x-powered-by'); app.use(cors({
  origin: (origin, callback) => callback(null, !origin || frontendOrigins.includes(origin)),
  methods: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
})); app.options('*', cors()); app.use(express.json({ limit: '5mb' }))
app.use((_req, res, next) => { res.setTimeout(180000, () => { if (!res.headersSent) res.status(504).json({ error: 'Request timed out' }) }); next() })
const h = (fn: any) => (req: any, res: any, next: any) => Promise.resolve(fn(req, res, next)).catch(next)
const sign = (u: any) => jwt.sign({ id: u.id }, SECRET, { expiresIn: '7d' })
const auth = (...roles: string[]) => async (req: any, res: any, next: any) => {
  try { const { id } = jwt.verify((req.headers.authorization || '').replace('Bearer ', ''), SECRET) as any; const u = await User.findById(id); if (!u) throw 0
    if (roles.length && !roles.includes(u.role)) return res.status(403).json({ error: 'Forbidden' }); req.user = u; next() } catch { res.status(401).json({ error: 'Unauthorized' }) } }
const storage = (dir: string, zipOnly: boolean) => multer({ limits: { fileSize: 50 * 1024 * 1024 },
  storage: multer.diskStorage({ destination: `uploads/${dir}`, filename: (req: any, f, cb) => cb(null, `${req.user.id}-${Date.now()}${path.extname(f.originalname)}`) }),
  fileFilter: (_r, f, cb) => cb(null, !zipOnly || f.originalname.toLowerCase().endsWith('.zip')) })

app.use('/uploads/starters', express.static('uploads/starters'))   // starter files are public; submissions are not
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
  subs.forEach(s => s.zip_path && fs.existsSync(s.zip_path) && fs.unlinkSync(s.zip_path))
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
app.post('/api/assessments/:id/submissions', auth('student'), storage('submissions', true).single('file'), h(async (req: any, res: any) => {
  const fail = (code: number, error: string) => { if (req.file) fs.unlinkSync(req.file.path); return res.status(code).json({ error }) }
  const A = await Assessment.findById(req.params.id)
  if (!A || !(await Assignment.findOne({ assessment: A.id, student: req.user.id }))) return fail(403, 'Not assigned to you')
  if (A.deadline && A.deadline < new Date()) return fail(400, 'The deadline has passed')
  const prev = await Submission.findOne({ assessment: A.id, student: req.user.id }).sort('-created_at')
  if (prev && !A.allow_resubmit) return fail(400, 'Resubmission is not allowed')
  if (!req.file && !req.body.github_url) return fail(400, 'Upload a ZIP file or add a GitHub link')
  res.json(await Submission.create({ assessment: A.id, student: req.user.id, zip_path: req.file?.path, github_url: req.body.github_url || undefined, version: (prev?.version ?? 0) + 1 })) }))

// ---------- Admin: submissions, AI evaluation, publishing ----------
app.get('/api/submissions', auth('admin'), h(async (_q: any, res: any) => {
  const subs = await Submission.find().sort('-created_at').populate('assessment', 'title max_marks').populate('student', 'full_name batch')
  const evs = await Evaluation.find({ submission: { $in: subs.map(s => s.id) } })
  res.json(subs.map(s => ({ ...s.toJSON(), total: evs.find(e => String(e.submission) === s.id)?.total }))) }))
app.get('/api/submissions/:id', auth('admin'), h(async (req: any, res: any) => {
  const submission = await Submission.findById(req.params.id).populate('assessment', 'title max_marks').populate('student', 'full_name email')
  res.json({ submission, evaluation: await Evaluation.findOne({ submission: req.params.id }) }) }))
app.get('/api/submissions/:id/download', auth('admin'), h(async (req: any, res: any) => {
  const s = await Submission.findById(req.params.id); if (!s?.zip_path) return res.status(404).json({ error: 'No file' }); res.download(path.resolve(s.zip_path)) }))
app.post('/api/submissions/:id/evaluate', auth('admin'), h(async (req: any, res: any) => {
  const s = await Submission.findById(req.params.id); const A = await Assessment.findById(s!.assessment)
  if (!A!.rubric.length) return res.status(400).json({ error: 'Add rubric criteria to this assessment first' })
  s!.status = 'evaluating'; await s!.save()
  try { const r = await evaluateSubmission(s, A)
    await Evaluation.findOneAndUpdate({ submission: s!.id }, { ...r, status: 'draft' }, { upsert: true }); s!.status = 'review'; await s!.save(); res.json({ ok: true })
  } catch (e: any) { s!.status = 'submitted'; await s!.save(); res.status(500).json({ error: e.message }) } }))
app.put('/api/submissions/:id/evaluation', auth('admin'), h(async (req: any, res: any) => {
  const b = req.body, criteria = b.criteria.map((c: any) => ({ ...c, score: Math.min(Math.max(Number(c.score) || 0, 0), c.max) }))
  const ev = await Evaluation.findOneAndUpdate({ submission: req.params.id }, { criteria, total: criteria.reduce((t: number, c: any) => t + c.score, 0), strengths: b.strengths, weaknesses: b.weaknesses,
    suggestions: b.suggestions, summary: b.summary, status: b.publish ? 'published' : 'draft' }, { new: true })
  await Submission.findByIdAndUpdate(req.params.id, { status: b.publish ? 'published' : 'review' }); res.json(ev) }))

app.use((e: any, _q: any, res: any, _n: any) => { console.error(e); res.status(500).json({ error: e.message || 'Server error' }) })
mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/codegrade', {
  maxPoolSize: Number(process.env.MONGO_MAX_POOL_SIZE || 100),
  minPoolSize: Number(process.env.MONGO_MIN_POOL_SIZE || 10),
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS: 180000,
}).then(() => app.listen(process.env.PORT || 5000, () => console.log('API on :' + (process.env.PORT || 5000))))
