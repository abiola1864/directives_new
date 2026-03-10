'use strict';
// ============================================================
// CBN Directives Management Platform — server.js
// ============================================================

require('dotenv').config();

const express    = require('express');
const mongoose   = require('mongoose');
const cors       = require('cors');
const { google } = require('googleapis');
const cron       = require('node-cron');
const sgMail     = require('@sendgrid/mail');
const multer     = require('multer');
const crypto     = require('crypto');
const fs         = require('fs');
const path       = require('path');
const bcrypt     = require('bcrypt');

const app  = express();
const PORT = process.env.PORT || 3001;

// ─── Middleware ──────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static('public'));
app.use('/assets',  express.static(path.join(__dirname, 'assets')));
app.use('/uploads', express.static('uploads'));

// ─── MongoDB ─────────────────────────────────────────────────
const MONGODB_URI = process.env.MONGODB_URI ||
  'mongodb+srv://oyebanjoabiola_db_user:83kDNVz6CN6sGUsv@cluster0.mkj92f1.mongodb.net/cbn_directives?retryWrites=true&w=majority';

mongoose.connect(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(()  => console.log('✅ MongoDB Connected'))
  .catch(err => console.error('❌ MongoDB Error:', err));

// ─── File Upload ─────────────────────────────────────────────
const storage = multer.diskStorage({
  destination(req, file, cb) {
    const dir = `./uploads/${req.params.id || 'temp'}`;
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename(req, file, cb) {
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}-${file.originalname}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    const ok = [
      'application/pdf', 'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'image/png', 'image/jpeg'
    ];
    cb(null, ok.includes(file.mimetype));
  }
}).array('files', 5);

// ============================================================
// SCHEMAS
// ============================================================

// ─── Decision (formerly "Outcome") ───────────────────────────
const decisionSchema = new mongoose.Schema({
  text:               { type: String, required: true },
  status: {
    type:    String,
    enum:    ['Not Implemented', 'Being Implemented', 'Implemented', 'No Response'],
    default: 'Not Implemented'
  },
  completionDetails:  String,
  delayReason:        String,
  challenges:         String,
  impliedDeadline:    String,
  impliedAmount:      String,
  impliedResponsible: String
});

const statusHistorySchema = new mongoose.Schema({
  status:    String,
  changedAt: { type: Date, default: Date.now },
  changedBy: String,
  notes:     String
});

const reminderHistorySchema = new mongoose.Schema({
  sentAt:       { type: Date, default: Date.now },
  recipient:    String,
  method:       { type: String, enum: ['Email', 'System'], default: 'Email' },
  acknowledged: { type: Boolean, default: false }
});

// ─── Directive ───────────────────────────────────────────────
const directiveSchema = new mongoose.Schema({
  source:      { type: String, required: true, enum: ['CG', 'Board'] },
  sheetName:   { type: String, required: true },
  meetingDate: { type: Date, required: true },
  subject:     { type: String, required: true },
  particulars: { type: String, required: true },

  // "Business Unit" in UI — kept as "owner" in DB for backward compat
  owner:       { type: String, required: true },

  // Department for access-control (links to Department collection)
  department:  { type: String, default: '' },

  // Emails
  primaryEmail:  { type: String, default: '' },
  inCopy:        [{ type: String }],         // Multiple CC addresses
  secondaryEmail:{ type: String, default: '' }, // Backward compat → maps to inCopy[0]

  // Financial — vendor always after amount
  amount: String,
  vendor: String,

  implementationStartDate: Date,
  implementationEndDate:   Date,
  implementationStatus:    { type: String, default: 'Not Implemented' },
  additionalComments:      { type: String, default: '' },

  ref: { type: String, unique: true, sparse: true },

  monitoringStatus: {
    type:    String,
    enum:    ['On Track', 'At Risk', 'High Risk', 'Completed', 'Needs Timeline'],
    default: 'On Track'
  },

  statusHistory:    [statusHistorySchema],
  reminders:        { type: Number, default: 0 },
  lastReminderDate: Date,
  lastSbuUpdate:    Date,
  reminderHistory:  [reminderHistorySchema],
  isResponsive:     { type: Boolean, default: true },
  lastResponseDate: Date,
  completionNote:   String,

  // Field name kept as "outcomes" for DB/API backward compatibility
  outcomes: [decisionSchema],

  attachments: [{
    filename:    String,
    originalName:String,
    mimetype:    String,
    size:        Number,
    path:        String,
    uploadedAt:  { type: Date, default: Date.now },
    uploadedBy:  String
  }],

  updateHistory: [{
    timestamp:       { type: Date, default: Date.now },
    source:          { type: String, enum: ['reminder-link', 'self-initiated', 'admin'], default: 'reminder-link' },
    updatedBy:       String,
    decisionChanges: Number,
    comment:         String
  }],

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
  updatedBy: String
});

// Auto-generate ref: CG/JAN/001/2025
directiveSchema.pre('save', async function (next) {
  if (!this.ref && this.meetingDate) {
    const prefix = this.source === 'CG' ? 'CG' : 'BD';
    const month  = this.meetingDate.toLocaleString('en-US', { month: 'short' }).toUpperCase();
    const year   = this.meetingDate.getFullYear();

    const existing = await mongoose.model('Directive').find({
      ref: new RegExp(`^${prefix}\\/${month}\\/\\d+\\/${year}$`)
    }).select('ref');

    const nums  = existing.map(d => { const m = d.ref.match(/\/(\d+)\//); return m ? +m[1] : 0; });
    const nextN = nums.length ? Math.max(...nums) + 1 : 1;
    this.ref    = `${prefix}/${month}/${String(nextN).padStart(3, '0')}/${year}`;
  }
  // Keep secondaryEmail ↔ inCopy[0] in sync
  if (this.secondaryEmail && this.inCopy && !this.inCopy.includes(this.secondaryEmail)) {
    this.inCopy.unshift(this.secondaryEmail);
  }
  this.updatedAt = Date.now();
  next();
});

directiveSchema.methods.updateMonitoringStatus = function (notes = '') {
  const old     = this.monitoringStatus;
  const allDone = this.outcomes.length > 0 && this.outcomes.every(o => o.status === 'Implemented');

  if (allDone || this.implementationStatus === 'Implemented') {
    this.monitoringStatus = 'Completed';
    this.isResponsive     = true;
  } else if (!this.implementationEndDate) {
    this.monitoringStatus = 'Needs Timeline';
    if (this.reminders >= 2 &&
        (!this.lastSbuUpdate || (this.lastReminderDate && this.lastSbuUpdate < this.lastReminderDate)))
      this.isResponsive = false;
  } else {
    const days = Math.ceil((this.implementationEndDate - new Date()) / 86400000);
    if      (days <= 7)                        this.monitoringStatus = 'High Risk';
    else if (days < 30 || this.reminders >= 3) this.monitoringStatus = 'At Risk';
    else                                       this.monitoringStatus = 'On Track';

    if (this.reminders >= 3 &&
        (!this.lastSbuUpdate || (this.lastReminderDate && this.lastSbuUpdate < this.lastReminderDate)))
      this.isResponsive = false;
    else if (this.lastSbuUpdate && this.lastSbuUpdate > (this.lastReminderDate || this.createdAt))
      this.isResponsive = true;
  }

  if (old !== this.monitoringStatus)
    this.statusHistory.push({ status: this.monitoringStatus, changedAt: new Date(), notes: notes || `${old} → ${this.monitoringStatus}` });

  return this.save();
};

directiveSchema.methods.isReminderDue = function () {
  if (this.monitoringStatus === 'Completed' || this.reminders >= 3) return false;
  const today = new Date();
  if (this.implementationEndDate && this.implementationStartDate) {
    const total    = Math.ceil((this.implementationEndDate - this.implementationStartDate) / 86400000);
    const interval = Math.floor(total / 3);
    const elapsed  = Math.ceil((today - this.implementationStartDate) / 86400000);
    if (this.reminders === 0 && elapsed >= interval)     return true;
    if (this.reminders === 1 && elapsed >= interval * 2) return true;
    if (this.reminders === 2 && elapsed >= total)        return true;
  } else {
    const days = Math.ceil((today - this.createdAt) / 86400000);
    if (this.reminders === 0 && days >= 30) return true;
    if (this.reminders === 1 && days >= 60) return true;
    if (this.reminders === 2 && days >= 90) return true;
  }
  return false;
};

const Directive = mongoose.model('Directive', directiveSchema);

// ─── Submission Token ─────────────────────────────────────────
const SubmissionToken = mongoose.model('SubmissionToken', new mongoose.Schema({
  token:            { type: String, required: true, unique: true },
  directiveId:      { type: mongoose.Schema.Types.ObjectId, ref: 'Directive', required: true },
  selectedOutcomes: [{ type: Number }],
  createdAt:        { type: Date, default: Date.now },
  expiresAt:        Date,
  used:             { type: Boolean, default: false },
  usedAt:           Date
}));

// ─── Department (max 3 business units) ───────────────────────
const Department = mongoose.model('Department', new mongoose.Schema({
  name:       { type: String, required: true, unique: true, trim: true },
  code:       { type: String, trim: true },
  // NEW: stores the actual responsible person's name and title
  personName: { type: String, default: '' },
  position:   { type: String, default: '' },
  isActive:   { type: Boolean, default: true },
  createdAt:  { type: Date, default: Date.now }
}));



// ─── OTP for 2FA ─────────────────────────────────────────────
const OtpSchema = new mongoose.Schema({
  email:     { type: String, required: true },
  otpHash:   { type: String, required: true },
  expiresAt: { type: Date,   required: true },
  used:      { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});
OtpSchema.index({ email: 1 });
OtpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
const Otp = mongoose.model('Otp', OtpSchema);

// ─── Reminder Settings ────────────────────────────────────────
const ReminderSettings = mongoose.model('ReminderSettings', new mongoose.Schema({
  enabled: { type: Boolean, default: true },
  statusSettings: {
    'On Track':  { type: Boolean, default: true },
    'At Risk':   { type: Boolean, default: true },
    'High Risk': { type: Boolean, default: true }
  },
  updatedAt: { type: Date, default: Date.now }
}));

// ─── Process Owner ────────────────────────────────────────────
const ProcessOwnerSchema = new mongoose.Schema({
  name:       { type: String, required: true, trim: true },
  email:      { type: String, required: true, unique: true, lowercase: true, trim: true },
  password:   String,
  department: String,
  position:   String,
  phone:      String,
  isActive:   { type: Boolean, default: true },
  passwordSetupToken:   String,
  passwordSetupExpires: Date,
  passwordResetToken:   String,
  passwordResetExpires: Date,
  createdBy:            String,
  createdAt:            { type: Date, default: Date.now },
  passwordSetAt:        Date,
  lastLogin:            Date,
  failedLoginAttempts:  { type: Number, default: 0 },
  accountLockedUntil:   Date
});

ProcessOwnerSchema.pre('save', async function (next) {
  if (!this.isModified('password') || !this.password) return next();
  const salt  = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});
ProcessOwnerSchema.methods.comparePassword = async function (p) {
  if (!this.password) return false;
  return bcrypt.compare(p, this.password);
};
ProcessOwnerSchema.methods.isLocked = function () {
  return !!(this.accountLockedUntil && this.accountLockedUntil > Date.now());
};

const ProcessOwner = mongoose.model('ProcessOwner', ProcessOwnerSchema);

// ============================================================
// EMAIL SETUP
// ============================================================

let emailTransporter = null;

function setupEmail() {
  if (!process.env.SENDGRID_API_KEY || !process.env.EMAIL_USER) {
    console.log('⚠️  Email not configured (SENDGRID_API_KEY / EMAIL_USER missing)');
    return;
  }

   // ADD THIS LINE temporarily:
  console.log('🔑 SendGrid key starts with:', process.env.SENDGRID_API_KEY.substring(0, 6));
  console.log('📧 Sender email:', process.env.EMAIL_USER);


  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
  emailTransporter = {
    sendMail: async opts => {
      const msg = {
        to:      opts.to,
        from:    process.env.EMAIL_USER,
        subject: opts.subject,
        html:    opts.html
      };
      if (opts.cc) msg.cc = opts.cc;
      const res = await sgMail.send(msg);
      console.log('✅ Email sent:', opts.to);
      return res;
    }
  };
  console.log('✅ SendGrid configured');
}
setupEmail();

// ─── OTP Helper ──────────────────────────────────────────────
async function sendOtp(email, name) {
  const code    = String(Math.floor(100000 + Math.random() * 900000));
  const hash    = await bcrypt.hash(code, 10);
  const expires = new Date(Date.now() + 10 * 60 * 1000);
  await Otp.deleteMany({ email });
  await new Otp({ email, otpHash: hash, expiresAt: expires }).save();

  if (emailTransporter) {
    try {
      await emailTransporter.sendMail({
        to:      email,
        subject: 'Your CBN Directives Login Code',
        html: `
        <div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;padding:32px;
                    background:#fff;border-radius:12px;border:1px solid #e5e7eb;">
          <h2 style="color:#1B5E20;margin-top:0;">🔐 Two-Factor Authentication</h2>
          <p style="color:#374151;">Dear <strong>${name || email}</strong>,</p>
          <p style="color:#374151;">Your one-time login code is:</p>
          <div style="text-align:center;margin:24px 0;">
            <span style="font-size:36px;font-weight:700;letter-spacing:8px;color:#1B5E20;
                         background:#E8F5E9;padding:16px 24px;border-radius:8px;">${code}</span>
          </div>
          <p style="color:#6b7280;font-size:13px;">
            Expires in <strong>10 minutes</strong>. Do not share this code with anyone.
          </p>
          <p style="color:#9ca3af;font-size:11px;">
            If you did not attempt to log in, contact the Corporate Secretariat immediately.
          </p>
        </div>`
      });
    } catch (mailErr) {
      console.error('⚠️  OTP email failed (OTP still valid):', mailErr.message);
      // Don't rethrow — OTP is saved in DB, login flow continues
    }
  }
  return code;
}

// ============================================================
// EMAIL GENERATION
// ============================================================

function getOrdinal(n) {
  const s = ['th','st','nd','rd'], v = n % 100;
  return s[(v - 20) % 10] || s[v] || s[0];
}

function formatDate(d) {
  if (!d) return 'N/A';
  return new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function generateMemoEmail(directive) {
  const today   = new Date();
  const dateStr = `${today.getDate()}${getOrdinal(today.getDate())} ${today.toLocaleString('default', { month: 'long' })} ${today.getFullYear()}`;
  const baseUrl = process.env.BASE_URL || 'https://directives-new.onrender.com';
  const submitUrl = `${baseUrl}/submit-update/${directive._id}`;

  const sourceLabel = directive.source === 'CG' ? 'Committee of Board' : 'Board of Directors';

  const decisionsHtml = (directive.outcomes || []).map((o, i) => {
    const color = {
      'Not Implemented':  '#6b7280',
      'Being Implemented':'#3b82f6',
      'Implemented':      '#10b981',
      'No Response':      '#dc2626'
    }[o.status] || '#6b7280';
    return `
    <div style="margin-bottom:16px;padding:12px;background:white;border-radius:6px;border-left:4px solid #6366f1;">
      <div style="font-weight:700;color:#6366f1;margin-bottom:4px;font-size:12px;">Decision ${i + 1}</div>
      <div style="color:#374151;font-size:13px;line-height:1.5;margin-bottom:8px;">${o.text}</div>
      <div style="display:inline-block;padding:4px 8px;border-radius:12px;font-size:10px;
                  font-weight:700;background:${color};color:white;">
        Current Status: ${o.status}
      </div>
      ${o.challenges      ? `<div style="margin-top:8px;font-size:11px;color:#6b7280;"><strong>Challenges:</strong> ${o.challenges}</div>` : ''}
      ${o.completionDetails?`<div style="margin-top:8px;font-size:11px;color:#059669;"><strong>Completed:</strong> ${o.completionDetails}</div>` : ''}
      ${o.delayReason     ? `<div style="margin-top:8px;font-size:11px;color:#dc2626;"><strong>Delay Reason:</strong> ${o.delayReason}</div>` : ''}
    </div>`;
  }).join('');

  const timelineHtml = (directive.implementationStartDate || directive.implementationEndDate) ? `
  <div style="padding:20px 24px;background:white;border-bottom:1px solid #e5e7eb;">
    <div style="font-size:11px;font-weight:700;color:#6b7280;text-transform:uppercase;
                letter-spacing:.5px;margin-bottom:8px;">Implementation Timeline</div>
    <div style="color:#111827;font-size:13px;font-weight:600;">
      ${directive.implementationStartDate ? formatDate(directive.implementationStartDate) : 'Not set'}
      <span style="color:#6b7280;"> → </span>
      ${directive.implementationEndDate   ? formatDate(directive.implementationEndDate)   : 'Not set'}
    </div>
  </div>` : '';

  return `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="font-family:Arial,sans-serif;background:#f9fafb;padding:20px;margin:0;">
<div style="max-width:700px;margin:0 auto;background:white;border:1px solid #e5e7eb;
            border-radius:8px;overflow:hidden;">

  <!-- Header -->
  <div style="border-bottom:3px solid #1e40af;padding:24px;background:white;">
    <h2 style="color:#1e40af;font-size:18px;font-weight:700;margin:0 0 12px 0;text-transform:uppercase;">
      REQUEST FOR STATUS OF COMPLIANCE WITH ${sourceLabel.toUpperCase()} DECISIONS
    </h2>
    <p style="color:#6b7280;font-size:13px;margin:0;">
      Central Bank of Nigeria – Corporate Secretariat
    </p>
  </div>

  <!-- Memo details -->
  <div style="padding:24px;background:#f9fafb;border-bottom:1px solid #e5e7eb;">
    <table style="width:100%;font-size:13px;color:#374151;">
      <tr>
        <td style="padding:8px 0;width:50%;"><strong>To:</strong> ${directive.owner}</td>
        <td style="padding:8px 0;"><strong>From:</strong> Secretary to the Board / Director</td>
      </tr>
      <tr>
        <td style="padding:8px 0;"><strong>Meeting Ref:</strong> ${directive.ref || 'N/A'}</td>
        <td style="padding:8px 0;"><strong>Date:</strong> ${dateStr}</td>
      </tr>
      ${directive.amount ? `
      <tr>
        <td style="padding:8px 0;"><strong>Amount:</strong> ${directive.amount}</td>
        <td style="padding:8px 0;"><strong>Vendor:</strong> ${directive.vendor || '—'}</td>
      </tr>` : ''}
    </table>
  </div>

  <!-- Intro -->
  <div style="padding:20px 24px;background:white;border-bottom:1px solid #e5e7eb;">
    <p style="color:#374151;font-size:13px;line-height:1.6;margin:0;">
      The Corporate Secretariat is compiling the status of SBU compliance with
      ${sourceLabel} decisions. Please send your submission promptly.
    </p>
  </div>

  <!-- Subject -->
  <div style="padding:20px 24px;background:#f9fafb;border-bottom:1px solid #e5e7eb;">
    <div style="font-size:11px;font-weight:700;color:#6b7280;text-transform:uppercase;
                letter-spacing:.5px;margin-bottom:8px;">Subject</div>
    <div style="font-weight:700;color:#111827;font-size:14px;line-height:1.5;">
      ${directive.subject}
    </div>
  </div>

  <!-- Particulars -->
  ${directive.particulars ? `
  <div style="padding:20px 24px;background:white;border-bottom:1px solid #e5e7eb;">
    <div style="font-size:11px;font-weight:700;color:#6b7280;text-transform:uppercase;
                letter-spacing:.5px;margin-bottom:8px;">Directive Particulars</div>
    <div style="color:#374151;line-height:1.6;font-size:13px;">${directive.particulars}</div>
  </div>` : ''}

  ${timelineHtml}

  <!-- Decisions -->
  <div style="padding:20px 24px;background:white;border-bottom:1px solid #e5e7eb;">
    <div style="font-size:11px;font-weight:700;color:#6b7280;text-transform:uppercase;
                letter-spacing:.5px;margin-bottom:16px;">Required Decisions & Current Status</div>
    <div style="background:#f9fafb;padding:16px;border-radius:8px;border:1px solid #e5e7eb;">
      ${decisionsHtml}
    </div>
  </div>

  <!-- CTA -->
  <div style="padding:40px 24px;background:linear-gradient(135deg,#4f46e5 0%,#6366f1 100%);
              text-align:center;">
    <h3 style="color:white;font-size:20px;font-weight:700;margin:0 0 12px 0;">
      Submit Your Implementation Update
    </h3>
    <p style="color:#e0e7ff;font-size:14px;line-height:1.6;margin:0 0 28px 0;
              max-width:500px;margin-left:auto;margin-right:auto;">
      Click the button below to update decision statuses, add timeline details,
      and upload supporting documents.
    </p>
    <a href="${submitUrl}"
       style="display:inline-block;background:white;color:#4f46e5;font-weight:700;
              padding:18px 48px;border-radius:10px;text-decoration:none;font-size:16px;
              box-shadow:0 6px 12px rgba(0,0,0,.2);">
      Submit Update Now →
    </a>
    <p style="color:#c7d2fe;font-size:11px;margin:24px 0 0 0;word-break:break-all;">
      ${submitUrl}
    </p>
  </div>

  <!-- Action required -->
  <div style="padding:24px;background:#eff6ff;border-top:1px solid #dbeafe;">
    <p style="color:#1e40af;font-size:13px;font-weight:600;line-height:1.6;margin:0 0 8px 0;">
      <strong>Action Required:</strong> Please provide an update on the implementation
      status of the above decisions.
    </p>
    <p style="color:#1e40af;font-size:12px;line-height:1.5;margin:0;">
      Your response helps compile the status of compliance with ${sourceLabel} decisions.
    </p>
  </div>

  <!-- Footer -->
  <div style="padding:16px 24px;background:#f9fafb;border-top:1px solid #e5e7eb;text-align:center;">
    <p style="color:#6b7280;font-size:11px;margin:0 0 4px 0;">
      Automated reminder – CBN Directives Management System
    </p>
    <p style="color:#9ca3af;font-size:10px;margin:0;">
      For support, contact the Strategy & Innovation Department
    </p>
  </div>

</div>
</body>
</html>`;
}

// ─── Send reminder email ──────────────────────────────────────
async function sendReminderEmail(directive) {
  if (!emailTransporter || !directive.primaryEmail?.trim()) return false;

  try {
    const allCC    = [...(directive.inCopy || [])];
    if (directive.secondaryEmail && !allCC.includes(directive.secondaryEmail))
      allCC.push(directive.secondaryEmail);

    const emailRx  = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const validTo  = [directive.primaryEmail].filter(e => emailRx.test(e));
    if (!validTo.length) return false;

    const cc = allCC.filter(e => emailRx.test(e) && !validTo.includes(e)).join(', ') || undefined;

    await emailTransporter.sendMail({
      to:      validTo.join(', '),
      cc,
      subject: `Reminder ${directive.reminders + 1}/3: Decision Update Required – ${directive.ref}`,
      html:    generateMemoEmail(directive)
    });
    return true;
  } catch (e) {
    console.error('❌ Email error:', e.message);
    return false;
  }
}

// ============================================================
// GOOGLE SHEETS INTEGRATION
// ============================================================

const SHEET_ID = process.env.GOOGLE_SHEET_ID || '1BuQneU7HESvwRE25Zkir96jZrSP-TKLe';
const SCOPES   = ['https://www.googleapis.com/auth/spreadsheets.readonly'];

async function getGoogleSheetsClient() {
  if (process.env.GOOGLE_CREDENTIALS_PATH) {
    const auth = new google.auth.GoogleAuth({ keyFile: process.env.GOOGLE_CREDENTIALS_PATH, scopes: SCOPES });
    return google.sheets({ version: 'v4', auth: await auth.getClient() });
  }
  const credPath = path.join(__dirname, '.credentials.json');
  if (fs.existsSync(credPath)) {
    const auth = new google.auth.GoogleAuth({ keyFile: credPath, scopes: SCOPES });
    return google.sheets({ version: 'v4', auth: await auth.getClient() });
  }
  if (process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
    const auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY), scopes: SCOPES
    });
    return google.sheets({ version: 'v4', auth: await auth.getClient() });
  }
  throw new Error(
    'Google credentials not found. Set GOOGLE_CREDENTIALS_PATH, place .credentials.json in root, or set GOOGLE_SERVICE_ACCOUNT_KEY.'
  );
}

// ─── Date parsing ─────────────────────────────────────────────
function parseDate(str) {
  if (!str || str === '' || str === ',,') return null;
  str = String(str).trim();
  if (!isNaN(str)) {
    const d = new Date(new Date(1899, 11, 30).getTime() + parseFloat(str) * 86400000);
    if (!isNaN(d.getTime())) return d;
  }
  const d1 = new Date(str);
  if (!isNaN(d1.getTime())) return d1;
  const parts = str.split(/[\/\-\.]/);
  if (parts.length === 3) {
    const d2 = new Date(+parts[2], +parts[1] - 1, +parts[0]);
    if (!isNaN(d2.getTime())) return d2;
  }
  return null;
}

function addDays(date, days) {
  const d = new Date(date); d.setDate(d.getDate() + days); return d;
}

// ─── Status extraction ────────────────────────────────────────
function extractStandardStatus(txt) {
  if (!txt || !txt.trim()) return '';
  const map = {
    'Not Started':       'Not Implemented',
    'Not Implemented':   'Not Implemented',
    'Being Implemented': 'Being Implemented',
    'Delayed':           'Being Implemented',
    'Completed':         'Implemented',
    'Implemented':       'Implemented',
    'No Response':       'No Response'
  };
  const c = txt.trim();
  return map[c] || '';
}

function extractComments(txt) {
  const known = ['Not Started','Not Implemented','Being Implemented','Delayed','Completed','Implemented','No Response'];
  if (!txt || !txt.trim()) return '';
  return known.includes(txt.trim()) ? '' : txt.trim();
}

// ─── Text helpers ─────────────────────────────────────────────
function smartTruncate(txt, max = 300) {
  if (!txt || txt.length <= max) return txt;
  const cut  = txt.substring(0, max);
  const last = Math.max(cut.lastIndexOf('.'), cut.lastIndexOf('!'), cut.lastIndexOf('?'));
  return last > max * 0.7 ? cut.substring(0, last + 1) : cut + '...';
}

// ─── Smart parsing of particulars text into decisions ─────────
// (RESTORED from original — was accidentally removed)
function parseDecisions(particulars) {
  if (!particulars || !particulars.trim()) {
    return [{ text: 'Implementation required', status: 'Not Implemented' }];
  }
  let cleanText = particulars
    .replace(/^The (Committee of (Board|Governors)|Board of Directors) (at its )?(considered and )?(DECIDED|APPROVED|RECOMMENDED|RATIFIED|DIRECTED)( as follows)?:?\s*/i, '')
    .replace(/^(APPROVED|DIRECTED|RECOMMENDED|RATIFIED|DECIDED):?\s*/i, '')
    .trim();

  const smart = extractSmartDecisions(cleanText);
  return smart.slice(0, 3);
}

function extractSmartDecisions(text) {
  const decisions = [];

  // Try structured list patterns first (bracketed letters, roman numerals, numbers, plain letters)
  const listPatterns = [
    /(?:^|\n)\s*\(([a-z])\)\s*([^()]+?)(?=\n\s*\([a-z]\)|\n\n|$)/gi,
    /(?:^|\n)\s*\(([ivxl]+)\)\s*([^()]+?)(?=\n\s*\([ivxl]+\)|\n\n|$)/gi,
    /(?:^|\n)\s*([a-z])\.\s*([^\n]+?)(?=\n\s*[a-z]\.|\n\n|$)/gim,
    /(?:^|\n)\s*(\d+)\.\s*([^\n]+?)(?=\n\s*\d+\.|\n\n|$)/gm
  ];

  for (const pattern of listPatterns) {
    const matches = [...text.matchAll(pattern)];
    if (matches.length >= 2) {
      matches.forEach(m => {
        const t = m[2].trim();
        if (t.length > 20) {
          decisions.push({ text: smartTruncate(t, 300), status: 'Not Implemented', _priority: calculatePriority(t) });
        }
      });
      if (decisions.length) break;
    }
  }

  // Fall back to action-sentence extraction
  if (!decisions.length) decisions.push(...extractActionBasedDecisions(text));

  // Fall back to semicolon / comma-and splitting
  if (!decisions.length) {
    text.split(/;\s+|,\s+and\s+|,\s+also\s+/).forEach(part => {
      const t = part.trim();
      if (t.length > 30)
        decisions.push({ text: smartTruncate(t, 300), status: 'Not Implemented', _priority: calculatePriority(t) });
    });
  }

  // Final fallback: whole text as one decision
  if (!decisions.length) {
    decisions.push({ text: smartTruncate(text, 300), status: 'Not Implemented', _priority: 1 });
  }

  decisions.sort((a, b) => (b._priority || 0) - (a._priority || 0));
  return decisions.map(d => ({ text: d.text, status: d.status }));
}

function extractActionBasedDecisions(text) {
  const decisions = [];
  const strongVerbs = [
    'approve','approved','implement','establish','develop','create',
    'procure','purchase','acquire','pay','disburse','allocate',
    'authorize','grant','execute','complete','finalize',
    'submit','report','provide','prepare','ensure'
  ];

  const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];

  sentences.forEach(sentence => {
    const t = sentence.trim();
    const lo = t.toLowerCase();
    let score = 0;

    if (strongVerbs.some(v => new RegExp(`\\b${v}\\b`, 'i').test(lo))) score += 3;
    if (/\b(shall|must|required to|directed to)\b/i.test(lo))          score += 3;
    if (/\b(₦|naira|payment|budget|cost|amount)\b/i.test(lo))          score += 2;
    if (/\b(deadline|by|within|before|timeline)\b/i.test(lo))           score += 2;
    if (/\b(director|department|unit|team|committee)\b/i.test(lo))      score += 1;
    if (t.length > 40)                                                    score += 1;

    if (score >= 4) {
      decisions.push({ text: smartTruncate(t, 300), status: 'Not Implemented', _priority: score });
    }
  });

  return decisions;
}

function calculatePriority(text) {
  let p = 1;
  const lo = text.toLowerCase();
  if (/\b(urgent|immediate|critical|priority)\b/i.test(lo)) p += 3;
  if (/\b(shall|must|required)\b/i.test(lo))                p += 2;
  if (/\b(payment|procure|budget|₦)\b/i.test(lo))           p += 2;
  if (/\b(complete|finalize|submit)\b/i.test(lo))            p += 1;
  return p;
}

// ─── Process Owner name cleaner ───────────────────────────────
// (RESTORED from original — was accidentally removed)
function extractProcessOwner(ownerText) {
  if (!ownerText || ownerText.trim() === '' || ownerText.trim() === ',,' || ownerText.trim() === "''")
    return 'Unassigned';

  let cleaned = ownerText.trim()
    .replace(/^[,'"]+|[,'"]+$/g, '')
    .replace(/[₦$N]\s*[\d,]+\.?\d*/gi, '')
    .replace(/\b\d{4,}(?:,\d{3})*(?:\.\d{2})?\b/g, '')
    .replace(/\d{4,}/g, '')
    .replace(/\d+\.\d+/g, '');

  if (cleaned.includes('CC:')) cleaned = cleaned.split(/CC:/i)[0].trim();

  cleaned = cleaned
    .replace(/\b(amount|total|sum|naira|kobo|million|billion)\b/gi, '')
    .replace(/[,\.]{2,}/g, '')
    .replace(/^[,\.\s]+|[,\.\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  // ── Strip role prefixes so BU name is just the department ──
  cleaned = cleaned
    .replace(/^Director,?\s*/i, '')
    .replace(/^Deputy Governor,?\s*/i, '')
    .replace(/^Governor,?\s*/i, '')
    .replace(/^Executive Director,?\s*/i, '')
    .replace(/^Deputy Director,?\s*/i, '')
    .replace(/^Head,?\s*/i, '')
    .replace(/^Chief,?\s*/i, '')
    .trim();
  // ───────────────────────────────────────────────────────────

  if (!cleaned || cleaned.length < 3 || /^\d/.test(cleaned) || /^[\d,.\s₦$N]+$/.test(cleaned))
    return 'Unassigned';

  return cleaned;
}



// ─── Main sheet reader ────────────────────────────────────────
async function fetchSheetData(sheetName) {
  try {
    const sheets   = await getGoogleSheetsClient();
    const metadata = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
    const tab      = metadata.data.sheets.find(s => s.properties.title === sheetName);
    if (!tab) { console.log(`⚠️  Tab "${sheetName}" not found`); return []; }

    const tabName  = tab.properties.title;
    console.log(`📖 Reading tab: "${tabName}"`);

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `'${tabName}'!A1:J1000`
    });

    const rows = response.data.values;
    if (!rows || rows.length < 4) {
      console.log(`⚠️  Not enough data in "${tabName}"`); return [];
    }

    const dataRows = rows.slice(3);
    console.log(`📊 ${dataRows.length} data rows after skipping first 3`);

    const COL = { REF:0, DATE:1, SUBJECT:2, PARTICULARS:3, OWNER:4, AMOUNT:5, VENDOR:6, DEADLINE:7, STATUS:8, MONITOR:9 };

    // Extract clean reference numbers, preserving sub-letters like (a),(b)
    function extractRef(cell) {
      if (!cell) return null;
      const c = cell.toString().trim();
      if (c.toUpperCase().includes('MEETING AT WHICH') || c === '' || c === ',,' || c === "'" || c === "''") return null;
      const m = c.match(/(CG|BD|Board)\s*\/\s*[A-Z]{3,4}\s*\/\s*\d+\s*\/\s*\d{4}\s*(?:\/\s*\d+\s*)?(?:\([a-z]\))?/i);
      if (m) {
        const ref = m[0].replace(/\s+/g, '').toUpperCase();
        return ref;
      }
      return null;
    }

    // Extract valid amounts (skip names/text)
    function parseAmount(cell) {
      if (!cell) return null;
      const c = cell.toString().trim();
      if (!c || c === ',,' || c === "'") return null;
      const hasNumbers  = /\d/.test(c);
      const hasCurrency = /[₦$£€]|USD|GBP|EUR|Naira|billion|million/i.test(c);
      const looksLikeName = /^[A-Z][a-z]+\s+[A-Z]/.test(c);
      if ((hasNumbers || hasCurrency) && !looksLikeName) return c;
      return null;
    }

    const directiveMap = new Map();
    let lastValidOwner = 'Unassigned';
    let refsFound      = 0;

    dataRows.forEach((row, index) => {
      if (!row || !row.length) return;

      const refCell = (row[COL.REF] || '').toString();
      const ref     = extractRef(refCell);

      if (ref) {
        refsFound++;

        if (directiveMap.has(ref)) {
          // Continuation row for existing directive — add particulars + amounts
          const g = directiveMap.get(ref);
          const p = (row[COL.PARTICULARS] || '').toString().trim();
          if (p && p !== ',,' && p !== "'") g.particulars.push(p);
          const a = parseAmount(row[COL.AMOUNT]);
          if (a) g.amounts.push(a);
          console.log(`   🔗 Row ${index + 4}: continuation of ${ref}`);

        } else {
          // Brand-new directive
          const rawOwner = (row[COL.OWNER] || '').toString().trim();
          const isPlaceholder = !rawOwner || rawOwner === '' || rawOwner === ',,' || rawOwner === "'";
          let owner = lastValidOwner;

          if (!isPlaceholder) {
            const cleaned = extractProcessOwner(rawOwner);
            if (cleaned && cleaned !== 'Unassigned') { owner = cleaned; lastValidOwner = cleaned; }
          }

          // Parse meeting date
          const dateCell = (row[COL.DATE] || '').toString().trim();
          let meetDate   = new Date();
          if (dateCell && dateCell !== ',,' && dateCell !== "'") {
            const dm = dateCell.match(/(\d{1,2})\w*\s+of\s+([A-Za-z]+)\s+(\d{4})/);
            if (dm) meetDate = new Date(`${dm[2]} ${dm[1]}, ${dm[3]}`);
            else    meetDate = parseDate(dateCell) || new Date();
          }

          const amounts  = [];
          const a0 = parseAmount(row[COL.AMOUNT]);
          if (a0) amounts.push(a0);

          const g = {
            refNo:       ref,
            meetingDate: meetDate,
            subject:     (row[COL.SUBJECT] || '').toString().trim(),
            owner,
            amounts,
            vendor:      (row[COL.VENDOR]   || '').toString().trim(),
            implDeadline:(row[COL.DEADLINE] || '').toString().trim(),
            implStatus:  (row[COL.STATUS]   || '').toString().trim(),
            monitorStatus:(row[COL.MONITOR] || '').toString().trim(),
            particulars: []
          };

          const p0 = (row[COL.PARTICULARS] || '').toString().trim();
          if (p0 && p0 !== ',,' && p0 !== "'") g.particulars.push(p0);

          directiveMap.set(ref, g);
          console.log(`\n📌 NEW: ${ref} | owner: "${owner}" | date: ${meetDate.toDateString()}`);
        }

      } else {
        // No REF — continuation of the last directive in map
        const last = Array.from(directiveMap.values()).pop();
        if (last) {
          const p = (row[COL.PARTICULARS] || '').toString().trim();
          if (p && p !== ',,' && p !== "'") {
            last.particulars.push(p);
            console.log(`   └─ Row ${index + 4}: added particular to ${last.refNo}`);
          }
          const a = parseAmount(row[COL.AMOUNT]);
          if (a) { last.amounts.push(a); console.log(`   └─💰 Amount: ${a}`); }
        }
      }
    });

    const groups = Array.from(directiveMap.values());
    console.log(`\n✨ "${tabName}": ${refsFound} refs → ${groups.length} directives\n`);

    return groups.map((g, idx) => {
      // Build decisions from each particular row (each row = one decision)
      let decisions = g.particulars.map(p => ({
        text:   smartTruncate(p, 300),
        status: 'Not Implemented'
      }));

      // If no particular rows, use smart parsing of combined text
      if (!decisions.length && g.subject) {
        decisions = parseDecisions(g.subject);
      }

      // Always at least one decision
      if (!decisions.length) {
        decisions = [{ text: g.subject || 'Implementation required', status: 'Not Implemented' }];
      }

      const combinedParticulars = g.particulars.length ? g.particulars.join('\n\n') : g.subject;

      console.log(`✅ ${idx + 1}/${groups.length}: ${g.refNo} — ${decisions.length} decision(s), ${g.amounts.length} amount(s)`);

      return {
        source:               tabName.toLowerCase().includes('board') ? 'Board' : 'CG',
        sheetName:            tabName,
        ref:                  g.refNo,
        meetingDate:          g.meetingDate,
        subject:              g.subject || 'No Subject',
        particulars:          combinedParticulars,
        owner:                g.owner,
        primaryEmail:         '',
        inCopy:               [],
        secondaryEmail:       '',
        amount:               g.amounts.join('\n'),
        vendor:               g.vendor || '',
        implementationStartDate: null,
        implementationEndDate:   parseDate(g.implDeadline),
        implementationStatus:    extractStandardStatus(g.implStatus),
        additionalComments:      extractComments(g.implStatus),
        monitoringStatus:        g.monitorStatus?.trim() || 'On Track',
        outcomes:                decisions,
        statusHistory: [{
          status:    g.monitorStatus?.trim() || 'On Track',
          changedAt: new Date(),
          notes:     'Initial status from Google Sheet'
        }]
      };
    });

  } catch (error) {
    console.error(`❌ Error fetching sheet "${sheetName}":`, error.message);
    throw error;
  }
}

// ============================================================
// AUTOMATED REMINDERS
// ============================================================

async function runReminders() {
  console.log('\n📧 Running reminder check…');

  let settings = await ReminderSettings.findOne();
  if (!settings) settings = await ReminderSettings.create({
    enabled: true, statusSettings: { 'On Track': true, 'At Risk': true, 'High Risk': true }
  });

  if (!settings.enabled) { console.log('⏸  Reminders disabled'); return; }

  const enabledStatuses = Object.keys(settings.statusSettings).filter(k => settings.statusSettings[k]);
  const directives = await Directive.find({ monitoringStatus: { $in: enabledStatuses }, reminders: { $lt: 3 } });

  let sent = 0;
  for (const d of directives) {
    if (!d.isReminderDue()) continue;
    const ok = await sendReminderEmail(d);
    d.reminders++;
    d.lastReminderDate = new Date();
    d.reminderHistory.push({ sentAt: new Date(), recipient: d.owner, method: ok ? 'Email' : 'System' });
    await d.updateMonitoringStatus(`Reminder ${d.reminders} sent${ok ? ' via email' : ''}`);
    sent++;
    console.log(`   ✉️  Reminder ${d.reminders}/3 → ${d.owner} (${d.ref})`);
  }
  console.log(`✅ ${sent} reminder(s) sent\n`);
}

cron.schedule('0 9 * * *', () => {
  console.log('⏰ Daily reminder check');
  runReminders();
});

// ─── Department-based access middleware ───────────────────────
function departmentFilter(req, res, next) {
  const userType = req.headers['x-user-type'];
  const userDept = req.headers['x-user-department'];
  if (userType === 'admin') return next();
  if (userDept) req.deptFilter = userDept;
  next();
}

// ============================================================
// API ROUTES
// ============================================================

// ─── Health ──────────────────────────────────────────────────
app.get('/api/health', (req, res) => res.json({
  status:    'ok',
  mongodb:   mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
  email:     emailTransporter ? 'configured' : 'not configured',
  timestamp: new Date().toISOString()
}));

// ─── Email test ───────────────────────────────────────────────
app.post('/api/test-email', async (req, res) => {
  const timer = setTimeout(() => {
    if (!res.headersSent) res.status(408).json({ success: false, error: 'Request timed out' });
  }, 15000);
  try {
    if (!emailTransporter) { clearTimeout(timer); return res.status(500).json({ success: false, error: 'Email not configured' }); }
    const { testEmail } = req.body;
    await emailTransporter.sendMail({
      to:      testEmail,
      subject: 'CBN Directives System – Email Configuration Test',
      html: `
      <div style="font-family:Arial,sans-serif;padding:24px;border:2px solid #10b981;border-radius:8px;
                  background:#f0fdf4;max-width:600px;margin:auto;">
        <h2 style="color:#059669;margin-top:0;">✅ Email System Working!</h2>
        <p style="color:#374151;line-height:1.6;">
          This is a test email from the <strong>CBN Directives Management Platform</strong>.
          If you received this, the email configuration is working correctly.
        </p>
      </div>`
    });
    clearTimeout(timer);
    res.json({ success: true, message: `Test email sent to ${testEmail}` });
  } catch (e) { clearTimeout(timer); res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/preview-email/:id', async (req, res) => {
  try {
    const d = await Directive.findById(req.params.id);
    if (!d) return res.status(404).json({ success: false, error: 'Not found' });
    res.json({ success: true, html: generateMemoEmail(d) });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ─── Departments (Business Units — max 3) ────────────────────
app.get('/api/departments', async (req, res) => {
  try {
    const data = await Department.find({ isActive: true }).sort({ name: 1 });
    res.json({ success: true, data });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/departments', async (req, res) => {
  try {
    const dept = new Department(req.body);
    await dept.save();
    res.json({ success: true, data: dept });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});




app.post('/api/departments/upsert', async (req, res) => {
  try {
    const { name, personName, position, code } = req.body;
    if (!name) return res.status(400).json({ success: false, error: 'Name required' });

    const dept = await Department.findOneAndUpdate(
      { name },
      {
        $set: {
          personName: personName || '',
          position:   position   || '',
          code:       code       || '',
          isActive:   true
        }
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    res.json({ success: true, data: dept });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});





app.patch('/api/departments/:id', async (req, res) => {
  try {
    const dept = await Department.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!dept) return res.status(404).json({ success: false, error: 'Not found' });
    res.json({ success: true, data: dept });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.delete('/api/departments/:id', async (req, res) => {
  try {
    const dept = await Department.findByIdAndUpdate(req.params.id, { isActive: false }, { new: true });
    if (!dept) return res.status(404).json({ success: false, error: 'Not found' });
    res.json({ success: true, message: `${dept.name} deactivated` });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ─── Google Sheets sync ───────────────────────────────────────
app.post('/api/sync-sheets', async (req, res) => {
  try {
    console.log('\n🔄 Starting Google Sheets sync…');
    const sheets   = await getGoogleSheetsClient();
    const metadata = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
    const allTabs  = metadata.data.sheets.filter(s => !s.properties.hidden).map(s => s.properties.title);

    console.log(`📊 ${allTabs.length} sheets detected`);

    let newCount = 0, updCount = 0, skipCount = 0;
    const errors = [];

    for (const tab of allTabs) {
      try {
        const directives = await fetchSheetData(tab);
        if (!directives.length) { skipCount++; continue; }

        for (const d of directives) {
          try {
            const existing = await Directive.findOne({ ref: d.ref }) ||
                             await Directive.findOne({ subject: d.subject, meetingDate: d.meetingDate, sheetName: d.sheetName });
            if (!existing) {
              await new Directive(d).save();
              newCount++;
            } else {
              existing.particulars = d.particulars;
              existing.owner       = d.owner;
              existing.amount      = d.amount;
              existing.vendor      = d.vendor;
              if (!existing.implementationEndDate) existing.implementationEndDate = d.implementationEndDate;
              if (existing.outcomes.every(o => o.status === 'Not Implemented')) existing.outcomes = d.outcomes;
              await existing.save();
              updCount++;
            }
          } catch (e) { errors.push({ tab, ref: d.ref, error: e.message }); }
        }
      } catch (e) {
        console.error(`❌ Error processing "${tab}":`, e.message);
        errors.push({ tab, error: e.message });
      }
    }

    console.log(`\n✨ Sync done: ${newCount} new | ${updCount} updated | ${skipCount} skipped | ${errors.length} errors\n`);
    res.json({
      success: true,
      message: `Synced ${newCount} new, updated ${updCount}`,
      summary: { sheetsProcessed: allTabs.length, newCount, updCount, skipCount, errors: errors.length }
    });
  } catch (e) {
    console.error('❌ Sync error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// // ─── 2FA — Admin login ────────────────────────────────────────
// app.post('/api/auth/admin/login', async (req, res) => {
//   try {
//     const { email, password } = req.body;
//     if (!email || !password) return res.status(400).json({ success: false, error: 'Email and password required' });
//     // TODO: wire up your AdminUser model here
//     // const admin = await AdminUser.findOne({ email: email.toLowerCase() });
//     // if (!admin || !(await bcrypt.compare(password, admin.passwordHash)))
//     //   return res.status(401).json({ success: false, error: 'Invalid credentials' });
//     await sendOtp(email, 'Admin');
//     res.json({ success: true, step: '2fa', email, message: `OTP sent to ${email}` });
//   } catch (e) { res.status(500).json({ success: false, error: e.message }); }
// });





// app.post('/api/auth/admin/verify-otp', async (req, res) => {
//   try {
//     const { email, otp } = req.body;
//     const record = await Otp.findOne({ email: email.toLowerCase(), used: false });
//     if (!record || new Date() > record.expiresAt)
//       return res.status(401).json({ success: false, error: 'OTP expired or invalid' });
//     const ok = await bcrypt.compare(String(otp), record.otpHash);
//     if (!ok) return res.status(401).json({ success: false, error: 'Incorrect code' });
//     record.used = true; await record.save();
//     const token = crypto.randomBytes(32).toString('hex');
//     res.json({ success: true, token, userType: 'admin', message: 'Login successful' });
//   } catch (e) { res.status(500).json({ success: false, error: e.message }); }
// });

// ─── Directives CRUD ──────────────────────────────────────────

function computeMonitoring(d) {
  const allDone = d.outcomes?.length > 0 && d.outcomes.every(o => o.status === 'Implemented');
  if (allDone || d.implementationStatus === 'Implemented') return { monitoringStatus: 'Completed', isResponsive: true };
  if (!d.implementationEndDate) return { monitoringStatus: 'Needs Timeline', isResponsive: d.isResponsive };
  const days = Math.ceil((new Date(d.implementationEndDate) - new Date()) / 86400000);
  const ms   = days <= 7 ? 'High Risk' : (days < 30 || d.reminders >= 3) ? 'At Risk' : 'On Track';
  const nr   = d.reminders >= 3 && (!d.lastSbuUpdate ||
    (d.lastReminderDate && new Date(d.lastSbuUpdate) < new Date(d.lastReminderDate)));
  return { monitoringStatus: ms, isResponsive: !nr };
}

app.get('/api/directives', departmentFilter, async (req, res) => {
  try {
    const { source, owner, status, sheetName, department, businessUnit } = req.query;
    const query = {};
    if (source       && source       !== 'All') query.source           = source;
    if (sheetName    && sheetName    !== 'All') query.sheetName        = sheetName;
    if (status       && status       !== 'All') query.monitoringStatus = status;
    if (department   && department   !== 'All') query.department       = department;
    if (businessUnit && businessUnit !== 'All') query.owner = new RegExp(businessUnit, 'i');
    if (owner        && owner        !== 'All') query.owner = new RegExp(owner, 'i');
    if (req.deptFilter) query.department = req.deptFilter;

    const directives = await Directive.find(query).sort({ createdAt: -1 });
    const data = directives.map(d => ({ ...d.toObject(), ...computeMonitoring(d.toObject()) }));
    res.json({ success: true, data });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/directives/eligible-for-reminder', async (req, res) => {
  try {
    const { source } = req.query;
    const all = await Directive.find(source ? { source } : {});
    const eligible = all.filter(d => {
      if (d.monitoringStatus === 'Completed' || d.reminders >= 3) return false;
      if (d.lastSbuUpdate) {
        const days = Math.ceil((new Date() - new Date(d.lastSbuUpdate)) / 86400000);
        if (days < 7) return false;
      }
      return !d.outcomes?.length || d.outcomes.some(o => o.status !== 'Implemented');
    });
    res.json({ success: true, data: eligible, total: eligible.length });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/directives/:id', async (req, res) => {
  try {
    const d = await Directive.findById(req.params.id);
    if (!d) return res.status(404).json({ success: false, error: 'Not found' });
    const obj = d.toObject();
    res.json({ success: true, data: { ...obj, ...computeMonitoring(obj) } });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/directives', async (req, res) => {
  try {
    const d = new Directive(req.body);
    await d.save();
    res.json({ success: true, data: d });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.put('/api/directives/:id', async (req, res) => {
  try {
    const directive = await Directive.findById(req.params.id);
    if (!directive) return res.status(404).json({ success: false, error: 'Not found' });

    const {
      outcomes, implementationStatus, completionNote, additionalComments,
      implementationStartDate, implementationEndDate,
      meetingDate, owner, subject, particulars, amount, vendor,
      sheetName, department, primaryEmail, secondaryEmail, inCopy
    } = req.body;

    const emailChanged = (
      (primaryEmail   !== undefined && primaryEmail   !== directive.primaryEmail) ||
      (secondaryEmail !== undefined && secondaryEmail !== directive.secondaryEmail) ||
      (inCopy         !== undefined)
    );

    if (outcomes)               directive.outcomes               = outcomes;
    if (implementationStatus)   directive.implementationStatus   = implementationStatus;
    if (completionNote)         directive.completionNote         = completionNote;
    if (implementationStartDate)directive.implementationStartDate= new Date(implementationStartDate);
    if (implementationEndDate)  directive.implementationEndDate  = new Date(implementationEndDate);
    if (meetingDate)            directive.meetingDate            = new Date(meetingDate);
    if (owner)                  directive.owner                  = owner;
    if (subject)                directive.subject                = subject;
    if (particulars)            directive.particulars            = particulars;
    if (amount      !== undefined) directive.amount              = amount;
    if (vendor      !== undefined) directive.vendor              = vendor;
    if (sheetName)              directive.sheetName              = sheetName;
    if (department  !== undefined) directive.department          = department;
    if (primaryEmail  !== undefined) directive.primaryEmail      = primaryEmail;
    if (secondaryEmail!== undefined) directive.secondaryEmail    = secondaryEmail;

    if (inCopy !== undefined) {
      directive.inCopy = Array.isArray(inCopy)
        ? inCopy.filter(e => e?.trim())
        : [inCopy].filter(Boolean);
      if (directive.secondaryEmail && !directive.inCopy.includes(directive.secondaryEmail))
        directive.inCopy.unshift(directive.secondaryEmail);
    }

    // Append timestamped comment
    if (additionalComments?.trim()) {
      const ts   = new Date().toLocaleString('en-GB', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' });
      const note = `[${ts}] ${additionalComments.trim()}`;
      directive.additionalComments = directive.additionalComments?.trim()
        ? directive.additionalComments + '\n\n' + note
        : note;
    }

    if (outcomes) { directive.lastSbuUpdate = directive.lastResponseDate = new Date(); }

    await directive.updateMonitoringStatus(outcomes ? 'SBU update received' : 'Directive edited');

    // Sync email across all directives with same Business Unit
    if (emailChanged && directive.owner) {
      const result = await Directive.updateMany(
        { owner: directive.owner, _id: { $ne: directive._id } },
        { $set: { primaryEmail: directive.primaryEmail, secondaryEmail: directive.secondaryEmail, inCopy: directive.inCopy } }
      );
      console.log(`✅ Email synced to ${result.modifiedCount} other directive(s) for: ${directive.owner}`);
      return res.json({ success: true, data: directive, emailsUpdated: result.modifiedCount,
        message: `Email updated for ${directive.owner} across ${result.modifiedCount + 1} directive(s)` });
    }

    res.json({ success: true, data: directive });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.delete('/api/directives/:id', async (req, res) => {
  try {
    const d = await Directive.findByIdAndDelete(req.params.id);
    if (!d) return res.status(404).json({ success: false, error: 'Not found' });
    res.json({ success: true, message: 'Directive deleted' });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/admin/clear-directives', async (req, res) => {
  try {
    const r = await Directive.deleteMany({});
    res.json({ success: true, message: `Deleted ${r.deletedCount} directives` });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ─── Remind — single ─────────────────────────────────────────
app.post('/api/directives/:id/remind', async (req, res) => {
  try {
    const directive = await Directive.findById(req.params.id);
    if (!directive) return res.status(404).json({ success: false, error: 'Not found' });
    const ok = await sendReminderEmail(directive);
    directive.reminders++;
    directive.lastReminderDate = new Date();
    directive.reminderHistory.push({ sentAt: new Date(), recipient: directive.owner, method: ok ? 'Email' : 'System' });
    await directive.updateMonitoringStatus(`Manual reminder ${directive.reminders} sent`);
    res.json({ success: true, data: directive, emailSent: ok });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ─── Request update (selective decisions, submission token) ───
app.post('/api/directives/:id/request-update', async (req, res) => {
  try {
    const directive = await Directive.findById(req.params.id);
    if (!directive) return res.status(404).json({ success: false, error: 'Not found' });

    const { selectedOutcomes, deptCCEmails } = req.body;
    if (!selectedOutcomes?.length)
      return res.status(400).json({ success: false, error: 'No decisions selected' });
    if (!directive.primaryEmail?.trim())
      return res.status(400).json({ success: false, error: 'No email configured for this Business Unit' });
    if ((directive.reminders || 0) >= 3)
      return res.status(400).json({ success: false, error: 'Maximum reminders (3) already sent' });

    const token = crypto.randomBytes(32).toString('hex');
    await new SubmissionToken({
      token, directiveId: directive._id, selectedOutcomes,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    }).save();

    const baseUrl   = process.env.BASE_URL || 'https://directives-new.onrender.com';
    const submitUrl = `${baseUrl}/submit-update/${directive._id}?token=${token}`;
    const today     = new Date();
    const dateStr   = `${today.getDate()}${getOrdinal(today.getDate())} ${today.toLocaleString('default',{month:'long'})} ${today.getFullYear()}`;
    const sourceLabel = directive.source === 'CG' ? 'Committee of Board' : 'Board of Directors';

    const decisionsHtml = selectedOutcomes.map(idx => {
      const o = directive.outcomes[idx];
      if (!o) return '';
      const color = { 'Not Implemented':'#6b7280','Being Implemented':'#3b82f6','Implemented':'#10b981','No Response':'#dc2626' }[o.status] || '#6b7280';
      return `
      <div style="margin-bottom:16px;padding:16px;background:white;border-radius:8px;
                  border-left:4px solid ${color};">
        <div style="font-weight:700;color:#1B5E20;margin-bottom:8px;font-size:13px;">Decision ${idx + 1}</div>
        <div style="color:#374151;font-size:13px;line-height:1.5;margin-bottom:8px;">${o.text}</div>
        <span style="display:inline-block;padding:4px 10px;border-radius:12px;font-size:11px;
                     font-weight:600;background:${color};color:white;">${o.status}</span>
      </div>`;
    }).join('');

    const emailHtml = `
    <!DOCTYPE html><html><head><meta charset="UTF-8"></head>
    <body style="font-family:Arial,sans-serif;background:#f5f5f5;margin:0;padding:20px;">
    <div style="max-width:650px;margin:0 auto;background:white;border-radius:12px;
                overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.1);">
      <div style="padding:24px;background:linear-gradient(135deg,#1B5E20 0%,#2E7D32 100%);color:white;">
        <h1 style="margin:0;font-size:18px;text-transform:uppercase;">
          Request for Status Update – ${sourceLabel}
        </h1>
        <p style="margin:6px 0 0;opacity:.9;font-size:13px;">
          Central Bank of Nigeria – Corporate Secretariat
        </p>
      </div>
      <div style="padding:16px 24px;background:#f9fafb;border-bottom:1px solid #e5e7eb;font-size:13px;">
        <div><strong>To:</strong> ${directive.owner}</div>
        <div style="margin-top:4px;">
          <strong>Meeting Ref:</strong> ${directive.ref||'N/A'} &nbsp;|&nbsp;
          <strong>Date:</strong> ${dateStr}
        </div>
        ${directive.amount ? `
        <div style="margin-top:4px;">
          <strong>Amount:</strong> ${directive.amount} &nbsp;|&nbsp;
          <strong>Vendor:</strong> ${directive.vendor||'—'}
        </div>` : ''}
      </div>
      <div style="padding:16px 24px;border-bottom:1px solid #e5e7eb;">
        <div style="font-size:11px;color:#6b7280;text-transform:uppercase;font-weight:600;margin-bottom:4px;">Subject</div>
        <div style="font-size:14px;font-weight:600;color:#111827;">${directive.subject}</div>
      </div>
      <div style="padding:12px 24px;background:#E8F5E9;">
        <div style="font-size:13px;font-weight:700;color:#1B5E20;">
          📋 Decisions Requiring Update (${selectedOutcomes.length} of ${directive.outcomes.length})
        </div>
      </div>
      <div style="padding:20px 24px;background:#fafafa;">${decisionsHtml}</div>
      <div style="padding:32px 24px;text-align:center;
                  background:linear-gradient(135deg,#1B5E20 0%,#2E7D32 100%);">
        <h3 style="color:white;margin:0 0 12px 0;font-size:18px;">Submit Your Implementation Update</h3>
        <p style="color:#C8E6C9;margin:0 0 20px 0;font-size:13px;">
          Click below to update statuses, add timelines, and upload documents.
        </p>
        <a href="${submitUrl}"
           style="display:inline-block;background:white;color:#1B5E20;text-decoration:none;
                  padding:14px 32px;border-radius:8px;font-weight:700;font-size:14px;">
          📝 Submit Update Now →
        </a>
        <p style="color:#A5D6A7;font-size:10px;margin:16px 0 0;word-break:break-all;">${submitUrl}</p>
      </div>
      <div style="padding:16px 24px;background:#f9fafb;text-align:center;border-top:1px solid #e5e7eb;">
        <p style="margin:0;font-size:11px;color:#6b7280;">
          Automated message – CBN Directives Management System
        </p>
      </div>
    </div>
    </body></html>`;

    let emailSent = false;
    if (emailTransporter) {
     const allCC = [...(directive.inCopy || [])];
if (directive.secondaryEmail && !allCC.includes(directive.secondaryEmail)) 
    allCC.push(directive.secondaryEmail);

// Add department CC emails selected by admin
if (deptCCEmails?.length) {
    deptCCEmails.forEach(email => {
        if (email && !allCC.includes(email)) allCC.push(email);
    });
}


      
      const emailRx = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      try {
        await emailTransporter.sendMail({
          to:      directive.primaryEmail,
          cc:      allCC.filter(e => emailRx.test(e)).join(', ') || undefined,
          subject: `Decision Update Request – ${directive.ref || directive.subject}`,
          html:    emailHtml
        });
        emailSent = true;
        console.log(`✅ Request email sent to: ${directive.primaryEmail}`);
      } catch (e) {
        console.error('❌ Email failed:', e.message);
        return res.status(500).json({ success: false, error: `Email failed: ${e.message}` });
      }
    }

    directive.reminders = (directive.reminders || 0) + 1;
    directive.lastReminderDate = new Date();
    directive.reminderHistory  = directive.reminderHistory || [];
    directive.reminderHistory.push({ sentAt: new Date(), recipient: directive.primaryEmail, method: 'Email' });
    await directive.save();

    res.json({
      success:       true,
      message:       `Request sent to ${directive.primaryEmail}`,
      emailSent,
      submissionUrl: emailSent ? undefined : submitUrl,
      reminder:      `${directive.reminders}/3`
    });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ─── Bulk request update ──────────────────────────────────────
app.post('/api/directives/bulk-request-update', async (req, res) => {
  try {
    const { directiveIds } = req.body;
    if (!directiveIds?.length) return res.status(400).json({ success: false, error: 'No directives selected' });

    const results = { sent: [], failed: [], skipped: [] };

    for (const id of directiveIds) {
      const directive = await Directive.findById(id);
      if (!directive)                       { results.failed.push({ id, reason: 'Not found' }); continue; }
      if (!directive.primaryEmail?.trim())  { results.skipped.push({ id: directive.ref, reason: 'No email' }); continue; }
      if ((directive.reminders||0) >= 3)    { results.skipped.push({ id: directive.ref, reason: 'Max reminders' }); continue; }

      try {
        const ok = await sendReminderEmail(directive);
        directive.reminders = (directive.reminders || 0) + 1;
        directive.lastReminderDate = new Date();
        await directive.save();
        if (ok) results.sent.push(directive.ref);
        else    results.failed.push({ id: directive.ref, reason: 'Email send failed' });
      } catch (e) {
        results.failed.push({ id: directive.ref || id, reason: e.message });
      }
    }

    res.json({ success: true, results });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ─── Submission portal — GET ──────────────────────────────────
app.get('/submit-update/:id', async (req, res) => {
  try {
    const directive = await Directive.findById(req.params.id);
    if (!directive) return res.status(404).send('<h1>Directive not found</h1>');

    const token  = req.query.token;
    let toShow   = directive.outcomes.map((o, idx) => ({ o, idx }));

    if (token) {
      const rec = await SubmissionToken.findOne({ token, directiveId: req.params.id });
      if (rec) {
        if (rec.used) return res.send('<h1>This submission link has already been used.</h1>');
        if (rec.expiresAt && new Date() > rec.expiresAt) return res.send('<h1>This submission link has expired.</h1>');
        if (rec.selectedOutcomes?.length)
          toShow = rec.selectedOutcomes.map(idx => ({ o: directive.outcomes[idx], idx })).filter(x => x.o);
      }
    }

    const statusOpts = ['Not Implemented','Being Implemented','Implemented','No Response'];

    const decisionsHtml = toShow.map(({ o, idx }) => `
    <div class="bg-gray-50 rounded-lg border border-gray-200 p-4 mb-4">
      <div class="flex items-center justify-between mb-3">
        <span class="text-sm font-bold text-green-700">Decision ${idx + 1}</span>
        <span class="text-xs px-2 py-1 rounded-full font-semibold bg-gray-100 text-gray-700">
          Current: ${o.status}
        </span>
      </div>
      <p class="text-sm text-gray-700 mb-3 leading-relaxed">${o.text}</p>
      <input type="hidden" name="outcome_index_${idx}" value="${idx}">
      <div class="space-y-3">
        <div>
          <label class="block text-xs font-semibold text-gray-600 mb-1">Update Status *</label>
          <select name="outcome_status_${idx}" required
                  class="outcome-status w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-green-500">
            ${statusOpts.map(s => `<option value="${s}" ${o.status===s?'selected':''}>${s}</option>`).join('')}
          </select>
        </div>
        <div>
          <label class="block text-xs font-semibold text-gray-600 mb-1">Challenges / Notes</label>
          <textarea name="outcome_challenges_${idx}" rows="2"
                    class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm">${o.challenges||''}</textarea>
        </div>
        <div class="completion-details-${idx}" style="display:${o.status==='Implemented'?'block':'none'}">
          <label class="block text-xs font-semibold text-gray-600 mb-1">Completion Details</label>
          <textarea name="outcome_completionDetails_${idx}" rows="2"
                    class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm">${o.completionDetails||''}</textarea>
        </div>
        <div class="delay-reason-${idx}" style="display:${o.status==='No Response'?'block':'none'}">
          <label class="block text-xs font-semibold text-gray-600 mb-1">Reason / Explanation</label>
          <textarea name="outcome_delayReason_${idx}" rows="2"
                    class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm">${o.delayReason||''}</textarea>
        </div>
      </div>
    </div>`).join('');

    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Submit Update – ${directive.ref || 'CBN Directive'}</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-100 min-h-screen py-8 px-4">
<div class="max-w-3xl mx-auto">

  <div class="bg-gradient-to-r from-green-800 to-green-600 text-white rounded-t-xl p-6">
    <h1 class="text-2xl font-bold mb-1">📝 Submit Implementation Update</h1>
    <p class="text-green-100 text-sm">Central Bank of Nigeria – Corporate Secretariat</p>
  </div>

  <div class="bg-white border-b p-6">
    <div class="grid grid-cols-2 gap-4 text-sm">
      <div><span class="text-gray-500">Meeting Ref:</span>
           <span class="font-semibold ml-1">${directive.ref || 'N/A'}</span></div>
      <div><span class="text-gray-500">Business Unit:</span>
           <span class="font-semibold ml-1">${directive.owner}</span></div>
      ${directive.amount ? `
      <div><span class="text-gray-500">Amount:</span>
           <span class="font-semibold ml-1">${directive.amount}</span></div>
      <div><span class="text-gray-500">Vendor:</span>
           <span class="font-semibold ml-1">${directive.vendor || '—'}</span></div>` : ''}
    </div>
    <div class="mt-4 p-3 bg-green-50 rounded-lg border border-green-200">
      <div class="text-xs text-gray-500 font-semibold mb-1">SUBJECT</div>
      <div class="text-sm font-semibold text-gray-900">${directive.subject}</div>
    </div>
    ${toShow.length < directive.outcomes.length ? `
    <div class="mt-3 p-2 bg-blue-50 rounded-lg border border-blue-200">
      <p class="text-xs font-semibold text-blue-700">
        📋 Showing ${toShow.length} of ${directive.outcomes.length} decisions as requested
      </p>
    </div>` : ''}
  </div>

  <form id="form" class="bg-white rounded-b-xl shadow-lg">
    <div class="p-6 border-b">
      <h2 class="text-lg font-bold text-gray-900 mb-1">🎯 Update Decisions</h2>
      <p class="text-sm text-gray-500 mb-4">Update the status for each decision below</p>
      ${decisionsHtml}
    </div>

    <div class="p-6 border-b">
      <h2 class="text-lg font-bold text-gray-900 mb-4">📅 Implementation Timeline</h2>
      <div class="grid grid-cols-2 gap-4">
        <div>
          <label class="block text-sm font-semibold text-gray-700 mb-2">Start Date</label>
          <input type="date" name="implementationStartDate"
                 value="${directive.implementationStartDate ? new Date(directive.implementationStartDate).toISOString().split('T')[0] : ''}"
                 class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500">
        </div>
        <div>
          <label class="block text-sm font-semibold text-gray-700 mb-2">End Date</label>
          <input type="date" name="implementationEndDate"
                 value="${directive.implementationEndDate ? new Date(directive.implementationEndDate).toISOString().split('T')[0] : ''}"
                 class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500">
        </div>
      </div>
    </div>

    <div class="p-6 border-b">
      <h2 class="text-lg font-bold text-gray-900 mb-4">💬 Additional Comments</h2>
      <textarea name="completionNote" rows="3" placeholder="Any additional details…"
                class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-green-500"></textarea>
    </div>

    <div class="p-6 border-b">
      <h2 class="text-lg font-bold text-gray-900 mb-4">📎 Supporting Documents</h2>
      <div class="border-2 border-dashed border-gray-300 rounded-lg p-6 text-center cursor-pointer
                  hover:border-green-500 transition-colors"
           onclick="document.getElementById('fi').click()">
        <input type="file" id="fi" multiple
               accept=".pdf,.doc,.docx,.xls,.xlsx,.png,.jpg,.jpeg" class="hidden">
        <p class="text-sm text-gray-600 mb-1">
          <span class="font-semibold text-green-700">Click to upload</span> or drag and drop
        </p>
        <p class="text-xs text-gray-500">PDF, DOC, XLS, PNG, JPG – up to 10 MB each (max 5 files)</p>
      </div>
      <div id="fileList" class="mt-3 space-y-2"></div>
    </div>

    <div class="p-6">
      <button type="submit" id="submitBtn"
              class="w-full bg-gradient-to-r from-green-700 to-green-600 text-white font-bold py-3
                     rounded-lg hover:from-green-800 hover:to-green-700 transition-all shadow-lg">
        ✅ Submit Update to Secretariat
      </button>
    </div>
  </form>

  <div id="successMessage" class="hidden bg-white rounded-xl shadow-lg p-8 text-center">
    <div class="text-5xl mb-4">✅</div>
    <h2 class="text-xl font-bold text-gray-900 mb-2">Update Submitted Successfully!</h2>
    <p class="text-gray-600">Thank you. The Corporate Secretariat has been notified.</p>
    <p class="text-sm text-gray-500 mt-2">You can close this window now.</p>
  </div>

  <div id="errorMessage" class="hidden bg-white rounded-xl shadow-lg p-8 text-center border-4 border-red-500">
    <div class="text-5xl mb-4">❌</div>
    <h2 class="text-xl font-bold text-gray-900 mb-2">Submission Failed</h2>
    <p id="errorText" class="text-gray-600 mb-4">An error occurred.</p>
    <button onclick="location.reload()"
            class="px-6 py-3 bg-green-600 text-white font-semibold rounded-lg hover:bg-green-700">
      Try Again
    </button>
  </div>
</div>

<script>
  // Show/hide conditional fields based on status selection
  document.querySelectorAll('.outcome-status').forEach(sel => {
    sel.addEventListener('change', function () {
      const m  = this.name.match(/outcome_status_(\\d+)/);
      if (!m) return;
      const i  = m[1];
      const cd = document.querySelector('.completion-details-' + i);
      const dr = document.querySelector('.delay-reason-' + i);
      if (cd) cd.style.display = this.value === 'Implemented'  ? 'block' : 'none';
      if (dr) dr.style.display = this.value === 'No Response'  ? 'block' : 'none';
    });
  });

  // File list preview
  document.getElementById('fi').addEventListener('change', function () {
    const fl = document.getElementById('fileList');
    fl.innerHTML = '';
    Array.from(this.files).forEach(f => {
      fl.insertAdjacentHTML('beforeend',
        '<div class="flex items-center p-2 bg-gray-50 rounded border border-gray-200">' +
        '<span class="text-xs font-medium text-gray-700">' + f.name + '</span>' +
        '<span class="text-xs text-gray-500 ml-2">(' + (f.size / 1024).toFixed(1) + ' KB)</span></div>');
    });
  });

  // Form submission
  document.getElementById('form').addEventListener('submit', async function (e) {
    e.preventDefault();
    const btn = document.getElementById('submitBtn');
    btn.disabled    = true;
    btn.textContent = '⏳ Submitting…';

    try {
      const fd = new FormData(this);
      Array.from(document.getElementById('fi').files).forEach(f => fd.append('files', f));

      const outcomes = [];
      document.querySelectorAll('[name^="outcome_index_"]').forEach(inp => {
        const i = parseInt(inp.value);
        outcomes.push({
          originalIndex:     i,
          status:            fd.get('outcome_status_'           + i),
          challenges:        fd.get('outcome_challenges_'       + i) || '',
          completionDetails: fd.get('outcome_completionDetails_'+ i) || '',
          delayReason:       fd.get('outcome_delayReason_'      + i) || ''
        });
      });
      fd.append('outcomes', JSON.stringify(outcomes));

      const r = await fetch('/api/submit-update/${directive._id}?token=${token || ''}',
                            { method: 'POST', body: fd });
      const j = await r.json();

      if (j.success) {
        document.getElementById('form').classList.add('hidden');
        document.getElementById('successMessage').classList.remove('hidden');
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } else {
        throw new Error(j.error || 'Submission failed');
      }
    } catch (err) {
      document.getElementById('form').classList.add('hidden');
      document.getElementById('errorText').textContent = err.message;
      document.getElementById('errorMessage').classList.remove('hidden');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  });
</script>
</body>
</html>`);
  } catch (e) { res.status(500).send('<h1>Error: ' + e.message + '</h1>'); }
});

// ─── Submission portal — POST ─────────────────────────────────
app.post('/api/submit-update/:id', upload, async (req, res) => {
  try {
    const { token } = req.query;
    if (token) {
      const rec = await SubmissionToken.findOne({ token });
      if (rec) {
        if (rec.used) return res.status(400).json({ success: false, error: 'Link already used' });
        rec.used = true; rec.usedAt = new Date(); await rec.save();
      }
    }

    const directive = await Directive.findById(req.params.id);
    if (!directive) return res.status(404).json({ success: false, error: 'Directive not found' });

    let updates = [];
    try {
      updates = typeof req.body.outcomes === 'string'
        ? JSON.parse(req.body.outcomes)
        : (Array.isArray(req.body.outcomes) ? req.body.outcomes : []);
    } catch (e) {
      return res.status(400).json({ success: false, error: 'Invalid decisions data' });
    }

    let changed = 0;
    updates.forEach(u => {
      const i = u.originalIndex;
      if (directive.outcomes[i]) {
        if (directive.outcomes[i].status !== u.status) changed++;
        directive.outcomes[i].status            = u.status;
        directive.outcomes[i].challenges        = u.challenges;
        directive.outcomes[i].completionDetails = u.completionDetails;
        directive.outcomes[i].delayReason       = u.delayReason;
      }
    });

    if (req.body.implementationStartDate) directive.implementationStartDate = new Date(req.body.implementationStartDate);
    if (req.body.implementationEndDate)   directive.implementationEndDate   = new Date(req.body.implementationEndDate);

    if (req.body.completionNote?.trim()) {
      const ts   = new Date().toLocaleString('en-GB', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' });
      const note = `[${ts}] ${req.body.completionNote.trim()}`;
      directive.additionalComments = directive.additionalComments?.trim()
        ? directive.additionalComments + '\n\n' + note : note;
    }

    if (req.files?.length) {
      directive.attachments = directive.attachments || [];
      req.files.forEach(f => directive.attachments.push({
        filename: f.filename, originalName: f.originalname,
        mimetype: f.mimetype, size: f.size, path: f.path,
        uploadedAt: new Date(), uploadedBy: directive.owner
      }));
    }

    directive.updateHistory = directive.updateHistory || [];
    directive.updateHistory.push({
      timestamp: new Date(), source: 'reminder-link',
      updatedBy: directive.owner, decisionChanges: changed,
      comment: req.body.completionNote || ''
    });

    directive.lastSbuUpdate = directive.lastResponseDate = new Date();
    await directive.updateMonitoringStatus('Update received via submission link');

    console.log(`✅ Directive ${directive.ref} updated — ${changed} status change(s), ${req.files?.length || 0} file(s) uploaded`);

    res.json({
      success:       true,
      message:       'Update submitted successfully',
      filesUploaded: req.files?.length || 0
    });
  } catch (e) {
    console.error('❌ Submission error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/submission-token/:token', async (req, res) => {
  try {
    const rec = await SubmissionToken.findOne({ token: req.params.token }).populate('directiveId');
    if (!rec) return res.status(404).json({ success: false, error: 'Invalid token' });
    if (rec.used) return res.json({ success: false, error: 'Already used', usedAt: rec.usedAt });
    if (rec.expiresAt < new Date()) return res.status(410).json({ success: false, error: 'Expired' });
    res.json({ success: true, directive: rec.directiveId, selectedOutcomes: rec.selectedOutcomes });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ─── Reminder settings ────────────────────────────────────────
app.get('/api/reminder-settings', async (req, res) => {
  try {
    let s = await ReminderSettings.findOne();
    if (!s) s = await ReminderSettings.create({ enabled: true, statusSettings: { 'On Track':true,'At Risk':true,'High Risk':true } });
    res.json({ success: true, data: s });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.put('/api/reminder-settings', async (req, res) => {
  try {
    let s = await ReminderSettings.findOne() || new ReminderSettings();
    s.enabled        = req.body.enabled;
    s.statusSettings = req.body.statusSettings;
    s.updatedAt      = new Date();
    await s.save();
    res.json({ success: true, data: s });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/reminders/send', async (req, res) => {
  try {
    await runReminders();
    res.json({ success: true, message: 'Reminders run' });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ─── Reports ─────────────────────────────────────────────────
app.get('/api/reports/stats', async (req, res) => {
  try {
    const { source } = req.query;
    const query = source && source !== 'All' ? { source } : {};

    const [total, completed, atRisk, highRisk, onTrack, noResp] = await Promise.all([
      Directive.countDocuments(query),
      Directive.countDocuments({ ...query, monitoringStatus: 'Completed' }),
      Directive.countDocuments({ ...query, monitoringStatus: 'At Risk' }),
      Directive.countDocuments({ ...query, monitoringStatus: 'High Risk' }),
      Directive.countDocuments({ ...query, monitoringStatus: 'On Track' }),
      Directive.countDocuments({ ...query, isResponsive: false })
    ]);

    // Decision-level breakdown
    const decAgg = await Directive.aggregate([
      { $match: query }, { $unwind: '$outcomes' },
      { $group: { _id: '$outcomes.status', count: { $sum: 1 } } }
    ]);
    const decisions = { 'Not Implemented':0, 'Being Implemented':0, 'Implemented':0, 'No Response':0 };
    decAgg.forEach(r => { if (decisions[r._id] !== undefined) decisions[r._id] = r.count; });

    // ⭐ Top 10 by DEPARTMENT (not by director/owner name)
    const top10Departments = await Directive.aggregate([
      { $match: query },
      { $group: {
          _id:         '$department',
          total:       { $sum: 1 },
          implemented: { $sum: { $cond: [{ $eq: ['$monitoringStatus','Completed'] }, 1, 0] } },
          atRisk:      { $sum: { $cond: [{ $in: ['$monitoringStatus',['At Risk','High Risk']] }, 1, 0] } }
        }
      },
      { $sort: { total: -1 } },
      { $limit: 10 }
    ]);

    const nonResponsive = await Directive.find({ ...query, isResponsive: false })
      .select('owner ref subject reminders lastReminderDate department');

    const trend = await Directive.aggregate([
      { $match: { ...query, monitoringStatus: 'Completed' } },
      { $group: { _id: { year: { $year: '$updatedAt' }, month: { $month: '$updatedAt' } }, count: { $sum: 1 } } },
      { $sort: { '_id.year': -1, '_id.month': -1 } },
      { $limit: 6 }
    ]);

    const now     = new Date();
    const overdue = await Directive.countDocuments({ ...query, implementationEndDate: { $lt: now }, monitoringStatus: { $ne: 'Completed' } });
    const dueSoon = await Directive.countDocuments({ ...query, implementationEndDate: { $gte: now, $lte: addDays(now,30) }, monitoringStatus: { $ne: 'Completed' } });

    res.json({
      success: true,
      data: {
        summary:        { total, completed, onTrack, atRisk, highRisk, noResp, risk: atRisk + highRisk + noResp },
        decisions,
        top10Departments,
        timeline:       { overdue, dueSoon },
        nonResponsive,
        completionTrend: trend,
        complianceRate: total > 0 ? ((completed / total) * 100).toFixed(1) : 0,
        riskRate:       total > 0 ? (((atRisk + highRisk + noResp) / total) * 100).toFixed(1) : 0
      }
    });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/reports/non-responsive', async (req, res) => {
  try {
    const { source } = req.query;
    const query = source && source !== 'All' ? { source } : {};
    const data = await Directive.find({ ...query, isResponsive: false }).sort({ reminders: -1 });
    res.json({ success: true, data });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ─── Lookup helpers ───────────────────────────────────────────
app.get('/api/process-owners', async (req, res) => {
  try {
    const owners = await Directive.distinct('owner');
    res.json({ success: true, data: owners.filter(o => o && o !== 'Unassigned').sort() });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/business-units', async (req, res) => {
  try {
    const units = await Directive.distinct('owner');
    res.json({ success: true, data: units.filter(u => u && u !== 'Unassigned').sort() });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/process-owners-with-directives', async (req, res) => {
  try {
    const directives = await Directive.find().sort({ owner: 1, createdAt: -1 });
    const map = new Map();
    directives.forEach(d => {
      if (!map.has(d.owner)) map.set(d.owner, {
        name:           d.owner,
        primaryEmail:   d.primaryEmail   || '',
        inCopy:         d.inCopy         || [],
        secondaryEmail: d.secondaryEmail || '',
        directiveCount: 0,
        directives:     []
      });
      const o = map.get(d.owner);
      o.directiveCount++;
      o.directives.push({ _id: d._id, ref: d.ref, subject: d.subject, source: d.source, monitoringStatus: d.monitoringStatus });
    });
    const owners = Array.from(map.values()).sort((a, b) => {
      const ah = !!a.primaryEmail, bh = !!b.primaryEmail;
      return ah === bh ? a.name.localeCompare(b.name) : ah ? 1 : -1;
    });
    res.json({ success: true, data: owners });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/update-owner-emails', async (req, res) => {
  try {
    const { owner, primaryEmail, inCopy, secondaryEmail } = req.body;
    if (!owner) return res.status(400).json({ success: false, error: 'Owner name required' });
    const update = {
      primaryEmail:   primaryEmail   || '',
      secondaryEmail: secondaryEmail || '',
      inCopy:         Array.isArray(inCopy) ? inCopy : (inCopy ? [inCopy] : [])
    };
    const r = await Directive.updateMany({ owner }, { $set: update });
    res.json({ success: true, updated: r.modifiedCount, message: `Updated ${r.modifiedCount} directives for ${owner}` });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ─── Process Owner Accounts ───────────────────────────────────

app.post('/api/process-owners/check-email', async (req, res) => {
  try {
    const email = req.body.email?.toLowerCase();
    if (!email) return res.status(400).json({ success: false, error: 'Email required' });
    const exists = await ProcessOwner.findOne({ email });
    if (exists) return res.json({ success: true, authorized: false, accountExists: true });
    const count = await Directive.countDocuments({ $or: [{ primaryEmail: email }, { inCopy: email }, { secondaryEmail: email }] });
    res.json({ success: true, authorized: count > 0, directivesCount: count });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/process-owners/signup', async (req, res) => {
  try {
    const { name, email, password, department, position, phone } = req.body;
    if (!name || !email || !password) return res.status(400).json({ success: false, error: 'Name, email and password required' });
    if (password.length < 8) return res.status(400).json({ success: false, error: 'Password must be at least 8 characters' });

    const emailLower = email.toLowerCase();
    const count = await Directive.countDocuments({ $or: [{ primaryEmail: emailLower }, { inCopy: emailLower }, { secondaryEmail: emailLower }] });
    if (count === 0) return res.status(403).json({ success: false, error: 'Email not authorized. Contact the Corporate Secretariat.', unauthorized: true });

    const existing = await ProcessOwner.findOne({ email: emailLower });
    if (existing) return res.status(400).json({ success: false, error: 'Account already exists.', accountExists: true });

    const po = new ProcessOwner({ name, email: emailLower, password, department, position, phone, isActive: true, passwordSetAt: new Date(), createdBy: 'self-signup' });
    await po.save();

    // Welcome email
    if (emailTransporter) {
      const baseUrl = process.env.BASE_URL || 'https://directives-new.onrender.com';
      await emailTransporter.sendMail({
        to:      email,
        subject: '🎉 Welcome to CBN Directives Platform',
        html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;background:white;
                    border-radius:12px;overflow:hidden;border:1px solid #e5e7eb;">
          <div style="padding:32px 24px;background:linear-gradient(135deg,#1B5E20 0%,#2E7D32 100%);
                      color:white;text-align:center;">
            <h1 style="margin:0;font-size:24px;">Welcome to CBN Directives Platform</h1>
          </div>
          <div style="padding:32px 24px;">
            <p>Dear <strong>${name}</strong>,</p>
            <p style="line-height:1.6;">Your account has been created. You can now log in to track and submit updates for all directives assigned to you.</p>
            <div style="background:#f9fafb;padding:16px;border-radius:8px;margin:24px 0;border-left:4px solid #1B5E20;">
              <div style="font-size:12px;color:#6b7280;margin-bottom:4px;">LOGIN EMAIL</div>
              <div style="font-size:16px;font-weight:600;color:#1B5E20;">${email}</div>
            </div>
            <div style="background:#E8F5E9;padding:16px;border-radius:8px;margin:24px 0;">
              <div style="font-size:14px;color:#1B5E20;font-weight:600;margin-bottom:4px;">
                📋 ${count} directive${count !== 1 ? 's' : ''} assigned to you
              </div>
            </div>
            <div style="text-align:center;margin:32px 0;">
              <a href="${baseUrl}/login.html"
                 style="background:linear-gradient(135deg,#1B5E20 0%,#2E7D32 100%);color:white;
                        text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:700;font-size:14px;">
                Log In Now
              </a>
            </div>
          </div>
          <div style="padding:16px 24px;background:#f9fafb;text-align:center;border-top:1px solid #e5e7eb;">
            <p style="margin:0;font-size:11px;color:#6b7280;">
              Central Bank of Nigeria – Directives Management System
            </p>
          </div>
        </div>`
      }).catch(e => console.error('Welcome email failed:', e.message));
    }

    res.json({ success: true, message: 'Account created. You can now log in.', owner: { id: po._id, name: po.name, email: po.email }, directivesCount: count });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});


app.post('/api/process-owners/create', async (req, res) => {
  try {
    const { name, email, department, position, phone } = req.body;
    if (!name || !email) return res.status(400).json({ success: false, error: 'Name and email required' });

    const emailLower = email.toLowerCase();

    // ── NEW: enforce max 3 login users per business unit ──────────
    if (department) {
      const usersInBU = await ProcessOwner.countDocuments({
        department,
        isActive: true
      });
      if (usersInBU >= 3) {
        return res.status(400).json({
          success: false,
          error: `Maximum of 3 login users allowed per business unit. "${department}" already has ${usersInBU} active user(s). Deactivate one before adding a new user.`,
          limitReached: true
        });
      }
    }
    // ─────────────────────────────────────────────────────────────

    const existing = await ProcessOwner.findOne({ email: emailLower });
    if (existing) return res.status(400).json({ success: false, error: 'Account already exists', accountExists: true });

    const setupToken   = crypto.randomBytes(32).toString('hex');
    const setupExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const po = new ProcessOwner({
      name, email: emailLower, department, position, phone,
      passwordSetupToken: setupToken, passwordSetupExpires: setupExpires,
      createdBy: req.body.adminUsername || 'admin', isActive: true
    });
    await po.save();

    const baseUrl  = process.env.BASE_URL || 'https://directives-new.onrender.com';
    const setupUrl = `${baseUrl}/setup-password.html?token=${setupToken}`;

    if (emailTransporter) {
      await emailTransporter.sendMail({
        to: email,
        subject: '🔐 Set Up Your CBN Directives Platform Password',
        html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;padding:32px;background:white;border-radius:12px;border:1px solid #e5e7eb;">
          <h2 style="color:#1B5E20;">Welcome to CBN Directives Platform</h2>
          <p>Dear <strong>${name}</strong>,</p>
          <p>An account has been created for you. Please set up your password:</p>
          <div style="text-align:center;margin:32px 0;">
            <a href="${setupUrl}" style="background:linear-gradient(135deg,#1B5E20,#2E7D32);color:white;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:700;">🔐 Set Up Password</a>
          </div>
          <p style="font-size:11px;color:#9ca3af;">Link expires in 7 days. ${setupUrl}</p>
        </div>`
      }).catch(e => console.error('Setup email failed:', e.message));
    }

    res.json({ success: true, message: 'Account created', processOwner: { id: po._id, name: po.name, email: po.email }, setupUrl });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});




app.get('/api/process-owners/validate-setup-token/:token', async (req, res) => {
  try {
    const po = await ProcessOwner.findOne({ passwordSetupToken: req.params.token, passwordSetupExpires: { $gt: Date.now() } });
    if (!po) return res.status(400).json({ success: false, error: 'Invalid or expired setup link' });
    res.json({ success: true, processOwner: { name: po.name, email: po.email } });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/process-owners/setup-password', async (req, res) => {
  try {
    const { token, password, confirmPassword } = req.body;
    if (!token || !password || !confirmPassword) return res.status(400).json({ success: false, error: 'All fields required' });
    if (password !== confirmPassword) return res.status(400).json({ success: false, error: 'Passwords do not match' });
    if (password.length < 8)         return res.status(400).json({ success: false, error: 'Min 8 characters' });

    const po = await ProcessOwner.findOne({ passwordSetupToken: token, passwordSetupExpires: { $gt: Date.now() } });
    if (!po) return res.status(400).json({ success: false, error: 'Invalid or expired link' });

    po.password             = password;
    po.passwordSetAt        = new Date();
    po.passwordSetupToken   = undefined;
    po.passwordSetupExpires = undefined;
    await po.save();

    res.json({ success: true, message: 'Password set. You can now log in.', email: po.email });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Login Step 1 — password check → send OTP
app.post('/api/process-owners/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ success: false, error: 'Email and password required' });

    const po = await ProcessOwner.findOne({ email: email.toLowerCase() });
    if (!po)           return res.status(401).json({ success: false, error: 'Invalid credentials' });
    if (!po.isActive)  return res.status(403).json({ success: false, error: 'Account deactivated' });
    if (!po.password)  return res.status(403).json({ success: false, error: 'Password not set up yet. Check your email.', needsPasswordSetup: true });
    if (po.isLocked()) return res.status(423).json({ success: false, error: 'Account locked due to failed attempts. Try again later.' });

    const ok = await po.comparePassword(password);
    if (!ok) {
      po.failedLoginAttempts = (po.failedLoginAttempts || 0) + 1;
      if (po.failedLoginAttempts >= 5) po.accountLockedUntil = new Date(Date.now() + 30 * 60 * 1000);
      await po.save();
      return res.status(401).json({ success: false, error: `Invalid credentials. ${Math.max(0, 5 - po.failedLoginAttempts)} attempt(s) remaining.` });
    }

    po.failedLoginAttempts = 0; po.accountLockedUntil = undefined;
    await po.save();

    await sendOtp(po.email, po.name);
    res.json({ success: true, step: '2fa', email: po.email, message: `A 6-digit code was sent to ${po.email}` });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Login Step 2 — OTP verify → issue token
app.post('/api/process-owners/verify-otp', async (req, res) => {
  try {
    const { email, otp } = req.body;
    const rec = await Otp.findOne({ email: email.toLowerCase(), used: false });
    if (!rec || new Date() > rec.expiresAt) return res.status(401).json({ success: false, error: 'OTP expired or invalid' });
    const ok = await bcrypt.compare(String(otp), rec.otpHash);
    if (!ok) return res.status(401).json({ success: false, error: 'Incorrect code' });
    rec.used = true; await rec.save();

    const po = await ProcessOwner.findOne({ email: email.toLowerCase() });
    po.lastLogin = new Date(); await po.save();

    const token = crypto.randomBytes(32).toString('hex');
    res.json({ success: true, token, userType: 'process-owner', owner: { id: po._id, name: po.name, email: po.email, department: po.department } });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/process-owners/request-password-reset', async (req, res) => {
  try {
    const po = await ProcessOwner.findOne({ email: req.body.email?.toLowerCase() });
    if (!po) return res.json({ success: true, message: 'If an account exists, reset instructions were sent.' });

    const token = crypto.randomBytes(32).toString('hex');
    po.passwordResetToken   = token;
    po.passwordResetExpires = new Date(Date.now() + 60 * 60 * 1000);
    await po.save();

    const baseUrl  = process.env.BASE_URL || 'https://directives-new.onrender.com';
    const resetUrl = `${baseUrl}/reset-password.html?token=${token}`;

    if (emailTransporter) {
      await emailTransporter.sendMail({
        to:      po.email,
        subject: '🔐 Password Reset – CBN Directives Platform',
        html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;padding:32px;background:white;border-radius:12px;border:1px solid #e5e7eb;">
          <h2 style="color:#1B5E20;">Password Reset Request</h2>
          <p>Dear <strong>${po.name}</strong>,</p>
          <p>Click below to reset your password (expires in 1 hour):</p>
          <div style="text-align:center;margin:32px 0;">
            <a href="${resetUrl}" style="background:linear-gradient(135deg,#1B5E20 0%,#2E7D32 100%);color:white;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:700;">🔐 Reset Password</a>
          </div>
          <p style="color:#6b7280;font-size:13px;">If you didn't request this, ignore this email.</p>
        </div>`
      }).catch(() => {});
    }

    res.json({ success: true, message: 'If an account exists, reset instructions were sent.' });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/process-owners/reset-password', async (req, res) => {
  try {
    const { token, password, confirmPassword } = req.body;
    if (password !== confirmPassword) return res.status(400).json({ success: false, error: 'Passwords do not match' });
    if (password.length < 8)         return res.status(400).json({ success: false, error: 'Min 8 characters' });

    const po = await ProcessOwner.findOne({ passwordResetToken: token, passwordResetExpires: { $gt: Date.now() } });
    if (!po) return res.status(400).json({ success: false, error: 'Invalid or expired link' });

    po.password             = password;
    po.passwordResetToken   = undefined;
    po.passwordResetExpires = undefined;
    po.failedLoginAttempts  = 0;
    po.accountLockedUntil   = undefined;
    await po.save();

    res.json({ success: true, message: 'Password reset. You can now log in.' });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// List all
app.get('/api/process-owners/accounts', async (req, res) => {
  try {
    const users = await ProcessOwner.find()
      .select('-passwordSetupToken -passwordResetToken') // keep password hash for check
      .sort({ name: 1 });

    const data = users.map(u => {
      const obj = u.toObject();
      obj.hasPassword = !!obj.password;  // safe computed field
      delete obj.password;               // never send hash to browser
      return obj;
    });

    res.json({ success: true, data, total: data.length });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});



// Get one — ORIGINAL route path kept to avoid breaking frontend
app.get('/api/process-owners/:id', async (req, res) => {
  try {
    const po = await ProcessOwner.findById(req.params.id).select('-password -passwordSetupToken -passwordResetToken');
    if (!po) return res.status(404).json({ success: false, error: 'Not found' });
    res.json({ success: true, data: po, status: { hasPassword: !!po.password, isActive: po.isActive } });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Update — ORIGINAL route path kept

app.patch('/api/process-owners/:id', async (req, res) => {
  try {
    const { name, email, department, position, phone } = req.body;  // Added: phone
    const po = await ProcessOwner.findById(req.params.id);
    if (!po) return res.status(404).json({ success: false, error: 'Not found' });

    if (email && email !== po.email) {
      const dup = await ProcessOwner.findOne({
        email: email.toLowerCase(), _id: { $ne: req.params.id }
      });
      if (dup) return res.status(400).json({ success: false, error: 'Email already in use' });
    }

    if (name)                     po.name       = name;
    if (email)                    po.email      = email.toLowerCase();
    if (department !== undefined) po.department = department;
    if (position   !== undefined) po.position   = position;
    if (phone      !== undefined) po.phone      = phone;  // NEW LINE
    await po.save();

    res.json({ success: true, data: { id: po._id, name: po.name, email: po.email } });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});




// Toggle active — ORIGINAL route path kept
app.patch('/api/process-owners/:id/toggle-active', async (req, res) => {
  try {
    const po = await ProcessOwner.findById(req.params.id);
    if (!po) return res.status(404).json({ success: false, error: 'Not found' });
    po.isActive = !po.isActive;
    await po.save();
    res.json({ success: true, message: `Account ${po.isActive ? 'activated' : 'deactivated'}`, isActive: po.isActive });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Resend setup email — ORIGINAL route path kept
app.post('/api/process-owners/:id/resend-setup', async (req, res) => {
  try {
    const po = await ProcessOwner.findById(req.params.id);
    if (!po)          return res.status(404).json({ success: false, error: 'Not found' });
    if (po.password)  return res.status(400).json({ success: false, error: 'Password already set. Use reset instead.' });
    if (!po.isActive) return res.status(400).json({ success: false, error: 'Account deactivated' });

    const setupToken   = crypto.randomBytes(32).toString('hex');
    po.passwordSetupToken   = setupToken;
    po.passwordSetupExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await po.save();

    const baseUrl  = process.env.BASE_URL || 'https://directives-new.onrender.com';
    const setupUrl = `${baseUrl}/setup-password.html?token=${setupToken}`;

    if (!emailTransporter) return res.status(500).json({ success: false, error: 'Email not configured', setupUrl });

    await emailTransporter.sendMail({
      to:      po.email,
      subject: '🔐 Reminder: Set Up Your CBN Directives Password',
      html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;padding:32px;background:white;border-radius:12px;border:1px solid #e5e7eb;">
        <h2 style="color:#1B5E20;">Complete Your Account Setup</h2>
        <p>Dear <strong>${po.name}</strong>,</p>
        <p>Please set up your password by clicking below (link expires in 7 days):</p>
        <div style="text-align:center;margin:32px 0;">
          <a href="${setupUrl}" style="background:linear-gradient(135deg,#1B5E20 0%,#2E7D32 100%);color:white;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:700;">🔐 Set Up Password</a>
        </div>
        <p style="font-size:11px;color:#9ca3af;word-break:break-all;">${setupUrl}</p>
      </div>`
    });

    res.json({ success: true, message: 'Setup email resent', setupUrl, expiresIn: '7 days' });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ⭐ DELETE process owner — ORIGINAL route path kept




app.delete('/api/process-owners/:id', async (req, res) => {
  try {
    const po = await ProcessOwner.findByIdAndDelete(req.params.id);
    if (!po) return res.status(404).json({ success: false, error: 'Not found' });
    console.log(`⚠️  Process owner deleted: ${po.email} by ${req.body.adminUsername || 'admin'}`);
    res.json({ success: true, message: `Account for ${po.name} (${po.email}) deleted`, deleted: { name: po.name, email: po.email, deletedAt: new Date() } });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});




app.get('/api/process-owners/:email/pending-directives', async (req, res) => {
  try {
    const email = req.params.email.toLowerCase();
    const data  = await Directive.find({ $or: [{ primaryEmail: email }, { inCopy: email }, { secondaryEmail: email }] });
    res.json({ success: true, data });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ─── Debug endpoints ──────────────────────────────────────────
app.get('/submit-update/test', (req, res) => res.send('<h1>✅ Route working</h1>'));

app.get('/api/debug-token/:token', async (req, res) => {
  try {
    const rec = await SubmissionToken.findOne({ token: req.params.token });
    if (!rec) return res.json({ found: false, token: req.params.token });
    const d = await Directive.findById(rec.directiveId);
    res.json({ found: true, directiveRef: d?.ref, selectedDecisions: rec.selectedOutcomes, used: rec.used, createdAt: rec.createdAt });
  } catch (e) { res.json({ error: e.message }); }
});

// ─── Static fallback ──────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ─── Start server ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 CBN Directives Platform`);
  console.log(`📍 Port:    ${PORT}`);
  console.log(`💾 MongoDB: ${mongoose.connection.readyState === 1 ? '✅ Connected' : '⏳ Connecting…'}`);
  console.log(`📧 Email:   ${emailTransporter ? '✅ Configured' : '❌ Not configured'}`);
  console.log(`\nActive terminology:`);
  console.log(`  "Committee of Board" | "Business Unit" | "Decisions"`);
  console.log(`  Statuses: Not Implemented / Being Implemented / Implemented / No Response`);
  console.log(`  inCopy[] (multiple CC) | Departments max 3 | 2FA enabled\n`);
});



// ============================================================
// ADMIN USER SYSTEM — paste this into server.js
// ============================================================
// Instructions:
//   1. Paste the SCHEMA section after the ProcessOwner schema
//   2. Paste the ROUTES section after the existing admin login routes
//   3. Replace the old /api/auth/admin/login and /api/auth/admin/verify-otp routes
// ============================================================


// ════════════════════════════════════════════════════════════
// SECTION 1 — AdminUser Schema (paste after ProcessOwner schema)
// ════════════════════════════════════════════════════════════

const AdminUserSchema = new mongoose.Schema({
  name:     { type: String, required: true, trim: true },
  email:    { type: String, required: true, unique: true, lowercase: true, trim: true },
  password: String,

  // Roles:
  //   super_admin — manages other admins, full system access
  //   admin       — full directives access, cannot manage admins
  //   viewer      — read-only, cannot send reminders or edit
  role: {
    type:    String,
    enum:    ['super_admin', 'admin', 'viewer'],
    default: 'admin'
  },

  isActive:             { type: Boolean, default: true },
  passwordSetupToken:   String,
  passwordSetupExpires: Date,
  passwordResetToken:   String,
  passwordResetExpires: Date,
  createdBy:            String,
  createdAt:            { type: Date, default: Date.now },
  passwordSetAt:        Date,
  lastLogin:            Date,
  failedLoginAttempts:  { type: Number, default: 0 },
  accountLockedUntil:   Date
});

AdminUserSchema.pre('save', async function (next) {
  if (!this.isModified('password') || !this.password) return next();
  const salt    = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

AdminUserSchema.methods.comparePassword = async function (p) {
  if (!this.password) return false;
  return bcrypt.compare(p, this.password);
};

AdminUserSchema.methods.isLocked = function () {
  return !!(this.accountLockedUntil && this.accountLockedUntil > Date.now());
};

const AdminUser = mongoose.model('AdminUser', AdminUserSchema);


// ════════════════════════════════════════════════════════════
// SECTION 2 — Auth Middleware (paste near top with other middleware)
// ════════════════════════════════════════════════════════════

// Simple token-based session store (in-memory; survives restarts only)
// For production swap this for Redis or signed JWTs
// ── Persistent admin sessions (survives server restarts) ──────
const AdminSessionSchema = new mongoose.Schema({
  token:     { type: String, required: true, unique: true },
  adminId:   { type: String, required: true },
  role:      String,
  email:     String,
  name:      String,
  createdAt: { type: Date, default: Date.now, expires: 28800 } // 8-hour TTL
});
const AdminSession = mongoose.model('AdminSession', AdminSessionSchema);

function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (!token) return res.status(401).json({ success: false, error: 'Unauthorized' });
  AdminSession.findOne({ token })
    .then(session => {
      if (!session) return res.status(401).json({ success: false, error: 'Session expired. Please log in again.' });
      req.adminSession = { adminId: session.adminId, role: session.role, email: session.email, name: session.name };
      next();
    })
    .catch(e => res.status(500).json({ success: false, error: e.message }));
}

function requireSuperAdmin(req, res, next) {
  requireAdmin(req, res, () => {
    if (req.adminSession.role !== 'super_admin')
      return res.status(403).json({ success: false, error: 'Super Admin access required' });
    next();
  });
}




// ════════════════════════════════════════════════════════════
// SECTION 3 — Admin Auth Routes
// REPLACE the old /api/auth/admin/login and verify-otp routes with these
// ════════════════════════════════════════════════════════════

// Step 1 — Email + Password → OTP
app.post('/api/auth/admin/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ success: false, error: 'Email and password required' });

    const admin = await AdminUser.findOne({ email: email.toLowerCase() });
    if (!admin)
      return res.status(401).json({ success: false, error: 'Invalid credentials' });

    if (!admin.isActive)
      return res.status(403).json({ success: false, error: 'Account deactivated. Contact your system administrator.' });

    if (!admin.password)
      return res.status(403).json({
        success: false,
        error:   'Password not set up yet. Check your email for a setup link.',
        needsPasswordSetup: true
      });

    if (admin.isLocked())
      return res.status(423).json({
        success: false,
        error:   'Account temporarily locked due to failed attempts. Try again in 30 minutes.'
      });

    const ok = await admin.comparePassword(password);
    if (!ok) {
      admin.failedLoginAttempts = (admin.failedLoginAttempts || 0) + 1;
      if (admin.failedLoginAttempts >= 5)
        admin.accountLockedUntil = new Date(Date.now() + 30 * 60 * 1000);
      await admin.save();
      const remaining = Math.max(0, 5 - admin.failedLoginAttempts);
      return res.status(401).json({
        success: false,
        error:   `Invalid credentials. ${remaining} attempt(s) remaining before lockout.`
      });
    }

    // Reset failed attempts on success
    admin.failedLoginAttempts = 0;
    admin.accountLockedUntil  = undefined;
    await admin.save();

    await sendOtp(admin.email, admin.name);
    res.json({
      success: true,
      step:    '2fa',
      email:   admin.email,
      message: `A 6-digit code was sent to ${admin.email}`
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Step 2 — Verify OTP → issue session token
app.post('/api/auth/admin/verify-otp', async (req, res) => {
  try {
    const { email, otp } = req.body;
    const rec = await Otp.findOne({ email: email.toLowerCase(), used: false });

    if (!rec || new Date() > rec.expiresAt)
      return res.status(401).json({ success: false, error: 'OTP expired or invalid. Request a new one.' });

    const ok = await bcrypt.compare(String(otp), rec.otpHash);
    if (!ok)
      return res.status(401).json({ success: false, error: 'Incorrect code. Please try again.' });

    rec.used = true;
    await rec.save();

    const admin = await AdminUser.findOne({ email: email.toLowerCase() });
    admin.lastLogin = new Date();
    await admin.save();

    // Issue session token
// Issue persistent session token stored in MongoDB
    const token = crypto.randomBytes(32).toString('hex');
    await AdminSession.create({
      token,
      adminId: admin._id.toString(),
      role:    admin.role,
      email:   admin.email,
      name:    admin.name
    });
   // Auto-expire session after 8 hours
    setTimeout(() => adminSessions.delete(token), 8 * 60 * 60 * 1000);

    res.json({
      success:  true,
      token,
      userType: 'admin',
      admin: {
        id:    admin._id,
        name:  admin.name,
        email: admin.email,
        role:  admin.role
      },
      message: 'Login successful'
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Password setup (from email link)
app.get('/api/auth/admin/validate-setup-token/:token', async (req, res) => {
  try {
    const admin = await AdminUser.findOne({
      passwordSetupToken:   req.params.token,
      passwordSetupExpires: { $gt: Date.now() }
    });
    if (!admin)
      return res.status(400).json({ success: false, error: 'Invalid or expired setup link' });
    res.json({ success: true, admin: { name: admin.name, email: admin.email, role: admin.role } });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/auth/admin/setup-password', async (req, res) => {
  try {
    const { token, password, confirmPassword } = req.body;
    if (!token || !password || !confirmPassword)
      return res.status(400).json({ success: false, error: 'All fields required' });
    if (password !== confirmPassword)
      return res.status(400).json({ success: false, error: 'Passwords do not match' });
    if (password.length < 8)
      return res.status(400).json({ success: false, error: 'Password must be at least 8 characters' });

    const admin = await AdminUser.findOne({
      passwordSetupToken:   token,
      passwordSetupExpires: { $gt: Date.now() }
    });
    if (!admin)
      return res.status(400).json({ success: false, error: 'Invalid or expired setup link' });

    admin.password             = password;
    admin.passwordSetAt        = new Date();
    admin.passwordSetupToken   = undefined;
    admin.passwordSetupExpires = undefined;
    await admin.save();

    res.json({ success: true, message: 'Password set. You can now log in.', email: admin.email });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Password reset request
app.post('/api/auth/admin/request-password-reset', async (req, res) => {
  try {
    const admin = await AdminUser.findOne({ email: req.body.email?.toLowerCase() });
    if (!admin)
      return res.json({ success: true, message: 'If an account exists, reset instructions were sent.' });

    const token = crypto.randomBytes(32).toString('hex');
    admin.passwordResetToken   = token;
    admin.passwordResetExpires = new Date(Date.now() + 60 * 60 * 1000);
    await admin.save();

    const baseUrl  = process.env.BASE_URL || 'http://localhost:3001';
    const resetUrl = `${baseUrl}/admin-reset-password.html?token=${token}`;

    if (emailTransporter) {
      await emailTransporter.sendMail({
        to:      admin.email,
        subject: '🔐 Admin Password Reset – CBN Directives Platform',
        html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;padding:32px;
                    background:white;border-radius:12px;border:1px solid #e5e7eb;">
          <h2 style="color:#1B5E20;">Admin Password Reset</h2>
          <p>Dear <strong>${admin.name}</strong>,</p>
          <p>A password reset was requested for your admin account (${admin.role}).</p>
          <p>Click below to reset your password (expires in 1 hour):</p>
          <div style="text-align:center;margin:32px 0;">
            <a href="${resetUrl}"
               style="background:linear-gradient(135deg,#1B5E20,#2E7D32);color:white;
                      text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:700;">
              🔐 Reset Password
            </a>
          </div>
          <p style="color:#6b7280;font-size:13px;">
            If you didn't request this, ignore this email.
            Your password will not change unless you click the link above.
          </p>
        </div>`
      }).catch(() => {});
    }

    res.json({ success: true, message: 'If an account exists, reset instructions were sent.' });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/auth/admin/reset-password', async (req, res) => {
  try {
    const { token, password, confirmPassword } = req.body;
    if (password !== confirmPassword)
      return res.status(400).json({ success: false, error: 'Passwords do not match' });
    if (password.length < 8)
      return res.status(400).json({ success: false, error: 'Minimum 8 characters required' });

    const admin = await AdminUser.findOne({
      passwordResetToken:   token,
      passwordResetExpires: { $gt: Date.now() }
    });
    if (!admin)
      return res.status(400).json({ success: false, error: 'Invalid or expired reset link' });

    admin.password             = password;
    admin.passwordResetToken   = undefined;
    admin.passwordResetExpires = undefined;
    admin.failedLoginAttempts  = 0;
    admin.accountLockedUntil   = undefined;
    await admin.save();

    res.json({ success: true, message: 'Password reset successfully. You can now log in.' });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Logout (invalidate session token)
app.post('/api/auth/admin/logout', async (req, res) => {
  const token = req.headers['x-admin-token'];
  if (token) await AdminSession.deleteOne({ token }).catch(() => {});
  res.json({ success: true, message: 'Logged out' });
});





// Verify session (for frontend auth check)
app.get('/api/auth/admin/me', requireAdmin, async (req, res) => {
  try {
    const admin = await AdminUser.findById(req.adminSession.adminId)
      .select('-password -passwordSetupToken -passwordResetToken');
    if (!admin) return res.status(404).json({ success: false, error: 'Admin not found' });
    res.json({ success: true, admin, session: req.adminSession });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});


// ════════════════════════════════════════════════════════════
// SECTION 4 — Admin Management Routes (super_admin only for destructive actions)
// ════════════════════════════════════════════════════════════

// List all admins
app.get('/api/admin-users', requireAdmin, async (req, res) => {
  try {
    const admins = await AdminUser.find()
      .select('-passwordSetupToken -passwordResetToken') // keep password hash for check
      .sort({ createdAt: -1 });

    const data = admins.map(a => {
      const obj = a.toObject();
      obj.hasPassword = !!obj.password; // computed field the frontend uses
      delete obj.password;              // never send the hash to the browser
      return obj;
    });

    res.json({ success: true, data, total: data.length });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});



// Create admin (super_admin only)
app.post('/api/admin-users', requireSuperAdmin, async (req, res) => {
  try {
    const { name, email, role } = req.body;
    if (!name || !email)
      return res.status(400).json({ success: false, error: 'Name and email required' });

    const validRoles = ['super_admin', 'admin', 'viewer'];
    if (role && !validRoles.includes(role))
      return res.status(400).json({ success: false, error: 'Invalid role' });

    const exists = await AdminUser.findOne({ email: email.toLowerCase() });
    if (exists)
      return res.status(400).json({ success: false, error: 'An admin with this email already exists' });

    const setupToken   = crypto.randomBytes(32).toString('hex');
    const setupExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    const admin = new AdminUser({
      name,
      email:               email.toLowerCase(),
      role:                role || 'admin',
      isActive:            true,
      passwordSetupToken:  setupToken,
      passwordSetupExpires: setupExpires,
      createdBy:           req.adminSession.email
    });
    await admin.save();

    const baseUrl  = process.env.BASE_URL || 'http://localhost:3001';
    const setupUrl = `${baseUrl}/admin-setup-password.html?token=${setupToken}`;

    if (emailTransporter) {
      const roleLabel = { super_admin: 'Super Administrator', admin: 'Administrator', viewer: 'Viewer' }[admin.role] || admin.role;
      await emailTransporter.sendMail({
        to:      email,
        subject: '🔐 Set Up Your CBN Directives Admin Account',
        html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;background:white;
                    border-radius:12px;overflow:hidden;border:1px solid #e5e7eb;">
          <div style="padding:32px 24px;
                      background:linear-gradient(135deg,#1B5E20 0%,#2E7D32 100%);
                      color:white;text-align:center;">
            <h1 style="margin:0;font-size:22px;">Welcome to CBN Directives Admin Portal</h1>
            <p style="margin:8px 0 0;opacity:.85;font-size:13px;">You have been granted ${roleLabel} access</p>
          </div>
          <div style="padding:32px 24px;">
            <p>Dear <strong>${name}</strong>,</p>
            <p style="line-height:1.6;">
              An admin account has been created for you on the
              <strong>CBN Directives Management Platform</strong>.
              Please set up your password to activate it.
            </p>
            <div style="background:#f9fafb;padding:16px;border-radius:8px;margin:24px 0;
                        border-left:4px solid #1B5E20;">
              <div style="font-size:11px;color:#6b7280;margin-bottom:4px;">YOUR LOGIN EMAIL</div>
              <div style="font-size:16px;font-weight:600;color:#1B5E20;">${email}</div>
              <div style="font-size:11px;color:#6b7280;margin-top:8px;">ROLE</div>
              <div style="font-size:14px;font-weight:600;color:#374151;">${roleLabel}</div>
            </div>
            <div style="text-align:center;margin:32px 0;">
              <a href="${setupUrl}"
                 style="background:linear-gradient(135deg,#1B5E20,#2E7D32);color:white;
                        text-decoration:none;padding:14px 32px;border-radius:8px;
                        font-weight:700;font-size:14px;">
                🔐 Set Up Your Password
              </a>
            </div>
            <p style="font-size:11px;color:#9ca3af;word-break:break-all;">${setupUrl}</p>
            <div style="background:#FEF3C7;padding:12px;border-radius:8px;margin:24px 0;">
              <div style="font-size:12px;color:#92400E;">
                ⏰ <strong>Important:</strong> This link expires in 7 days.
              </div>
            </div>
          </div>
          <div style="padding:16px 24px;background:#f9fafb;text-align:center;
                      border-top:1px solid #e5e7eb;">
            <p style="margin:0;font-size:11px;color:#6b7280;">
              Central Bank of Nigeria – Directives Management System
            </p>
          </div>
        </div>`
      }).catch(e => console.error('Setup email failed:', e.message));
    }

    const safeAdmin = admin.toObject();
    delete safeAdmin.passwordSetupToken;
    delete safeAdmin.passwordSetupExpires;

    res.json({
      success:  true,
      message:  `Admin account created for ${name}. Setup email sent.`,
      admin:    safeAdmin,
      setupUrl  // returned in case email fails
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Get one admin
app.get('/api/admin-users/:id', requireAdmin, async (req, res) => {
  try {
    const admin = await AdminUser.findById(req.params.id)
      .select('-password -passwordSetupToken -passwordResetToken');
    if (!admin) return res.status(404).json({ success: false, error: 'Admin not found' });
    res.json({
      success: true,
      admin,
      status: {
        hasPassword:    !!admin.password,
        isLocked:       admin.isLocked(),
        setupPending:   !!admin.passwordSetupToken,
        lastLogin:      admin.lastLogin
      }
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Update admin (name, role) — super_admin only for role changes
app.patch('/api/admin-users/:id', requireAdmin, async (req, res) => {
  try {
    const { name, role } = req.body;
    const admin = await AdminUser.findById(req.params.id);
    if (!admin) return res.status(404).json({ success: false, error: 'Admin not found' });

    // Only super_admin can change roles
    if (role && req.adminSession.role !== 'super_admin')
      return res.status(403).json({ success: false, error: 'Only Super Admins can change roles' });

    // Prevent the only super_admin from demoting themselves
    if (role && role !== 'super_admin' && req.adminSession.adminId === admin._id.toString()) {
      const superAdminCount = await AdminUser.countDocuments({ role: 'super_admin', isActive: true });
      if (superAdminCount <= 1)
        return res.status(400).json({
          success: false,
          error:   'Cannot demote the only active Super Admin. Promote another admin first.'
        });
    }

    if (name) admin.name = name;
    if (role) admin.role = role;
    await admin.save();

    res.json({ success: true, message: 'Admin updated', admin: { id: admin._id, name: admin.name, email: admin.email, role: admin.role } });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Toggle active/inactive (super_admin only)
app.patch('/api/admin-users/:id/toggle-active', requireSuperAdmin, async (req, res) => {
  try {
    const admin = await AdminUser.findById(req.params.id);
    if (!admin) return res.status(404).json({ success: false, error: 'Admin not found' });

    // Prevent deactivating self
    if (req.adminSession.adminId === admin._id.toString())
      return res.status(400).json({ success: false, error: 'You cannot deactivate your own account' });

    // Prevent deactivating last super_admin
    if (admin.role === 'super_admin' && admin.isActive) {
      const activeSupers = await AdminUser.countDocuments({ role: 'super_admin', isActive: true });
      if (activeSupers <= 1)
        return res.status(400).json({
          success: false,
          error:   'Cannot deactivate the only active Super Admin'
        });
    }

    admin.isActive = !admin.isActive;
    await admin.save();

    // Invalidate any active sessions for this admin
   await AdminSession.deleteMany({ adminId: admin._id.toString() }).catch(() => {});


    res.json({
      success:  true,
      message:  `Account ${admin.isActive ? 'activated' : 'deactivated'}`,
      isActive: admin.isActive
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Unlock locked account (super_admin only)
app.patch('/api/admin-users/:id/unlock', requireSuperAdmin, async (req, res) => {
  try {
    const admin = await AdminUser.findById(req.params.id);
    if (!admin) return res.status(404).json({ success: false, error: 'Admin not found' });

    admin.failedLoginAttempts = 0;
    admin.accountLockedUntil  = undefined;
    await admin.save();

    res.json({ success: true, message: `Account unlocked for ${admin.name}` });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Resend setup email (super_admin only)
app.post('/api/admin-users/:id/resend-setup', requireSuperAdmin, async (req, res) => {
  try {
    const admin = await AdminUser.findById(req.params.id);
    if (!admin) return res.status(404).json({ success: false, error: 'Admin not found' });
    if (admin.password)
      return res.status(400).json({ success: false, error: 'Password already set. Use password reset instead.' });

    const setupToken   = crypto.randomBytes(32).toString('hex');
    admin.passwordSetupToken   = setupToken;
    admin.passwordSetupExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await admin.save();

    const baseUrl  = process.env.BASE_URL || 'http://localhost:3001';
    const setupUrl = `${baseUrl}/admin-setup-password.html?token=${setupToken}`;

    if (emailTransporter) {
      await emailTransporter.sendMail({
        to:      admin.email,
        subject: '🔐 Reminder: Complete Your CBN Directives Admin Setup',
        html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;padding:32px;
                    background:white;border-radius:12px;border:1px solid #e5e7eb;">
          <h2 style="color:#1B5E20;">Complete Your Account Setup</h2>
          <p>Dear <strong>${admin.name}</strong>,</p>
          <p>Please set up your admin password by clicking the link below (expires in 7 days):</p>
          <div style="text-align:center;margin:32px 0;">
            <a href="${setupUrl}"
               style="background:linear-gradient(135deg,#1B5E20,#2E7D32);color:white;
                      text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:700;">
              🔐 Set Up Password
            </a>
          </div>
          <p style="font-size:11px;color:#9ca3af;word-break:break-all;">${setupUrl}</p>
        </div>`
      });
    }

    res.json({ success: true, message: 'Setup email resent', setupUrl, expiresIn: '7 days' });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Delete admin (super_admin only — permanent)
app.delete('/api/admin-users/:id', requireSuperAdmin, async (req, res) => {
  try {
    const admin = await AdminUser.findById(req.params.id);
    if (!admin) return res.status(404).json({ success: false, error: 'Admin not found' });

    // Cannot delete self
    if (req.adminSession.adminId === admin._id.toString())
      return res.status(400).json({ success: false, error: 'You cannot delete your own account' });

    // Prevent deleting last super_admin
    if (admin.role === 'super_admin') {
      const superCount = await AdminUser.countDocuments({ role: 'super_admin' });
      if (superCount <= 1)
        return res.status(400).json({
          success: false,
          error:   'Cannot delete the only Super Admin account'
        });
    }

    // Invalidate sessions
  await AdminSession.deleteMany({ adminId: admin._id.toString() }).catch(() => {});


    await AdminUser.findByIdAndDelete(req.params.id);
    console.log(`⚠️  Admin deleted: ${admin.email} by ${req.adminSession.email}`);

    res.json({
      success: true,
      message: `Admin account for ${admin.name} (${admin.email}) permanently deleted`,
      deleted: { name: admin.name, email: admin.email, role: admin.role, deletedAt: new Date() }
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});