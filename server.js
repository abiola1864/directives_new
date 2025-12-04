// Backend Server for CBN Directives Platform - COMPLETE WITH EMAIL
// File: server.js

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const { google } = require('googleapis');
const cron = require('node-cron');
const nodemailer = require('nodemailer');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// MongoDB Connection
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://oyebanjoabiola_db_user:83kDNVz6CN6sGUsv@cluster0.mkj92f1.mongodb.net/cbn_directives?retryWrites=true&w=majority';

mongoose.connect(MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
.then(() => console.log('✅ MongoDB Atlas Connected'))
.catch(err => console.error('❌ MongoDB Connection Error:', err));

// ==========================================
// EMAIL CONFIGURATION
// ==========================================

let emailTransporter = null;

function setupEmailTransporter() {
  try {
    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASSWORD) {
      console.log('⚠️  Email credentials not found in .env file');
      return null;
    }

    emailTransporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASSWORD
      }
    });

    // Verify connection
    emailTransporter.verify((error, success) => {
      if (error) {
        console.log('❌ Email server connection failed:', error.message);
        emailTransporter = null;
      } else {
        console.log('✅ Email server is ready to send messages');
      }
    });

    return emailTransporter;
  } catch (error) {
    console.error('❌ Error setting up email:', error.message);
    return null;
  }
}

// Initialize email transporter
setupEmailTransporter();

// ==========================================
// ENHANCED MONGODB SCHEMA WITH EMAIL
// ==========================================

const statusHistorySchema = new mongoose.Schema({
  status: String,
  changedAt: { type: Date, default: Date.now },
  changedBy: String,
  notes: String
});

const reminderHistorySchema = new mongoose.Schema({
  sentAt: { type: Date, default: Date.now },
  recipient: String,
  method: { type: String, enum: ['Email', 'System'], default: 'Email' },
  acknowledged: { type: Boolean, default: false }
});

const directiveSchema = new mongoose.Schema({
  source: { type: String, required: true, enum: ['CG', 'Board'] },
  sheetName: { type: String, required: true },
  meetingDate: { type: Date, required: true },
  subject: { type: String, required: true },
  particulars: { type: String, required: true },
  owner: { type: String, required: true },
  
  // EMAIL FIELDS - NEW
  primaryEmail: { type: String, required: true },
  secondaryEmail: { type: String, default: '' },
  
  amount: String,
  vendor: String,
  implementationStartDate: Date,
  implementationEndDate: Date,
  implementationStatus: { type: String, default: 'Not Started' },
  ref: { type: String, unique: true, sparse: true },
  
  monitoringStatus: {
    type: String,
    enum: ['Awaiting Next Reminder', 'At Risk', 'High Risk', 'Non-Responsive', 'Completed'],
    default: 'Awaiting Next Reminder'
  },
  statusHistory: [statusHistorySchema],
  
  reminders: { type: Number, default: 0 },
  lastReminderDate: Date,
  reminderHistory: [reminderHistorySchema],
  
  isResponsive: { type: Boolean, default: true },
  lastResponseDate: Date,
  
  completionNote: String,
  outcomes: [{
    text: { type: String, maxlength: 800 },
    status: { 
      type: String, 
      enum: ['Not Started', 'Being Implemented', 'Delayed', 'Completed'], 
      default: 'Not Started' 
    },
    completionDetails: String,
    delayReason: String,
    challenges: String,
    impliedDeadline: String,
    impliedAmount: String,
    impliedResponsible: String
  }],
  
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
  lastSbuUpdate: Date,
  updatedBy: String
});

// Auto-generate unique reference number
directiveSchema.pre('save', async function(next) {
  if (!this.ref && this.meetingDate) {
    const prefix = this.source === 'CG' ? 'CG' : 'BD';
    const month = this.meetingDate.toLocaleString('en-US', { month: 'short' }).toUpperCase();
    const year = this.meetingDate.getFullYear();
    
    const existingRefs = await mongoose.model('Directive').find({
      ref: new RegExp(`^${prefix}/${month}/\\d+/${year}$`)
    }).select('ref');
    
    const existingNumbers = existingRefs.map(d => {
      const match = d.ref.match(/\/(\d+)\//);
      return match ? parseInt(match[1]) : 0;
    });
    
    const nextNumber = existingNumbers.length > 0 ? Math.max(...existingNumbers) + 1 : 1;
    this.ref = `${prefix}/${month}/${nextNumber}/${year}`;
  }
  this.updatedAt = Date.now();
  next();
});

directiveSchema.methods.updateMonitoringStatus = function(notes = '') {
  const oldStatus = this.monitoringStatus;
  
  const allOutcomesCompleted = this.outcomes.length > 0 && 
    this.outcomes.every(o => o.status === 'Completed');
  
  if (allOutcomesCompleted || this.implementationStatus === 'Completed') {
    this.monitoringStatus = 'Completed';
  } else {
    const today = new Date();
    let daysUntilEnd = null;
    
    if (this.implementationEndDate) {
      daysUntilEnd = Math.ceil((this.implementationEndDate - today) / (1000 * 60 * 60 * 24));
    }
    
    if (daysUntilEnd !== null && daysUntilEnd <= 7) {
      this.monitoringStatus = 'High Risk';
    } else if (
      (daysUntilEnd !== null && daysUntilEnd < 30) ||
      this.reminders >= 3
    ) {
      this.monitoringStatus = 'At Risk';
    } else {
      this.monitoringStatus = 'Awaiting Next Reminder';
    }
    
    if (this.reminders >= 3 && 
        (!this.lastSbuUpdate || 
         (this.lastReminderDate && this.lastSbuUpdate < this.lastReminderDate))) {
      this.isResponsive = false;
      if (this.reminders >= 4) {
        this.monitoringStatus = 'Non-Responsive';
      }
    } else if (this.lastSbuUpdate && this.lastSbuUpdate > (this.lastReminderDate || this.createdAt)) {
      this.isResponsive = true;
    }
  }
  
  if (oldStatus !== this.monitoringStatus) {
    this.statusHistory.push({
      status: this.monitoringStatus,
      changedAt: new Date(),
      notes: notes || `Status changed from ${oldStatus} to ${this.monitoringStatus}`
    });
  }
  
  return this.save();
};

directiveSchema.methods.isReminderDue = function() {
  if (this.monitoringStatus === 'Completed') return false;
  if (this.reminders >= 3) return false;
  
  const today = new Date();
  
  if (this.implementationEndDate && this.implementationStartDate) {
    const totalDays = Math.ceil((this.implementationEndDate - this.implementationStartDate) / (1000 * 60 * 60 * 24));
    const reminderInterval = Math.floor(totalDays / 3);
    const daysSinceStart = Math.ceil((today - this.implementationStartDate) / (1000 * 60 * 60 * 24));
    
    if (this.reminders === 0 && daysSinceStart >= reminderInterval) {
      return true;
    } else if (this.reminders === 1 && daysSinceStart >= (reminderInterval * 2)) {
      return true;
    } else if (this.reminders === 2 && daysSinceStart >= totalDays) {
      return true;
    }
  } else {
    const daysSinceCreation = Math.ceil((today - this.createdAt) / (1000 * 60 * 60 * 24));
    
    if (this.reminders === 0 && daysSinceCreation >= 30) {
      return true;
    } else if (this.reminders === 1 && daysSinceCreation >= 60) {
      return true;
    } else if (this.reminders === 2 && daysSinceCreation >= 90) {
      return true;
    }
  }
  
  return false;
};

const Directive = mongoose.model('Directive', directiveSchema);

// ==========================================
// EMAIL SENDING FUNCTIONS
// ==========================================

function generateMemoEmail(directive) {
  const today = new Date();
  const dateStr = `${today.getDate()}${getOrdinal(today.getDate())} ${today.toLocaleString('default', { month: 'long' })} ${today.getFullYear()}`;
  
  const outcomesHtml = directive.outcomes.map((o, i) => {
    const statusColor = {
      'Not Started': '#6b7280',
      'Being Implemented': '#3b82f6',
      'Delayed': '#f59e0b',
      'Completed': '#10b981'
    }[o.status];
    
    return `
      <div style="margin-bottom: 16px; padding: 12px; background: white; border-radius: 6px; border-left: 4px solid #6366f1;">
        <div style="font-weight: 700; color: #6366f1; margin-bottom: 4px;">Outcome ${i + 1}</div>
        <div style="color: #374151; font-size: 13px; line-height: 1.5; margin-bottom: 8px;">${o.text}</div>
        <div style="display: inline-block; padding: 4px 8px; border-radius: 12px; font-size: 10px; font-weight: 700; background: ${statusColor}; color: white;">
          Status: ${o.status}
        </div>
        ${o.challenges ? `<div style="margin-top: 8px; font-size: 12px; color: #6b7280;"><strong>Challenges:</strong> ${o.challenges}</div>` : ''}
        ${o.completionDetails ? `<div style="margin-top: 8px; font-size: 12px; color: #059669;"><strong>Completed:</strong> ${o.completionDetails}</div>` : ''}
        ${o.delayReason ? `<div style="margin-top: 8px; font-size: 12px; color: #dc2626;"><strong>Delay Reason:</strong> ${o.delayReason}</div>` : ''}
      </div>
    `;
  }).join('');

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: Arial, sans-serif; background: #f9fafb; padding: 20px; margin: 0;">
  <div style="max-width: 700px; margin: 0 auto; background: white; border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden;">
    
    <!-- Header -->
    <div style="border-bottom: 3px solid #1e40af; padding: 24px; background: white;">
      <h2 style="color: #1e40af; font-size: 18px; font-weight: 700; margin: 0 0 12px 0; text-transform: uppercase;">
        REQUEST FOR STATUS OF COMPLIANCE WITH BOARD DECISIONS
      </h2>
      <p style="color: #6b7280; font-size: 13px; margin: 0;">Central Bank of Nigeria - Strategy & Innovation Department</p>
    </div>
    
    <!-- Memo Details -->
    <div style="padding: 24px; background: #f9fafb; border-bottom: 1px solid #e5e7eb;">
      <table style="width: 100%; font-size: 13px; color: #374151;">
        <tr>
          <td style="padding: 8px 0; width: 50%;"><strong>To:</strong> ${directive.owner}</td>
          <td style="padding: 8px 0;"><strong>From:</strong> Secretary to the Board/Director</td>
        </tr>
        <tr>
          <td style="padding: 8px 0;"><strong>Ref:</strong> ${directive.ref || 'N/A'}</td>
          <td style="padding: 8px 0;"><strong>Date:</strong> ${dateStr}</td>
        </tr>
      </table>
    </div>
    
    <!-- Subject -->
    <div style="padding: 20px 24px; background: white; border-bottom: 1px solid #e5e7eb;">
      <div style="font-size: 11px; font-weight: 700; color: #6b7280; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px;">Subject</div>
      <div style="font-weight: 700; color: #111827; font-size: 14px;">${directive.subject}</div>
    </div>
    
    <!-- Particulars -->
    <div style="padding: 20px 24px; background: white; border-bottom: 1px solid #e5e7eb;">
      <div style="font-size: 11px; font-weight: 700; color: #6b7280; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px;">Directive Particulars</div>
      <div style="color: #374151; line-height: 1.6; font-size: 13px;">${directive.particulars}</div>
    </div>
    
    ${directive.implementationStartDate || directive.implementationEndDate ? `
    <div style="padding: 20px 24px; background: white; border-bottom: 1px solid #e5e7eb;">
      <div style="font-size: 11px; font-weight: 700; color: #6b7280; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px;">Implementation Timeline</div>
      <div style="color: #111827; font-size: 13px;">
        ${directive.implementationStartDate ? formatDate(directive.implementationStartDate) : 'Not set'} → ${directive.implementationEndDate ? formatDate(directive.implementationEndDate) : 'Not set'}
      </div>
    </div>
    ` : ''}
    
    <!-- Outcomes -->
    <div style="padding: 20px 24px; background: white;">
      <div style="font-size: 11px; font-weight: 700; color: #6b7280; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 16px;">Required Outcomes & Current Status</div>
      <div style="background: #f9fafb; padding: 16px; border-radius: 8px; border: 1px solid #e5e7eb;">
        ${outcomesHtml}
      </div>
    </div>
    
    <!-- Request -->
    <div style="padding: 20px 24px; background: #eff6ff; border-top: 1px solid #dbeafe;">
      <p style="color: #1e40af; font-size: 13px; line-height: 1.6; margin: 0;">
        <strong>Action Required:</strong> Please provide an update on the implementation status of the above outcomes. 
        Your response is needed to compile the status of compliance with ${directive.source === 'CG' ? 'Council of Governors' : 'Board of Directors'} decisions.
      </p>
    </div>
    
    <!-- Footer -->
    <div style="padding: 16px 24px; background: #f9fafb; border-top: 1px solid #e5e7eb; text-align: center;">
      <p style="color: #6b7280; font-size: 11px; margin: 0;">
        This is an automated reminder from the CBN Directives Management System
      </p>
    </div>
    
  </div>
</body>
</html>
  `;

  return html;
}

function getOrdinal(n) {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return (s[(v - 20) % 10] || s[v] || s[0]);
}

function formatDate(date) {
  if (!date) return 'N/A';
  return new Date(date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

async function sendReminderEmail(directive) {
  if (!emailTransporter) {
    console.log('⚠️  Email transporter not initialized');
    return false;
  }

  try {
    const emailHtml = generateMemoEmail(directive);
    
    const recipients = [directive.primaryEmail];
    if (directive.secondaryEmail && directive.secondaryEmail.trim() !== '') {
      recipients.push(directive.secondaryEmail);
    }

    const mailOptions = {
      from: `"CBN Directives System" <${process.env.EMAIL_USER}>`,
      to: recipients.join(', '),
      subject: `Reminder ${directive.reminders + 1}/3: Status Update Required - ${directive.ref}`,
      html: emailHtml
    };

    await emailTransporter.sendMail(mailOptions);
    console.log(`   ✅ Email sent to: ${recipients.join(', ')}`);
    return true;
  } catch (error) {
    console.error(`   ❌ Email failed:`, error.message);
    return false;
  }
}

// ==========================================
// GOOGLE SHEETS INTEGRATION
// ==========================================

const SHEET_ID = process.env.GOOGLE_SHEET_ID || '1BuQneU7HESvwRE25Zkir96jZrSP-TKLe';
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets.readonly'];

async function getGoogleSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_CREDENTIALS_PATH || './credentials.json',
    scopes: SCOPES,
  });
  
  const client = await auth.getClient();
  return google.sheets({ version: 'v4', auth: client });
}

// [Keep all the existing parseOutcomes, extractSmartOutcomes, etc. functions - they're already good]

function parseOutcomes(particulars) {
  if (!particulars || particulars.trim() === '') {
    return [{ text: 'Implementation required', status: 'Not Started' }];
  }
  
  let cleanText = particulars
    .replace(/^The Committee of Governors (at its )?(considered and )?(DECIDED|APPROVED|RECOMMENDED|RATIFIED|DIRECTED)( as follows)?:?\s*/i, '')
    .replace(/^(APPROVED|DIRECTED|RECOMMENDED|RATIFIED|DECIDED):?\s*/i, '')
    .trim();

  const structuredOutcomes = extractSmartOutcomes(cleanText);
  return structuredOutcomes.slice(0, 3);
}

function extractSmartOutcomes(text) {
  const outcomes = [];
  
  const listPatterns = [
    /(?:^|\n)\s*\(([a-z])\)\s*([^()]+?)(?=\n\s*\([a-z]\)|\n\n|$)/gi,
    /(?:^|\n)\s*\(([ivxl]+)\)\s*([^()]+?)(?=\n\s*\([ivxl]+\)|\n\n|$)/gi,
    /(?:^|\n)\s*([a-z])\.\s*([^\n]+?)(?=\n\s*[a-z]\.|\n\n|$)/gim,
    /(?:^|\n)\s*(\d+)\.\s*([^\n]+?)(?=\n\s*\d+\.|\n\n|$)/gm
  ];
  
  for (const pattern of listPatterns) {
    const matches = [...text.matchAll(pattern)];
    if (matches.length >= 2) {
      matches.forEach(match => {
        const outcomeText = match[2].trim();
        if (outcomeText.length > 20) {
          outcomes.push({
            text: smartTruncate(outcomeText, 300),
            status: 'Not Started',
            priority: calculatePriority(outcomeText)
          });
        }
      });
      if (outcomes.length > 0) break;
    }
  }
  
  if (outcomes.length === 0) {
    outcomes.push(...extractActionBasedOutcomes(text));
  }
  
  if (outcomes.length === 0) {
    const parts = text.split(/;\s+|,\s+and\s+|,\s+also\s+/);
    parts.forEach(part => {
      const trimmed = part.trim();
      if (trimmed.length > 30) {
        outcomes.push({
          text: smartTruncate(trimmed, 300),
          status: 'Not Started',
          priority: calculatePriority(trimmed)
        });
      }
    });
  }
  
  if (outcomes.length === 0) {
    outcomes.push({
      text: smartTruncate(text, 300),
      status: 'Not Started',
      priority: 1
    });
  }
  
  outcomes.sort((a, b) => (b.priority || 0) - (a.priority || 0));
  
  return outcomes.map(o => ({
    text: o.text,
    status: o.status
  }));
}

function extractActionBasedOutcomes(text) {
  const outcomes = [];
  
  const strongActions = [
    'approve', 'approved', 'implement', 'establish', 'develop', 'create',
    'procure', 'purchase', 'acquire', 'pay', 'disburse', 'allocate',
    'authorize', 'grant', 'execute', 'complete', 'finalize',
    'submit', 'report', 'provide', 'prepare', 'ensure'
  ];
  
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
  
  sentences.forEach(sentence => {
    const trimmed = sentence.trim();
    const lowerSentence = trimmed.toLowerCase();
    
    let score = 0;
    
    const hasAction = strongActions.some(verb => {
      const regex = new RegExp(`\\b${verb}\\b`, 'i');
      return regex.test(lowerSentence);
    });
    if (hasAction) score += 3;
    
    if (/\b(shall|must|required to|directed to)\b/i.test(lowerSentence)) score += 3;
    if (/\b(₦|naira|payment|budget|cost|amount)\b/i.test(lowerSentence)) score += 2;
    if (/\b(deadline|by|within|before|timeline)\b/i.test(lowerSentence)) score += 2;
    if (/\b(director|department|unit|team|committee)\b/i.test(lowerSentence)) score += 1;
    if (trimmed.length > 40) score += 1;
    
    if (score >= 4) {
      outcomes.push({
        text: smartTruncate(trimmed, 300),
        status: 'Not Started',
        priority: score
      });
    }
  });
  
  return outcomes;
}

function calculatePriority(text) {
  let priority = 1;
  const lower = text.toLowerCase();
  
  if (/\b(urgent|immediate|critical|priority)\b/i.test(lower)) priority += 3;
  if (/\b(shall|must|required)\b/i.test(lower)) priority += 2;
  if (/\b(payment|procure|budget|₦)\b/i.test(lower)) priority += 2;
  if (/\b(complete|finalize|submit)\b/i.test(lower)) priority += 1;
  
  return priority;
}

function smartTruncate(text, maxLength = 300) {
  if (text.length <= maxLength) return text;
  
  const truncated = text.substring(0, maxLength);
  const lastPeriod = truncated.lastIndexOf('.');
  const lastExclamation = truncated.lastIndexOf('!');
  const lastQuestion = truncated.lastIndexOf('?');
  
  const lastSentenceEnd = Math.max(lastPeriod, lastExclamation, lastQuestion);
  
  if (lastSentenceEnd > maxLength * 0.7) {
    return truncated.substring(0, lastSentenceEnd + 1);
  }
  
  return truncated + '...';
}

function parseDate(dateStr) {
  if (!dateStr) return new Date();
  
  dateStr = String(dateStr).trim();
  
  try {
    if (!isNaN(dateStr)) {
      const excelEpoch = new Date(1899, 11, 30);
      const daysOffset = parseFloat(dateStr);
      const date = new Date(excelEpoch.getTime() + daysOffset * 86400000);
      if (!isNaN(date.getTime())) return date;
    }
    
    const date = new Date(dateStr);
    if (!isNaN(date.getTime())) return date;
    
    const parts = dateStr.split(/[\/\-\.]/);
    if (parts.length === 3) {
      const day = parseInt(parts[0]);
      const month = parseInt(parts[1]) - 1;
      const year = parseInt(parts[2]);
      const parsedDate = new Date(year, month, day);
      if (!isNaN(parsedDate.getTime())) return parsedDate;
    }
  } catch (error) {
    console.warn(`⚠️  Could not parse date: "${dateStr}"`);
  }
  
  return new Date();
}

function addDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function extractProcessOwner(ownerText) {
  if (!ownerText || ownerText.trim() === '' || ownerText.trim() === ',,' || ownerText.trim() === "''") {
    return 'Unassigned';
  }
  
  let cleaned = ownerText.trim();
  cleaned = cleaned.replace(/^[,'"]+|[,'"]+$/g, '');
  cleaned = cleaned.replace(/[₦$N]\s*[\d,]+\.?\d*/gi, '');
  cleaned = cleaned.replace(/\b\d{4,}(?:,\d{3})*(?:\.\d{2})?\b/g, '');
  cleaned = cleaned.replace(/\d{4,}/g, '');
  cleaned = cleaned.replace(/\d+\.\d+/g, '');
  
  if (cleaned.includes('CC:')) {
    const parts = cleaned.split(/CC:/i);
    cleaned = parts[0].trim();
  }
  
  cleaned = cleaned.replace(/\b(amount|total|sum|naira|kobo|million|billion)\b/gi, '');
  cleaned = cleaned.replace(/[,\.]{2,}/g, '');
  cleaned = cleaned.replace(/^[,\.\s]+|[,\.\s]+$/g, '');
  
  if (/^[\d,.\s₦$N]+$/.test(cleaned)) {
    return 'Unassigned';
  }
  
  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  
  if (cleaned.length < 3 || /^\d/.test(cleaned)) {
    return 'Unassigned';
  }
  
  return cleaned || 'Unassigned';
}

async function fetchSheetData(sheetName) {
  try {
    const sheets = await getGoogleSheetsClient();
    
    const metadata = await sheets.spreadsheets.get({
      spreadsheetId: SHEET_ID,
    });
    
    const tab = metadata.data.sheets.find(sheet => 
      sheet.properties.title === sheetName
    );
    
    if (!tab) {
      console.log(`⚠️  Tab "${sheetName}" not found.`);
      return [];
    }
    
    const tabName = tab.properties.title;
    console.log(`📖 Reading from tab: "${tabName}"`);
    
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `'${tabName}'!A4:K1000`,
    });

    const rows = response.data.values;
    if (!rows || rows.length < 2) {
      console.log(`⚠️  No data found in "${tabName}"`);
      return [];
    }

    console.log(`✅ Found ${rows.length - 1} data rows in "${tabName}"`);

    const headers = rows[0];
    const data = rows.slice(1);

    const colMap = {
      meeting: 0,
      date: 1,
      subject: 2,
      particulars: 3,
      owner: 5,
      amount: 6,
      vendor: -1,
      deadline: 7,
      implStatus: 8
    };

    const directives = data.map((row, index) => {
      if (!row || row.every(cell => !cell || cell.trim() === '')) {
        return null;
      }
      
      const subject = (row[colMap.subject] || '').trim();
      const particulars = (row[colMap.particulars] || '').trim();
      
      if (!subject && !particulars) {
        return null;
      }
      
      if (row[colMap.meeting] && row[colMap.meeting].includes('MEETING AT WHICH')) {
        return null;
      }

      const meetingText = row[colMap.meeting] || '';
      const refMatch = meetingText.match(/(CG|BD|Board)\/[A-Z]{3}\/\d+\/\d{4}\/\d+/i);
      const extractedRef = refMatch ? refMatch[0] : null;

      const finalSubject = subject || (particulars.length > 0 ? particulars.substring(0, 100) : `Directive from ${tabName}`);
      const finalParticulars = particulars || finalSubject;

      const rawOwner = row[colMap.owner] || '';
      const processOwner = extractProcessOwner(rawOwner);

      const extractedOutcomes = parseOutcomes(finalParticulars);

      return {
        source: tabName.toLowerCase().includes('board') ? 'Board' : 'CG',
        sheetName: tabName,
        ref: extractedRef,
        meetingDate: parseDate(row[colMap.date] || new Date()),
        subject: finalSubject,
        particulars: finalParticulars,
        owner: processOwner,
        primaryEmail: '', // Will need to be filled manually
        secondaryEmail: '',
        amount: (row[colMap.amount] || '').trim(),
        vendor: '',
        implementationStartDate: null,
        implementationEndDate: null,
        implementationStatus: (row[colMap.implStatus] || 'Not Started').trim(),
        monitoringStatus: 'Awaiting Next Reminder',
        outcomes: extractedOutcomes,
        statusHistory: [{
          status: 'Awaiting Next Reminder',
          changedAt: new Date(),
          notes: 'Initial status'
        }]
      };
    }).filter(d => d !== null);

    return directives;
  } catch (error) {
    console.error(`❌ Error fetching sheet "${sheetName}":`, error.message);
    throw error;
  }
}

// ==========================================
// AUTOMATED REMINDER SYSTEM
// ==========================================

const ReminderSettings = mongoose.model('ReminderSettings', new mongoose.Schema({
  enabled: { type: Boolean, default: true },
  statusSettings: {
    'Awaiting Next Reminder': { type: Boolean, default: true },
    'At Risk': { type: Boolean, default: true },
    'High Risk': { type: Boolean, default: true },
    'Non-Responsive': { type: Boolean, default: false }
  },
  updatedAt: { type: Date, default: Date.now }
}));

async function sendReminders() {
  try {
    console.log('\n📧 Running automated reminder check...');
    
    let settings = await ReminderSettings.findOne();
    if (!settings) {
      settings = await ReminderSettings.create({
        enabled: true,
        statusSettings: {
          'Awaiting Next Reminder': true,
          'At Risk': true,
          'High Risk': true,
          'Non-Responsive': false
        }
      });
    }
    
    if (!settings.enabled) {
      console.log('⏸️  Automatic reminders are disabled');
      return;
    }
    
    const enabledStatuses = Object.keys(settings.statusSettings).filter(
      status => settings.statusSettings[status] === true
    );
    
    const directivesNeedingReminder = await Directive.find({
      monitoringStatus: { $in: enabledStatuses },
      reminders: { $lt: 3 }
    });
    
    let remindersSent = 0;
    
    for (const directive of directivesNeedingReminder) {
      if (directive.isReminderDue()) {
        const emailSent = await sendReminderEmail(directive);
        
        directive.reminders += 1;
        directive.lastReminderDate = new Date();
        directive.reminderHistory.push({
          sentAt: new Date(),
          recipient: directive.owner,
          method: emailSent ? 'Email' : 'System',
          acknowledged: false
        });
        
        const reminderNum = directive.reminders;
        await directive.updateMonitoringStatus(`Reminder ${reminderNum} sent${emailSent ? ' via email' : ''}`);
        remindersSent++;
        
        console.log(`   ✉️  Reminder ${reminderNum}/3 → ${directive.owner} (${directive.ref})`);
      }
    }
    
    console.log(`✅ Sent ${remindersSent} reminders\n`);
  } catch (error) {
    console.error('❌ Error in reminder system:', error);
  }
}

// Schedule reminders daily at 9 AM
cron.schedule('0 9 * * *', () => {
  console.log('⏰ Scheduled reminder check triggered');
  sendReminders();
});

// ==========================================
// API ROUTES
// ==========================================

// Test email endpoint
app.post('/api/test-email', async (req, res) => {
  try {
    const { testEmail } = req.body;
    
    if (!emailTransporter) {
      return res.status(500).json({ 
        success: false, 
        error: 'Email transporter not configured. Please check your .env file.' 
      });
    }

    const today = new Date();
    const dateStr = `${today.getDate()}${getOrdinal(today.getDate())} ${today.toLocaleString('default', { month: 'long' })} ${today.getFullYear()}`;

    const mailOptions = {
      from: `"CBN Directives System" <${process.env.EMAIL_USER}>`,
      to: testEmail,
      subject: 'CBN Directives System - Email Configuration Test',
      html: `
<!DOCTYPE html>
<html>
<body style="font-family: Arial, sans-serif; padding: 20px;">
  <div style="max-width: 600px; margin: 0 auto; border: 2px solid #10b981; border-radius: 8px; padding: 30px; background: #f0fdf4;">
    <h2 style="color: #059669; margin-top: 0;">✅ Email System Working!</h2>
    <p style="color: #374151; line-height: 1.6;">
      This is a test email from the <strong>CBN Directives Management Platform</strong>.
    </p>
    <p style="color: #374151; line-height: 1.6;">
      If you received this message, the email configuration is working correctly and the system is ready to send automated reminders.
    </p>
    <hr style="border: none; border-top: 1px solid #d1d5db; margin: 20px 0;">
    <p style="color: #6b7280; font-size: 12px; margin-bottom: 0;">
      <strong>Sent:</strong> ${dateStr}<br>
      <strong>From:</strong> CBN Directives Management System
    </p>
  </div>
</body>
</html>
      `
    };

    await emailTransporter.sendMail(mailOptions);
    
    res.json({ 
      success: true, 
      message: `Test email sent successfully to ${testEmail}` 
    });
  } catch (error) {
    console.error('Test email error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

app.post('/api/sync-sheets', async (req, res) => {
  try {
    console.log('\n🔄 Starting Google Sheets sync...');
    
    const sheets = await getGoogleSheetsClient();
    
    const metadata = await sheets.spreadsheets.get({
      spreadsheetId: SHEET_ID,
    });
    
    const allSheets = metadata.data.sheets;
    const allTabs = allSheets
      .filter(s => !s.properties.hidden)
      .map(s => s.properties.title);
    
    console.log(`📊 Spreadsheet: "${metadata.data.properties.title}"`);
    console.log(`📑 Detected ${allTabs.length} sheets/tabs\n`);
    
    let totalSynced = 0;
    let totalUpdated = 0;
    let totalSkipped = 0;
    const errors = [];

    for (const tabName of allTabs) {
      try {
        console.log(`📄 Processing: "${tabName}"`);
        const directives = await fetchSheetData(tabName);
        
        if (directives.length === 0) {
          console.log(`   ⚠️  No valid data found - skipping\n`);
          totalSkipped++;
          continue;
        }
        
        console.log(`   📋 Found ${directives.length} directives to process`);
        
        for (const directive of directives) {
          try {
            const existing = await Directive.findOne({
              subject: directive.subject,
              meetingDate: directive.meetingDate,
              sheetName: directive.sheetName
            });

            if (!existing) {
              const newDirective = new Directive(directive);
              await newDirective.save();
              totalSynced++;
            } else {
              existing.particulars = directive.particulars;
              existing.owner = directive.owner;
              existing.amount = directive.amount;
              existing.vendor = directive.vendor;
              existing.implementationStatus = directive.implementationStatus;
              
              if (!existing.implementationEndDate) {
                existing.implementationEndDate = directive.implementationEndDate;
              }
              
              if (existing.outcomes.every(o => o.status === 'Not Started')) {
                existing.outcomes = directive.outcomes;
              }
              
              await existing.save();
              totalUpdated++;
            }
          } catch (err) {
            console.log(`   ⚠️  Error saving directive - ${err.message}`);
            errors.push({ tab: tabName, error: err.message });
          }
        }
        
        console.log(`   ✅ Completed\n`);
        
      } catch (err) {
        console.error(`   ❌ Error processing "${tabName}":`, err.message, '\n');
        errors.push({ tab: tabName, error: err.message });
      }
    }

    console.log(`\n✨ Sync Completed!`);
    console.log(`📊 New: ${totalSynced} | Updated: ${totalUpdated} | Skipped: ${totalSkipped} | Errors: ${errors.length}\n`);

    res.json({ 
      success: true, 
      message: `✅ Synced ${totalSynced} new, updated ${totalUpdated}`,
      summary: {
        sheetsProcessed: allTabs.length,
        newDirectives: totalSynced,
        updatedDirectives: totalUpdated,
        skippedSheets: totalSkipped,
        errors: errors.length
      }
    });
  } catch (error) {
    console.error('❌ Sync error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/directives', async (req, res) => {
  try {
    const { source, owner, status, sheetName } = req.query;
    
    let query = {};
    if (source && source !== 'All') query.source = source;
    if (owner && owner !== 'All') query.owner = new RegExp(owner, 'i');
    if (status && status !== 'All') query.monitoringStatus = status;
    if (sheetName && sheetName !== 'All') query.sheetName = sheetName;

    const directives = await Directive.find(query).sort({ createdAt: -1 });
    res.json({ success: true, data: directives });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/directives/:id', async (req, res) => {
  try {
    const directive = await Directive.findById(req.params.id);
    if (!directive) {
      return res.status(404).json({ success: false, error: 'Directive not found' });
    }
    res.json({ success: true, data: directive });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.put('/api/directives/:id', async (req, res) => {
  try {
    const directive = await Directive.findById(req.params.id);
    if (!directive) {
      return res.status(404).json({ success: false, error: 'Directive not found' });
    }

    const { 
      outcomes, 
      implementationStatus, 
      completionNote, 
      implementationStartDate, 
      implementationEndDate,
      meetingDate,
      owner,
      subject,
      particulars,
      amount,
      sheetName,
      primaryEmail,
      secondaryEmail
    } = req.body;
    
    if (outcomes) directive.outcomes = outcomes;
    if (implementationStatus) directive.implementationStatus = implementationStatus;
    if (completionNote) directive.completionNote = completionNote;
    if (implementationStartDate) directive.implementationStartDate = new Date(implementationStartDate);
    if (implementationEndDate) directive.implementationEndDate = new Date(implementationEndDate);
    if (meetingDate) directive.meetingDate = new Date(meetingDate);
    if (owner) directive.owner = owner;
    if (subject) directive.subject = subject;
    if (particulars) directive.particulars = particulars;
    if (amount !== undefined) directive.amount = amount;
    if (sheetName) directive.sheetName = sheetName;
    if (primaryEmail) directive.primaryEmail = primaryEmail;
    if (secondaryEmail !== undefined) directive.secondaryEmail = secondaryEmail;
    
    if (outcomes) {
      directive.lastSbuUpdate = new Date();
      directive.lastResponseDate = new Date();
    }
    
    await directive.updateMonitoringStatus(outcomes ? 'SBU update received' : 'Directive edited');
    
    res.json({ success: true, data: directive });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/directives', async (req, res) => {
  try {
    const newDirective = new Directive(req.body);
    await newDirective.save();
    res.json({ success: true, data: newDirective });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/directives/:id/remind', async (req, res) => {
  try {
    const directive = await Directive.findById(req.params.id);
    if (!directive) {
      return res.status(404).json({ success: false, error: 'Directive not found' });
    }

    const emailSent = await sendReminderEmail(directive);
    
    directive.reminders += 1;
    directive.lastReminderDate = new Date();
    directive.reminderHistory.push({
      sentAt: new Date(),
      recipient: directive.owner,
      method: emailSent ? 'Email' : 'System',
      acknowledged: false
    });
    
    await directive.updateMonitoringStatus(`Manual reminder sent${emailSent ? ' via email' : ''}`);

    res.json({ 
      success: true, 
      data: directive,
      emailSent 
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/reports/stats', async (req, res) => {
  try {
    const { source } = req.query;
    const query = source && source !== 'All' ? { source } : {};

    const total = await Directive.countDocuments(query);
    const completed = await Directive.countDocuments({ ...query, monitoringStatus: 'Completed' });
    const track = await Directive.countDocuments({ ...query, monitoringStatus: 'Awaiting Next Reminder' });
    const atRisk = await Directive.countDocuments({ ...query, monitoringStatus: 'At Risk' });
    const highRisk = await Directive.countDocuments({ ...query, monitoringStatus: 'High Risk' });
    const nonResponsive = await Directive.countDocuments({ ...query, monitoringStatus: 'Non-Responsive' });
    
    const ownerStats = await Directive.aggregate([
      { $match: query },
      { $group: {
          _id: '$owner',
          total: { $sum: 1 },
          completed: { 
            $sum: { $cond: [{ $eq: ['$monitoringStatus', 'Completed'] }, 1, 0] }
          },
          delayed: {
            $sum: { $cond: [{ $in: ['$monitoringStatus', ['High Risk', 'At Risk', 'Non-Responsive']] }, 1, 0] }
          }
        }
      },
      { $sort: { total: -1 } }
    ]);
    
    const now = new Date();
    const overdue = await Directive.countDocuments({
      ...query,
      implementationEndDate: { $lt: now },
      monitoringStatus: { $ne: 'Completed' }
    });
    
    const dueSoon = await Directive.countDocuments({
      ...query,
      implementationEndDate: { $gte: now, $lte: addDays(now, 30) },
      monitoringStatus: { $ne: 'Completed' }
    });
    
    const nonResponsiveEntities = await Directive.find({
      ...query,
      reminders: { $gte: 2 },
      monitoringStatus: { $in: ['Non-Responsive', 'High Risk'] }
    }).select('owner ref subject reminders lastReminderDate');
    
    const completionTrend = await Directive.aggregate([
      { $match: { ...query, monitoringStatus: 'Completed' } },
      { $group: {
          _id: {
            year: { $year: '$updatedAt' },
            month: { $month: '$updatedAt' }
          },
          count: { $sum: 1 }
        }
      },
      { $sort: { '_id.year': -1, '_id.month': -1 } },
      { $limit: 6 }
    ]);

    res.json({ 
      success: true, 
      data: { 
        summary: {
          total,
          completed,
          track,
          atRisk,
          highRisk,
          nonResponsive,
          risk: atRisk + highRisk + nonResponsive
        },
        timeline: {
          overdue,
          dueSoon
        },
        ownerPerformance: ownerStats,
        nonResponsiveEntities,
        completionTrend,
        complianceRate: total > 0 ? ((completed / total) * 100).toFixed(1) : 0,
        riskRate: total > 0 ? (((atRisk + highRisk + nonResponsive) / total) * 100).toFixed(1) : 0
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/reports/non-responsive', async (req, res) => {
  try {
    const { source } = req.query;
    const query = source && source !== 'All' ? { source } : {};
    
    const nonResponsive = await Directive.find({
      ...query,
      reminders: { $gte: 2 },
      monitoringStatus: { $in: ['Non-Responsive', 'High Risk', 'At Risk'] }
    }).sort({ reminders: -1 });
    
    res.json({ success: true, data: nonResponsive });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/reminders/send', async (req, res) => {
  try {
    await sendReminders();
    res.json({ success: true, message: 'Reminders sent successfully' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/reminder-settings', async (req, res) => {
  try {
    let settings = await ReminderSettings.findOne();
    if (!settings) {
      settings = await ReminderSettings.create({
        enabled: true,
        statusSettings: {
          'Awaiting Next Reminder': true,
          'At Risk': true,
          'High Risk': true,
          'Non-Responsive': false
        }
      });
    }
    res.json({ success: true, data: settings });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.put('/api/reminder-settings', async (req, res) => {
  try {
    const { enabled, statusSettings } = req.body;
    
    let settings = await ReminderSettings.findOne();
    if (!settings) {
      settings = new ReminderSettings();
    }
    
    settings.enabled = enabled;
    settings.statusSettings = statusSettings;
    settings.updatedAt = new Date();
    
    await settings.save();
    
    res.json({ success: true, data: settings });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/process-owners', async (req, res) => {
  try {
    const owners = await Directive.distinct('owner');
    res.json({ success: true, data: owners.filter(o => o && o !== 'Unassigned').sort() });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/departments', async (req, res) => {
  try {
    const departments = await Directive.distinct('sheetName');
    res.json({ success: true, data: departments.filter(d => d).sort() });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    email: emailTransporter ? 'configured' : 'not configured',
    timestamp: new Date().toISOString()
  });
});

app.listen(PORT, () => {
  console.log(`\n🚀 CBN Directives Platform - WITH EMAIL INTEGRATION`);
  console.log(`📍 Server: http://localhost:${PORT}`);
  console.log(`💾 MongoDB: ${mongoose.connection.readyState === 1 ? '✅ Connected' : '⏳ Connecting...'}`);
  console.log(`📧 Email: ${emailTransporter ? '✅ Configured' : '❌ Not Configured'}`);
  console.log(`\n✨ Features:`);
  console.log(`   • Email collection (primary + secondary)`);
  console.log(`   • Automated email reminders in CBN memo format`);
  console.log(`   • Smart outcome extraction (1-3 items)`);
  console.log(`   • Full data display (no truncation)\n`);
});