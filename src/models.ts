import mongoose, { Schema, model } from 'mongoose'
// Expose `id` instead of `_id`, and never leak password hashes.
mongoose.set('toJSON', { virtuals: false, transform: (_d: any, r: any) => { r.id = String(r._id); delete r._id; delete r.__v; delete r.password_hash; return r } })
const ref = (m: string) => ({ type: Schema.Types.ObjectId, ref: m })
const userSchema = new Schema({ full_name: String, email: { type: String, unique: true, lowercase: true }, password_hash: String, role: { type: String, enum: ['admin', 'student'], default: 'student' }, batch: String })
userSchema.index({ role: 1, full_name: 1 })
export const User = model('User', userSchema)
export const Assessment = model('Assessment', new Schema({
  title: String, description: { type: String, default: '' }, language: String, difficulty: String, deadline: Date, max_marks: { type: Number, default: 0 },
  allow_resubmit: { type: Boolean, default: false }, theory_enabled: { type: Boolean, default: false }, theory_question_count: { type: Number, default: 5 },
  practical_marks: { type: Number, default: 70 }, theory_marks: { type: Number, default: 30 }, viva_enabled: { type: Boolean, default: false },
  viva_question_count: { type: Number, default: 5 }, viva_marks: { type: Number, default: 20 }, viva_difficulty: { type: String, default: 'Medium' },
  starter_url: String, questions: { type: Array, default: [] }, rubric: { type: Array, default: [] }, created_by: ref('User'), created_at: { type: Date, default: Date.now } }))
const asg = new Schema({ assessment: ref('Assessment'), student: ref('User') }); asg.index({ assessment: 1, student: 1 }, { unique: true }); asg.index({ student: 1, assessment: 1 })
export const Assignment = model('Assignment', asg)
const submissionSchema = new Schema({ assessment: ref('Assessment'), student: ref('User'), zip_path: String, file_id: Schema.Types.ObjectId, github_url: String, version: { type: Number, default: 1 },
  code_files: { type: Array, default: [] }, theory_questions: { type: Array, default: [] }, theory_answers: { type: Array, default: [] }, theory_submitted: { type: Boolean, default: false },
  viva_questions: { type: Array, default: [] }, viva_messages: { type: Array, default: [] }, viva_question_index: { type: Number, default: 0 },
  viva_status: { type: String, enum: ['not_started', 'active', 'modification', 'completed'], default: 'not_started' },
  viva_modification_task: String, viva_modification_files: { type: Array, default: [] }, viva_modification_submitted: { type: Boolean, default: false },
  status: { type: String, enum: ['workspace', 'submitted', 'theory_pending', 'evaluating', 'review', 'published'], default: 'workspace' }, created_at: { type: Date, default: Date.now } })
submissionSchema.index({ assessment: 1, student: 1, created_at: -1 })
submissionSchema.index({ created_at: -1 })
export const Submission = model('Submission', submissionSchema)
export const Evaluation = model('Evaluation', new Schema({ submission: { ...ref('Submission'), unique: true }, criteria: { type: Array, default: [] }, total: Number, max: Number,
  practical_total: Number, practical_max: Number, theory_criteria: { type: Array, default: [] }, theory_total: Number, theory_max: Number,
  viva_criteria: { type: Array, default: [] }, viva_total: Number, viva_max: Number,
  strengths: [String], weaknesses: [String], suggestions: [String], mentor_recommendations: String, performance_level: String, summary: String,
  status: { type: String, enum: ['draft', 'published'], default: 'draft' } }))
