import crypto from 'crypto'
import express from 'express'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'

const app = express()
const port = Number(process.env.PORT || 4001)
const maxBody = 1_000_000
const timeoutMs = Number(process.env.EXECUTION_TIMEOUT_MS || 10_000)
const maxOutput = 20_000
const images = { javascript: process.env.JAVASCRIPT_RUNNER_IMAGE || 'node:22-alpine' }
const allowedCommands = /^(node|ls|pwd|cat)(\s[\w./-]+)?$/
const serviceToken = process.env.EXECUTION_SERVICE_TOKEN
app.disable('x-powered-by')
app.use(express.json({ limit: `${maxBody}b` }))
app.use((req, res, next) => {
  if (serviceToken && req.path === '/execute' && req.headers.authorization !== `Bearer ${serviceToken}`) return fail(res, 401, 'Unauthorized', 'UNAUTHORIZED')
  next()
})

const fail = (res, status, error, code = 'INVALID_REQUEST') => res.status(status).json({ status: 'failed', error, code })
const validate = body => {
  if (!body || body.language !== 'javascript') throw new Error('Only JavaScript execution is currently supported.')
  if (!Array.isArray(body.files) || body.files.length < 1 || body.files.length > 30) throw new Error('Provide between 1 and 30 project files.')
  const files = body.files.map(file => {
    if (!file || typeof file.path !== 'string' || typeof file.content !== 'string') throw new Error('Every file needs a path and string content.')
    const filePath = path.posix.normalize(file.path.replaceAll('\\', '/'))
    if (!filePath || filePath.startsWith('/') || filePath.startsWith('../') || filePath.includes('/../')) throw new Error('Invalid project file path.')
    if (file.content.length > 200_000) throw new Error('Each project file must be smaller than 200 KB.')
    return { path: filePath, content: file.content }
  })
  if (files.reduce((sum, file) => sum + file.content.length, 0) > maxBody) throw new Error('Project is too large.')
  const entrypoint = String(body.entrypoint || files.find(file => /\.(js|mjs|cjs)$/.test(file.path))?.path || '')
  if (!entrypoint || !files.some(file => file.path === entrypoint)) throw new Error('A JavaScript entrypoint is required.')
  const command = String(body.command || '').trim()
  if (command && !allowedCommands.test(command)) throw new Error('Only node, ls, pwd, and cat commands are permitted.')
  if (body.dependencies && (typeof body.dependencies !== 'object' || Array.isArray(body.dependencies))) throw new Error('Dependencies must be an object.')
  return { files, entrypoint, command }
}

const runContainer = async ({ files, entrypoint, command }) => {
  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'codegrade-run-'))
  for (const file of files) {
    const target = path.join(workdir, file.path)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, file.content, 'utf8')
  }
  const requested = command || `node ${entrypoint}`
  const containerCommand = requested.replace(/(^| )([\w./-]+\.js)(?= |$)/g, '$1/workspace/$2')
  const args = [
    'run', '--rm', '--network', 'none', '--cpus', '0.5', '--memory', '256m',
    '--pids-limit', '64', '--read-only', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges', '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',
    '-v', `${workdir}:/workspace:ro`, '-w', '/workspace', images.javascript,
    'sh', '-c', containerCommand,
  ]
  const started = Date.now()
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn('docker', args, { env: { PATH: process.env.PATH || '' } })
      let output = ''; let error = ''; let timedOut = false
      const append = (current, chunk) => (current + chunk.toString()).slice(-maxOutput)
      child.stdout.on('data', chunk => { output = append(output, chunk) })
      child.stderr.on('data', chunk => { error = append(error, chunk) })
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, timeoutMs)
      child.once('error', reject)
      child.once('close', exitCode => { clearTimeout(timer); resolve({ output, error, exitCode, timedOut }) })
    })
    return { ...result, durationMs: Date.now() - started, status: result.timedOut ? 'timeout' : result.exitCode === 0 ? 'completed' : 'runtime_error' }
  } catch (error) {
    return { output: '', error: error.message || 'Docker execution failed', exitCode: null, durationMs: Date.now() - started, status: 'runner_error' }
  } finally {
    await fs.rm(workdir, { recursive: true, force: true })
  }
}

app.get('/health', (_req, res) => res.json({ ok: true, service: 'codegrade-execution-service' }))
app.post('/execute', async (req, res) => {
  try {
    const input = validate(req.body)
    res.json(await runContainer(input))
  } catch (error) {
    fail(res, 400, error.message)
  }
})
app.listen(port, '0.0.0.0', () => console.log(`Execution service on :${port}`))
