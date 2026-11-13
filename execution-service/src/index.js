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
const allowedCommands = /^(node|npm|ls|pwd|cat)(\s[\w@./-]+)*$/
const serviceToken = process.env.EXECUTION_SERVICE_TOKEN
const activeRuns = new Map()
const allowedPackages = new Set((process.env.EXECUTION_ALLOWED_PACKAGES || 'express,mongoose,bcryptjs,jsonwebtoken,cors,multer,dotenv').split(',').map(value => value.trim()).filter(Boolean))
app.disable('x-powered-by')
app.use(express.json({ limit: `${maxBody}b` }))
app.use((req, res, next) => {
  if (serviceToken && req.path.startsWith('/execute') && req.headers.authorization !== `Bearer ${serviceToken}`) return fail(res, 401, 'Unauthorized', 'UNAUTHORIZED')
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
  if (command && (!allowedCommands.test(command) || /(^|\s)(npm\s+(uninstall|update|run|exec|link|root)|node\s+--require|cat\s+\/)/.test(command))) throw new Error('Only node, npm install, npm start, ls, pwd, and cat project-file commands are permitted.')
  if (body.dependencies && (typeof body.dependencies !== 'object' || Array.isArray(body.dependencies))) throw new Error('Dependencies must be an object.')
  return { files, entrypoint, command }
}

const runDocker = (args, input, timeout = timeoutMs, executionId) => new Promise((resolve, reject) => {
  const child = spawn('docker', args, { env: { PATH: process.env.PATH || '' } })
  if (executionId) activeRuns.set(executionId, child)
  let output = ''; let error = ''; let timedOut = false
  const append = (current, chunk) => (current + chunk.toString()).slice(-maxOutput)
  child.stdout.on('data', chunk => { output = append(output, chunk) })
  child.stderr.on('data', chunk => { error = append(error, chunk) })
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, timeout)
  child.once('error', reject)
  child.once('close', exitCode => { clearTimeout(timer); if (executionId) activeRuns.delete(executionId); resolve({ output, error, exitCode, timedOut }) })
  child.stdin.end(input || undefined)
})

const runContainer = async ({ files, entrypoint, command, executionId }) => {
  const volume = `codegrade-${crypto.randomUUID()}`
  const manifest = files.find(file => file.path === 'package.json')
  let dependencies = {}
  if (manifest) {
    try { dependencies = { ...(JSON.parse(manifest.content).dependencies || {}), ...(JSON.parse(manifest.content).devDependencies || {}) } } catch { throw new Error('package.json is not valid JSON.') }
  }
  const requestedPackages = Object.keys(dependencies)
  const disallowed = requestedPackages.filter(name => !allowedPackages.has(name))
  if (disallowed.length) throw new Error(`Dependencies not permitted: ${disallowed.join(', ')}. Add them to EXECUTION_ALLOWED_PACKAGES.`)
  const invalidVersions = requestedPackages.filter(name => typeof dependencies[name] !== 'string' || !/^[~^]?\d+(\.\d+){0,2}([-+][0-9A-Za-z.-]+)?$/.test(dependencies[name]))
  if (invalidVersions.length) throw new Error(`Dependencies must use pinned numeric versions: ${invalidVersions.join(', ')}`)
  const filesPayload = JSON.stringify({ files })
  const setupScript = `const fs=require('fs'),path=require('path'),d=JSON.parse(fs.readFileSync(0,'utf8'));for(const f of d.files){const p=path.join('/workspace',f.path);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,f.content)};${requestedPackages.length ? "require('child_process').execFileSync('npm',['install','--ignore-scripts','--no-audit','--no-fund','--package-lock=false'],{cwd:'/workspace',stdio:'inherit'})" : ''}`
  const args = [
    'run', '--rm', '--network', 'bridge', '--cpus', '0.5', '--memory', '256m',
    '--pids-limit', '64', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--mount', `source=${volume},target=/workspace`, '-i', images.javascript,
    'node', '-e', setupScript,
  ]
  const started = Date.now()
  try {
    const setup = await runDocker(args, filesPayload, 30_000)
    if (setup.exitCode !== 0 || setup.timedOut) return { output: setup.output, error: setup.error || 'Dependency setup failed.', exitCode: setup.exitCode, durationMs: Date.now() - started, status: setup.timedOut ? 'timeout' : 'setup_error', executionId }
    if (command === 'npm install' || command === 'npm i') return { output: setup.output || 'Dependencies installed.', error: setup.error, exitCode: 0, durationMs: Date.now() - started, status: 'completed', executionId }
    const requested = command || `node ${entrypoint}`
    const containerCommand = requested.replace(/(^| )([\w./-]+\.js)(?= |$)/g, '$1/workspace/$2')
    const runtimeArgs = [
      'run', '--rm', '--network', 'none', '--cpus', '0.5', '--memory', '256m',
      '--pids-limit', '64', '--read-only', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges', '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',
      '--mount', `source=${volume},target=/workspace,readonly`, '-w', '/workspace', images.javascript,
      'sh', '-c', containerCommand,
    ]
    const result = await runDocker(runtimeArgs, null, timeoutMs, executionId)
    return { ...result, executionId, durationMs: Date.now() - started, status: result.timedOut ? 'timeout' : result.exitCode === 0 ? 'completed' : 'runtime_error' }
  } catch (error) {
    return { output: '', error: error.message || 'Docker execution failed', exitCode: null, durationMs: Date.now() - started, status: 'runner_error', executionId }
  } finally {
    await runDocker(['volume', 'rm', '-f', volume], null, 5_000).catch(() => undefined)
  }
}

app.get('/health', (_req, res) => res.json({ ok: true, service: 'codegrade-execution-service' }))
app.post('/execute', async (req, res) => {
  try {
    const input = validate(req.body)
    res.json(await runContainer({ ...input, executionId: req.body.executionId || crypto.randomUUID() }))
  } catch (error) {
    fail(res, 400, error.message)
  }
})
app.post('/execute/:id/stop', (req, res) => {
  const child = activeRuns.get(req.params.id)
  if (!child) return res.json({ ok: true, stopped: false })
  child.kill('SIGKILL')
  res.json({ ok: true, stopped: true })
})
app.listen(port, '0.0.0.0', () => console.log(`Execution service on :${port}`))
