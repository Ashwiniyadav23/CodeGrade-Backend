import mongoose, { Schema, model } from 'mongoose'
// Expose `id` instead of `_id`, and never leak password hashes.
mongoose.set('toJSON', { virtuals: false, transform: (_d: any, r: any) => { r.id = String(r._id); delete r._id; delete r.__v; delete r.password_hash; return r } })
const ref = (m: string) => ({ type: Schema.Types.ObjectId, ref: m })
const userSchema = new Schema({ full_name: String, email: { type: String, unique: true, lowercase: true }, password_hash: String, role: { type: String, enum: ['admin', 'student'], default: 'student' }, batch: String })
userSchema.index({ role: 1, full_name: 1 })
export const User = model('User', userSchema)
export const Assessment = model('Assessment', new Schema({
  title: String, description: { type: String, default: '' }, language: String, difficulty: String, deadline: Date, max_marks: { type: Number, default: 0 },
  allow_resubmit: { type: Boolean, default: false }, starter_url: String, questions: { type: Array, default: [] }, rubric: { type: Array, default: [] }, created_by: ref('User'), created_at: { type: Date, default: Date.now } }))
const asg = new Schema({ assessment: ref('Assessment'), student: ref('User') }); asg.index({ assessment: 1, student: 1 }, { unique: true }); asg.index({ student: 1, assessment: 1 })
export const Assignment = model('Assignment', asg)
const submissionSchema = new Schema({ assessment: ref('Assessment'), student: ref('User'), zip_path: String, file_id: Schema.Types.ObjectId, github_url: String, version: { type: Number, default: 1 },
  status: { type: String, enum: ['submitted', 'evaluating', 'review', 'published'], default: 'submitted' }, created_at: { type: Date, default: Date.now } })
submissionSchema.index({ assessment: 1, student: 1, created_at: -1 })
submissionSchema.index({ created_at: -1 })
export const Submission = model('Submission', submissionSchema)
export const Evaluation = model('Evaluation', new Schema({ submission: { ...ref('Submission'), unique: true }, criteria: { type: Array, default: [] }, total: Number, max: Number,
  strengths: [String], weaknesses: [String], suggestions: [String], mentor_recommendations: String, performance_level: String, summary: String,
  status: { type: String, enum: ['draft', 'published'], default: 'draft' } }))
