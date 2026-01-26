// Backend Server for CBN Directives Platform - FIXED VERSION
// File: server.js

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const { google } = require('googleapis');
const cron = require('node-cron');
const nodemailer = require('nodemailer');
const sgMail = require('@sendgrid/mail');  // ADD THIS LINE
require('dotenv').config();


const app = express();
const PORT = process.env.PORT || 3001;


// ADD these imports at the top
const multer = require('multer');
const crypto = require('crypto');
const fs = require('fs');





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





// Extract standard status or return empty string
function extractStandardStatus(statusText) {
    if (!statusText || statusText.trim() === '') return '';
    
    const validStatuses = ['Not Started', 'Being Implemented', 'Delayed', 'Completed'];
    const cleaned = statusText.trim();
    
    // If it's already a valid status, return it
    if (validStatuses.includes(cleaned)) {
        return cleaned;
    }
    
    // If it's free text, return empty (will be filled manually later)
    return '';
}

// Extract comments from free text (anything that's not a standard status)
function extractComments(statusText) {
    if (!statusText || statusText.trim() === '') return '';
    
    const validStatuses = ['Not Started', 'Being Implemented', 'Delayed', 'Completed'];
    const cleaned = statusText.trim();
    
    // If it's a standard status, no comments
    if (validStatuses.includes(cleaned)) {
        return '';
    }
    
    // If it's free text, treat it as a comment
    return cleaned;
}


// ==========================================
// EMAIL CONFIGURATION
// ==========================================

let emailTransporter = null;

function setupEmailTransporter() {
  try {
    console.log('\n🔍 EMAIL SETUP DEBUG:');
    
    // Use SendGrid API (not SMTP)
    if (process.env.SENDGRID_API_KEY) {
      console.log('   📧 Using SendGrid API for email delivery');
      console.log('   SENDGRID_API_KEY:', process.env.SENDGRID_API_KEY ? 'SET ✓' : '❌ MISSING');
      console.log('   EMAIL_USER (sender):', process.env.EMAIL_USER ? `SET (${process.env.EMAIL_USER})` : '❌ MISSING');
      
      if (!process.env.EMAIL_USER) {
        console.log('⚠️  EMAIL_USER required for sender address\n');
        return null;
      }
      
      sgMail.setApiKey(process.env.SENDGRID_API_KEY);
      
      // Create wrapper that matches nodemailer interface
      emailTransporter = {
        sendMail: async (mailOptions) => {
          try {
            const msg = {
              to: mailOptions.to,
              from: process.env.EMAIL_USER,
              subject: mailOptions.subject,
              html: mailOptions.html
            };
            
            const response = await sgMail.send(msg);
            console.log('✅ SendGrid email sent successfully');
            return response;
          } catch (error) {
            console.error('❌ SendGrid send error:', error.message);
            if (error.response) {
              console.error('   Response body:', error.response.body);
            }
            throw error;
          }
        },
        verify: (callback) => {
          console.log('✅ SendGrid API is ready to send emails\n');
          callback(null, true);
        }
      };
      
      console.log('✅ SendGrid API configured\n');
      return emailTransporter;
    }
    
    console.log('⚠️  No SendGrid API key found\n');
    return null;
    
  } catch (error) {
    console.error('\n❌ CRITICAL ERROR setting up email:');
    console.error('   Exception:', error.message);
    console.log('\n');
    return null;
  }
}






// Initialize email transporter
setupEmailTransporter();

// ==========================================
// ENHANCED MONGODB SCHEMA
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
  
  primaryEmail: { type: String,  default:'' },
  secondaryEmail: { type: String, default: '' },


   // Add this new field:
    updateHistory: [{
        timestamp: { type: Date, default: Date.now },
        source: { type: String, enum: ['reminder-link', 'self-initiated', 'admin'], default: 'reminder-link' },
        updatedBy: String,
        outcomeChanges: Number, // Number of outcomes updated
        comment: String
    }],

  
  amount: String,
  vendor: String,
  implementationStartDate: Date,
  implementationEndDate: Date,
  implementationStatus: { type: String, default: 'Not Started' },
  
  // ⭐ ADD THIS NEW FIELD
  additionalComments: { type: String, default: '' },
  
  ref: { type: String, unique: true, sparse: true },


  attachments: [{
    filename: String,
    originalName: String,
    mimetype: String,
    size: Number,
    path: String,
    uploadedAt: { type: Date, default: Date.now },
    uploadedBy: String
}],

  
   // TIMELINE-BASED MONITORING
monitoringStatus: {
  type: String,
  enum: ['On Track', 'At Risk', 'High Risk', 'Completed', 'Needs Timeline'],
  default: 'On Track'
},


  statusHistory: [statusHistorySchema],
  
  reminders: { type: Number, default: 0 },
  lastReminderDate: Date,
  lastSbuUpdate: Date,
  reminderHistory: [reminderHistorySchema],
  
  isResponsive: { 
  type: Boolean, 
  default: true 
},
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
    this.isResponsive = true;
  } else {
    // ⭐ CHECK IF TIMELINE EXISTS
    if (!this.implementationEndDate) {
      this.monitoringStatus = 'Needs Timeline';
      // Still check responsiveness
      if (this.reminders >= 2 && 
          (!this.lastSbuUpdate || 
           (this.lastReminderDate && this.lastSbuUpdate < this.lastReminderDate))) {
        this.isResponsive = false;
      }
    } else {
      // Normal timeline-based logic
      const today = new Date();
      const daysUntilEnd = Math.ceil((this.implementationEndDate - today) / (1000 * 60 * 60 * 24));
      
      if (daysUntilEnd <= 7) {
        this.monitoringStatus = 'High Risk';
      } else if (daysUntilEnd < 30 || this.reminders >= 3) {
        this.monitoringStatus = 'At Risk';
      } else {
        this.monitoringStatus = 'On Track';
      }
      
      // Check responsiveness
      if (this.reminders >= 3 && 
          (!this.lastSbuUpdate || 
           (this.lastReminderDate && this.lastSbuUpdate < this.lastReminderDate))) {
        this.isResponsive = false;
      } else if (this.lastSbuUpdate && this.lastSbuUpdate > (this.lastReminderDate || this.createdAt)) {
        this.isResponsive = true;
      }
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


// ADD this schema
// ==========================================
// SUBMISSION TOKEN MODEL
// ==========================================

const submissionTokenSchema = new mongoose.Schema({
  token: { type: String, required: true, unique: true },
  directiveId: { type: mongoose.Schema.Types.ObjectId, ref: 'Directive', required: true },
  selectedOutcomes: [{ type: Number }],
  createdAt: { type: Date, default: Date.now },
  expiresAt: { type: Date },
  used: { type: Boolean, default: false },
  usedAt: { type: Date }
});

const SubmissionToken = mongoose.model('SubmissionToken', submissionTokenSchema);




// ADD this schema

// ==========================================
// EMAIL GENERATION FUNCTIONS
// ==========================================

function generateMemoEmail(directive) {
  const today = new Date();
  const dateStr = `${today.getDate()}${getOrdinal(today.getDate())} ${today.toLocaleString('default', { month: 'long' })} ${today.getFullYear()}`;
  
  // Generate submission link
  const baseUrl = process.env.BASE_URL || 'https://directives-new.onrender.com';
  const submissionUrl = `${baseUrl}/submit-update/${directive._id}`;
  
  const outcomesHtml = directive.outcomes.map((o, i) => {
    const statusColor = {
      'Not Started': '#6b7280',
      'Being Implemented': '#3b82f6',
      'Delayed': '#f59e0b',
      'Completed': '#10b981'
    }[o.status] || '#6b7280';
    
    return `
      <div style="margin-bottom: 16px; padding: 12px; background: white; border-radius: 6px; border-left: 4px solid #6366f1;">
        <div style="font-weight: 700; color: #6366f1; margin-bottom: 4px; font-size: 12px;">Outcome ${i + 1}</div>
        <div style="color: #374151; font-size: 13px; line-height: 1.5; margin-bottom: 8px;">${o.text}</div>
        <div style="display: inline-block; padding: 4px 8px; border-radius: 12px; font-size: 10px; font-weight: 700; background: ${statusColor}; color: white;">
          Current Status: ${o.status}
        </div>
        ${o.challenges ? `<div style="margin-top: 8px; font-size: 11px; color: #6b7280;"><strong>Challenges:</strong> ${o.challenges}</div>` : ''}
        ${o.completionDetails ? `<div style="margin-top: 8px; font-size: 11px; color: #059669;"><strong>Completed:</strong> ${o.completionDetails}</div>` : ''}
        ${o.delayReason ? `<div style="margin-top: 8px; font-size: 11px; color: #dc2626;"><strong>Delay Reason:</strong> ${o.delayReason}</div>` : ''}
      </div>
    `;
  }).join('');

  const implementationTimeline = directive.implementationStartDate || directive.implementationEndDate
    ? `
    <div style="padding: 20px 24px; background: white; border-bottom: 1px solid #e5e7eb;">
      <div style="font-size: 11px; font-weight: 700; color: #6b7280; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px;">Implementation Timeline</div>
      <div style="color: #111827; font-size: 13px; font-weight: 600;">
        ${directive.implementationStartDate ? formatDate(directive.implementationStartDate) : 'Not set'} 
        <span style="color: #6b7280;">→</span> 
        ${directive.implementationEndDate ? formatDate(directive.implementationEndDate) : 'Not set'}
      </div>
    </div>
    `
    : '';

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: Arial, sans-serif; background: #f9fafb; padding: 20px; margin: 0;">
  <div style="max-width: 700px; margin: 0 auto; background: white; border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden;">
    
    <!-- MEMO HEADER -->
    <div style="border-bottom: 3px solid #1e40af; padding: 24px; background: white;">
      <h2 style="color: #1e40af; font-size: 18px; font-weight: 700; margin: 0 0 12px 0; text-transform: uppercase;">
        REQUEST FOR STATUS OF COMPLIANCE WITH BOARD DECISIONS
      </h2>
      <p style="color: #6b7280; font-size: 13px; margin: 0;">Central Bank of Nigeria - Corporate Secretariat</p>
    </div>
    
    <!-- MEMO DETAILS -->
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
    
    <!-- INTRO -->
    <div style="padding: 20px 24px; background: white; border-bottom: 1px solid #e5e7eb;">
      <p style="color: #374151; font-size: 13px; line-height: 1.6; margin: 0;">
        The Corporate Secretariat is compiling the status of SBU's compliance with ${directive.source === 'CG' ? 'Committee of Governors' : 'Board of Directors'} decisions from January to September 2025. Please send your submission by <strong>24th October 2025</strong>.
      </p>
    </div>
    
    <!-- SUBJECT -->
    <div style="padding: 20px 24px; background: #f9fafb; border-bottom: 1px solid #e5e7eb;">
      <div style="font-size: 11px; font-weight: 700; color: #6b7280; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px;">Subject</div>
      <div style="font-weight: 700; color: #111827; font-size: 14px; line-height: 1.5;">${directive.subject}</div>
    </div>
    
    <!-- PARTICULARS -->
    ${directive.particulars && directive.particulars.trim() !== '' ? `
    <div style="padding: 20px 24px; background: white; border-bottom: 1px solid #e5e7eb;">
      <div style="font-size: 11px; font-weight: 700; color: #6b7280; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px;">Directive Particulars</div>
      <div style="color: #374151; line-height: 1.6; font-size: 13px;">${directive.particulars}</div>
    </div>
    ` : ''}
    
    ${implementationTimeline}
    
    <!-- OUTCOMES -->
    <div style="padding: 20px 24px; background: white; border-bottom: 1px solid #e5e7eb;">
      <div style="font-size: 11px; font-weight: 700; color: #6b7280; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 16px;">Required Outcomes & Current Status</div>
      <div style="background: #f9fafb; padding: 16px; border-radius: 8px; border: 1px solid #e5e7eb;">
        ${outcomesHtml}
      </div>
    </div>
    
    <!-- BIG CALL-TO-ACTION BUTTON -->
    <div style="padding: 40px 24px; background: linear-gradient(135deg, #4f46e5 0%, #6366f1 100%); text-align: center;">
      <div style="margin-bottom: 20px;">
        <svg style="width: 56px; height: 56px; color: white; margin: 0 auto;" fill="currentColor" viewBox="0 0 20 20">
          <path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828z"/>
        </svg>
      </div>
      
      <h3 style="color: white; font-size: 20px; font-weight: 700; margin: 0 0 12px 0;">
        Submit Your Implementation Update
      </h3>
      
      <p style="color: #e0e7ff; font-size: 14px; line-height: 1.6; margin: 0 0 28px 0; max-width: 500px; margin-left: auto; margin-right: auto;">
        Click the button below to access the secure submission portal where you can update the implementation status, add timeline details, and upload supporting documents.
      </p>
      
      <a href="${submissionUrl}" style="display: inline-block; background: white; color: #4f46e5; font-weight: 700; padding: 18px 48px; border-radius: 10px; text-decoration: none; font-size: 16px; box-shadow: 0 6px 12px rgba(0, 0, 0, 0.2); transition: transform 0.2s;">
        Submit Update Now →
      </a>
      
      <p style="color: #c7d2fe; font-size: 11px; margin: 24px 0 0 0; line-height: 1.5;">
        Or copy this link to your browser:<br>
        <span style="background: rgba(255,255,255,0.1); padding: 6px 12px; border-radius: 4px; display: inline-block; margin-top: 8px; font-family: monospace; font-size: 10px; word-break: break-all;">
          ${submissionUrl}
        </span>
      </p>
    </div>
    
    <!-- ACTION REQUIRED BOX -->
    <div style="padding: 24px; background: #eff6ff; border-top: 1px solid #dbeafe;">
      <div style="display: flex; align-items-start;">
        <svg style="width: 20px; height: 20px; color: #1e40af; margin-right: 12px; flex-shrink: 0; margin-top: 2px;" fill="currentColor" viewBox="0 0 20 20">
          <path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z"/>
        </svg>
        <div>
          <p style="color: #1e40af; font-size: 13px; font-weight: 600; line-height: 1.6; margin: 0 0 8px 0;">
            <strong>Action Required:</strong> Please provide an update on the implementation status of the above outcomes.
          </p>
          <p style="color: #1e40af; font-size: 12px; line-height: 1.5; margin: 0;">
            Your response is needed to compile the status of compliance with ${directive.source === 'CG' ? 'Council of Governors' : 'Board of Directors'} decisions. You can update outcome statuses, add implementation timelines, document challenges, and upload supporting files through the submission portal.
          </p>
        </div>
      </div>
    </div>
    
    <!-- FOOTER -->
    <div style="padding: 16px 24px; background: #f9fafb; border-top: 1px solid #e5e7eb; text-align: center;">
      <p style="color: #6b7280; font-size: 11px; margin: 0 0 4px 0;">
        This is an automated reminder from the CBN Directives Management System
      </p>
      <p style="color: #9ca3af; font-size: 10px; margin: 0;">
        For technical support, contact the Strategy & Innovation Department
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
    // CHECK IF EMAIL EXISTS AND IS VALID
    if (!directive.primaryEmail || directive.primaryEmail.trim() === '') {
      console.log(`   ⚠️  No email address for directive ${directive.ref} (${directive.owner})`);
      return false;
    }

    const emailHtml = generateMemoEmail(directive);
    
    const recipients = [directive.primaryEmail];
    if (directive.secondaryEmail && directive.secondaryEmail.trim() !== '') {
      recipients.push(directive.secondaryEmail);
    }

    // VALIDATE EMAIL FORMAT
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const validRecipients = recipients.filter(email => emailRegex.test(email));
    
    if (validRecipients.length === 0) {
      console.log(`   ⚠️  No valid email addresses for directive ${directive.ref}`);
      return false;
    }

    const mailOptions = {
      from: `"CBN Directives System" <${process.env.EMAIL_USER}>`,
      to: validRecipients.join(', '),
      subject: `Reminder ${directive.reminders + 1}/3: Status Update Required - ${directive.ref}`,
      html: emailHtml
    };

    await emailTransporter.sendMail(mailOptions);
    console.log(`   ✅ Email sent to: ${validRecipients.join(', ')}`);
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

// REPLACE the getGoogleSheetsClient function in your server.js with this version
// This fixes the credentials path issue

const path = require('path'); // Add this at the top of your file with other requires

async function getGoogleSheetsClient() {
  try {
    // Method 1: Use environment variable if available
    if (process.env.GOOGLE_CREDENTIALS_PATH) {
      const auth = new google.auth.GoogleAuth({
        keyFile: process.env.GOOGLE_CREDENTIALS_PATH,
        scopes: SCOPES,
      });
      const client = await auth.getClient();
      return google.sheets({ version: 'v4', auth: client });
    }
    
    // Method 2: Look for credentials.json in project root
    const credentialsPath = path.join(__dirname, '.credentials.json');
    const fs = require('fs');
    
   if (fs.existsSync(credentialsPath)) {
      const auth = new google.auth.GoogleAuth({
        keyFile: credentialsPath,
        scopes: SCOPES,
      });
      const client = await auth.getClient();
      return google.sheets({ version: 'v4', auth: client });
    }
    
    // Method 3: Use service account credentials from environment variable (JSON string)
    if (process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
      const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
      const auth = new google.auth.GoogleAuth({
        credentials: credentials,
        scopes: SCOPES,
      });
      const client = await auth.getClient();
      return google.sheets({ version: 'v4', auth: client });
    }
    
    throw new Error('Google credentials not found. Please provide credentials via:\n' +
                    '1. GOOGLE_CREDENTIALS_PATH in .env pointing to credentials.json\n' +
                    '2. credentials.json in project root directory\n' +
                    '3. GOOGLE_SERVICE_ACCOUNT_KEY in .env with JSON credentials');
    
  } catch (error) {
    console.error('❌ Error setting up Google Sheets client:', error.message);
    throw error;
  }
}



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
  if (!dateStr || dateStr === '' || dateStr === ',,') return null;  // ✅ Return null for empty
  
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
  
  return null;  // ✅ Return null instead of today's date
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




// REPLACE the fetchSheetData function in your server.js with this corrected version
// This fixes the column mapping to properly read Process Owner from column F

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
      range: `'${tabName}'!A1:J1000`,
    });

    const rows = response.data.values;
    if (!rows || rows.length < 4) {
      console.log(`⚠️  Not enough data in "${tabName}"`);
      return [];
    }

    const dataRows = rows.slice(3);
    console.log(`📊 Total data rows after skipping first 3: ${dataRows.length}`);

    const COL = {
      REF_NO: 0,
      DATE: 1,
      SUBJECT: 2,
      PARTICULARS: 3,
      PROCESS_OWNER: 4,
      AMOUNT: 5,
      VENDOR: 6,
      IMPL_DEADLINE: 7,
      IMPL_STATUS: 8,
      MONITOR_STATUS: 9
    };

    // ⭐ ULTRA-FLEXIBLE REF EXTRACTION WITH SUB-LETTER PRESERVATION
    function extractRefNumber(cellText) {
      if (!cellText) return null;
      
      const cleaned = cellText.toString().trim();
      
      if (cleaned.toUpperCase().includes('MEETING AT WHICH')) return null;
      if (cleaned === '' || cleaned === ',,' || cleaned === "'" || cleaned === "''") return null;
      
      // ⭐ PATTERN: Captures sub-letters like (a), (b), (c)
      const pattern = /(CG|BD|Board)\s*\/\s*[A-Z]{3,4}\s*\/\s*\d+\s*\/\s*\d{4}\s*\/\s*\d+\s*(?:\([a-z]\)|\s+\([a-z]\))?/i;
      const match = cleaned.match(pattern);
      
      if (match) {
        let ref = match[0];
        ref = ref.replace(/\s+/g, ''); // Remove all spaces
        ref = ref.toUpperCase(); // Uppercase
        
        console.log(`   🔍 Extracted REF: "${ref}" from cell: "${cleaned}"`);
        return ref;
      }
      
      return null;
    }

    // ⭐ SMART AMOUNT PARSER - extracts valid amounts
    function parseAmount(cellText) {
      if (!cellText) return null;
      
      const cleaned = cellText.toString().trim();
      
      // Skip empty/placeholder cells
      if (cleaned === '' || cleaned === ',,' || cleaned === "'" || cleaned === "''") return null;
      
      // Must contain numbers OR currency symbols
      const hasNumbers = /\d/.test(cleaned);
      const hasCurrency = /[₦$£€]|USD|GBP|EUR|Naira|billion|million/i.test(cleaned);
      
      // Skip if looks like a name (starts with capital letter followed by lowercase, has space, then another capital)
      const looksLikeName = /^[A-Z][a-z]+\s+[A-Z]/.test(cleaned);
      
      if ((hasNumbers || hasCurrency) && !looksLikeName) {
        return cleaned;
      }
      
      return null;
    }

    const directiveMap = new Map();
    let lastValidOwner = 'Unassigned';
    let refsFound = 0;
    
    dataRows.forEach((row, index) => {
      if (!row || row.length === 0) return;
      
      const refCell = (row[COL.REF_NO] || '').toString();
      const extractedRef = extractRefNumber(refCell);
      
      if (extractedRef) {
        // ⭐ NEW REF FOUND
        refsFound++;
        
        if (directiveMap.has(extractedRef)) {
          // CONTINUATION - add to existing directive
          const existingGroup = directiveMap.get(extractedRef);
          
          // Add particular if present
          const particular = (row[COL.PARTICULARS] || '').toString().trim();
          if (particular && particular !== ',,' && particular !== "'") {
            existingGroup.particulars.push(particular);
          }
          
          // ⭐ ADD AMOUNT from continuation row
          const amount = parseAmount(row[COL.AMOUNT]);
          if (amount) {
            if (existingGroup.amounts.length > 0) {
              existingGroup.amounts.push(amount);
            } else {
              existingGroup.amounts = [amount];
            }
            console.log(`   💰 Added amount to ${extractedRef}: ${amount}`);
          }
          
          console.log(`   🔗 Row ${index + 4}: Added to existing ${extractedRef} (${existingGroup.particulars.length} outcomes)`);
        } else {
          // ⭐ BRAND NEW DIRECTIVE
          
          // Parse owner
          const rawOwner = (row[COL.PROCESS_OWNER] || '').toString().trim();
          const isPlaceholder = !rawOwner || rawOwner === '' || rawOwner === ',,' || rawOwner === "'" || rawOwner === "''";
          
          let processOwner = lastValidOwner;
          
          if (!isPlaceholder) {
            let cleanOwner = rawOwner
              .replace(/^['"]+|['"]+$/g, '')
              .replace(/\s*CC:\s*/gi, '\n')
              .split('\n')[0]
              .replace(/Director of/gi, 'Director,')
              .replace(/,\s*$/, '')
              .trim();
            
            if (cleanOwner && cleanOwner.length > 3 && /[a-zA-Z]{3,}/.test(cleanOwner)) {
              if (!cleanOwner.includes('₦') && !cleanOwner.includes('billion') && !cleanOwner.includes('trillion')) {
                processOwner = cleanOwner;
                lastValidOwner = cleanOwner;
              }
            }
          }
          
          // Parse date
          const dateCell = (row[COL.DATE] || '').toString().trim();
          let meetingDate = new Date();
          
          if (dateCell && dateCell !== ',,' && dateCell !== "'") {
            const dateMatch = dateCell.match(/(\d{1,2})\w*\s+of\s+([A-Za-z]+)\s+(\d{4})/);
            if (dateMatch) {
              meetingDate = new Date(`${dateMatch[2]} ${dateMatch[1]}, ${dateMatch[3]}`);
            } else {
              meetingDate = parseDate(dateCell);
            }
          }
          
          // ⭐ COLLECT AMOUNTS (can be multiple)
          const amounts = [];
          const firstAmount = parseAmount(row[COL.AMOUNT]);
          if (firstAmount) {
            amounts.push(firstAmount);
          }
          
          // Create new group
          const newGroup = {
            refNo: extractedRef,
            meetingDate: meetingDate,
            subject: (row[COL.SUBJECT] || '').toString().trim(),
            processOwner: processOwner,
            amounts: amounts, // ⭐ Array to hold multiple amounts
            vendor: (row[COL.VENDOR] || '').toString().trim(),
            implDeadline: (row[COL.IMPL_DEADLINE] || '').toString().trim(),
            implStatus: (row[COL.IMPL_STATUS] || '').toString().trim(),
            monitorStatus: (row[COL.MONITOR_STATUS] || '').toString().trim(),
            particulars: []
          };
          
          // Add first particular
          const firstParticular = (row[COL.PARTICULARS] || '').toString().trim();
          if (firstParticular && firstParticular !== ',,' && firstParticular !== "'") {
            newGroup.particulars.push(firstParticular);
          }
          
          directiveMap.set(extractedRef, newGroup);
          console.log(`\n📌 NEW DIRECTIVE: ${extractedRef}`);
          console.log(`   Owner: "${processOwner}"`);
          console.log(`   Date: ${meetingDate.toDateString()}`);
          if (amounts.length > 0) {
            console.log(`   Amount: ${amounts[0]}`);
          }
        }
      } else {
        // Row with no REF - continuation of last directive
        const lastEntry = Array.from(directiveMap.values()).pop();
        if (lastEntry) {
          // Add particular if present
          const particular = (row[COL.PARTICULARS] || '').toString().trim();
          if (particular && particular !== ',,' && particular !== "'") {
            lastEntry.particulars.push(particular);
            console.log(`   └─ Row ${index + 4}: Added particular to ${lastEntry.refNo} (${lastEntry.particulars.length})`);
          }
          
          // ⭐ ADD AMOUNT from continuation row
          const amount = parseAmount(row[COL.AMOUNT]);
          if (amount) {
            lastEntry.amounts.push(amount);
            console.log(`   └─💰 Added amount: ${amount}`);
          }
        }
      }
    });

    const groups = Array.from(directiveMap.values());
    console.log(`\n✨ SYNC SUMMARY for "${tabName}":`);
    console.log(`   📋 Total rows scanned: ${dataRows.length}`);
    console.log(`   🔢 Unique REF numbers found: ${refsFound}`);
    console.log(`   📦 Directives created: ${groups.length}\n`);

    // Convert to directives
    const directives = groups.map((group, idx) => {
      const outcomes = group.particulars.map(particular => ({
        text: smartTruncate(particular, 300),
        status: 'Not Started'
      }));
      
      if (outcomes.length === 0) {
        outcomes.push({
          text: group.subject || 'Implementation required',
          status: 'Not Started'
        });
      }
      
      const combinedParticulars = group.particulars.length > 0 
        ? group.particulars.join('\n\n') 
        : group.subject;
      
      const implDeadline = parseDate(group.implDeadline);
      
      // Normalize monitoring status
      let monitoringStatus = group.monitorStatus || 'Awaiting Next Reminder';
      if (monitoringStatus.trim() === '') {
        monitoringStatus = 'Awaiting Next Reminder';
      }
      
      // ⭐ COMBINE AMOUNTS - join with line breaks
      const combinedAmount = group.amounts.length > 0 
        ? group.amounts.join('\n') 
        : '';
      
      console.log(`✅ ${idx + 1}/${groups.length}: ${group.refNo} - ${outcomes.length} outcomes, ${group.amounts.length} amount(s)`);
      
      return {
        source: tabName.toLowerCase().includes('board') ? 'Board' : 'CG',
        sheetName: tabName,
        ref: group.refNo,
        meetingDate: group.meetingDate,
        subject: group.subject || 'No Subject',
        particulars: combinedParticulars,
        owner: group.processOwner,
        primaryEmail: '',
        secondaryEmail: '',
        amount: combinedAmount, // ⭐ All amounts combined
        vendor: group.vendor || '',
        implementationStartDate: null,
        implementationEndDate: implDeadline,
// ⭐ SMART STATUS EXTRACTION
implementationStatus: extractStandardStatus(group.implStatus),
additionalComments: extractComments(group.implStatus),
        monitoringStatus: monitoringStatus,
        outcomes: outcomes,
        statusHistory: [{
          status: monitoringStatus,
          changedAt: new Date(),
          notes: 'Initial status from Google Sheet'
        }]
      };
    });

    console.log(`\n🎉 Successfully created ${directives.length} directives from "${tabName}"\n`);
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
    'On Track': { type: Boolean, default: true },  // Changed from 'Awaiting Next Reminder'
    'At Risk': { type: Boolean, default: true },
    'High Risk': { type: Boolean, default: true }
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
    'On Track': true,  // ✅ CORRECT
    'At Risk': true,
    'High Risk': true
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

cron.schedule('0 9 * * *', () => {
  console.log('⏰ Scheduled reminder check triggered');
  sendReminders();
});

// ==========================================
// API ROUTES
// ==========================================

// Test email endpoint with timeout handling
app.post('/api/test-email', async (req, res) => {
  const timeout = setTimeout(() => {
    if (!res.headersSent) {
      res.status(408).json({ 
        success: false, 
        error: 'Email operation timed out. Please check your email configuration.' 
      });
    }
  }, 15000); // 15 second timeout

  try {
    const { testEmail } = req.body;
    
    if (!emailTransporter) {
      clearTimeout(timeout);
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
    clearTimeout(timeout);
    
    res.json({ 
      success: true, 
      message: `Test email sent successfully to ${testEmail}` 
    });
  } catch (error) {
    clearTimeout(timeout);
    console.error('Test email error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Email preview endpoint
app.post('/api/preview-email/:id', async (req, res) => {
  try {
    const directive = await Directive.findById(req.params.id);
    if (!directive) {
      return res.status(404).json({ success: false, error: 'Directive not found' });
    }
    
    const emailHtml = generateMemoEmail(directive);
    res.json({ success: true, html: emailHtml });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
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
    
    const directivesWithStatus = directives.map(d => {
      const directive = d.toObject();
      
      // Calculate real-time monitoring status
      const allOutcomesCompleted = directive.outcomes?.length > 0 && 
        directive.outcomes.every(o => o.status === 'Completed');
      
      if (allOutcomesCompleted || directive.implementationStatus === 'Completed') {
        directive.monitoringStatus = 'Completed';
      } else if (!directive.implementationEndDate) {
        directive.monitoringStatus = 'Needs Timeline';  // ⭐ Distinct status
      } else {
        const today = new Date();
        const daysUntilEnd = Math.ceil((new Date(directive.implementationEndDate) - today) / (1000 * 60 * 60 * 24));
        
        if (daysUntilEnd <= 7) {
          directive.monitoringStatus = 'High Risk';
        } else if (daysUntilEnd < 30 || directive.reminders >= 3) {
          directive.monitoringStatus = 'At Risk';
        } else {
          directive.monitoringStatus = 'On Track';
        }
      }
      
      // Check responsiveness
      if (directive.reminders >= 3 && 
          (!directive.lastSbuUpdate || 
           (directive.lastReminderDate && new Date(directive.lastSbuUpdate) < new Date(directive.lastReminderDate)))) {
        directive.isResponsive = false;
      } else {
        directive.isResponsive = true;
      }
      
      return directive;
    });
    
    res.json({ success: true, data: directivesWithStatus });
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
    
    // ⭐ Auto-calculate monitoring status in real-time
    const directiveObj = directive.toObject();
    
    const allOutcomesCompleted = directiveObj.outcomes?.length > 0 && 
      directiveObj.outcomes.every(o => o.status === 'Completed');
    
    if (allOutcomesCompleted || directiveObj.implementationStatus === 'Completed') {
      directiveObj.monitoringStatus = 'Completed';
    } else if (!directiveObj.implementationEndDate) {
      directiveObj.monitoringStatus = 'Needs Timeline';
    } else {
      const today = new Date();
      const daysUntilEnd = Math.ceil((new Date(directiveObj.implementationEndDate) - today) / (1000 * 60 * 60 * 24));
      
      if (daysUntilEnd <= 7) {
        directiveObj.monitoringStatus = 'High Risk';
      } else if (daysUntilEnd < 30 || directiveObj.reminders >= 3) {
        directiveObj.monitoringStatus = 'At Risk';
      } else {
        directiveObj.monitoringStatus = 'On Track';
      }
    }
    
    if (directiveObj.reminders >= 3 && 
        (!directiveObj.lastSbuUpdate || 
         (directiveObj.lastReminderDate && new Date(directiveObj.lastSbuUpdate) < new Date(directiveObj.lastReminderDate)))) {
      directiveObj.isResponsive = false;
    } else {
      directiveObj.isResponsive = true;
    }
    
    res.json({ success: true, data: directiveObj });
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
  additionalComments,  // ⭐ ADD THIS
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


    
    // ⭐ CHECK IF EMAIL WAS CHANGED
    const emailChanged = (
      (primaryEmail !== undefined && primaryEmail !== directive.primaryEmail) ||
      (secondaryEmail !== undefined && secondaryEmail !== directive.secondaryEmail)
    );
    
    const oldOwner = directive.owner;
    const newOwner = owner || directive.owner;
    
    // Update the current directive
if (outcomes) directive.outcomes = outcomes;
if (implementationStatus) directive.implementationStatus = implementationStatus;
if (completionNote) directive.completionNote = completionNote;

// ⭐ APPEND ADDITIONAL COMMENTS (don't overwrite)
if (additionalComments && additionalComments.trim()) {
    const timestamp = new Date().toLocaleString('en-GB', { 
        day: '2-digit', 
        month: 'short', 
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
    
    const newComment = `[${timestamp}] ${additionalComments.trim()}`;
    
    if (directive.additionalComments && directive.additionalComments.trim()) {
        // Append to existing comments
        directive.additionalComments += '\n\n' + newComment;
    } else {
        // First comment
        directive.additionalComments = newComment;
    }
}

    if (implementationStartDate) directive.implementationStartDate = new Date(implementationStartDate);
    if (implementationEndDate) directive.implementationEndDate = new Date(implementationEndDate);
    if (meetingDate) directive.meetingDate = new Date(meetingDate);
    if (owner) directive.owner = owner;
    if (subject) directive.subject = subject;
    if (particulars) directive.particulars = particulars;
    if (amount !== undefined) directive.amount = amount;
    if (sheetName) directive.sheetName = sheetName;
    if (primaryEmail !== undefined) directive.primaryEmail = primaryEmail;
    if (secondaryEmail !== undefined) directive.secondaryEmail = secondaryEmail;
    
    if (outcomes) {
      directive.lastSbuUpdate = new Date();
      directive.lastResponseDate = new Date();
    }
    
    await directive.updateMonitoringStatus(outcomes ? 'SBU update received' : 'Directive edited');
    
    // ⭐ IF EMAIL WAS CHANGED, UPDATE ALL DIRECTIVES WITH THE SAME OWNER
    if (emailChanged && newOwner) {
      try {
        const updateResult = await Directive.updateMany(
          { 
            owner: newOwner,
            _id: { $ne: directive._id } // Don't update the current directive again
          },
          {
            $set: {
              primaryEmail: directive.primaryEmail,
              secondaryEmail: directive.secondaryEmail
            }
          }
        );
        
        console.log(`✅ Updated email for ${updateResult.modifiedCount} other directive(s) with owner: ${newOwner}`);
        
        res.json({ 
          success: true, 
          data: directive,
          emailsUpdated: updateResult.modifiedCount,
          message: emailChanged ? `Email updated for ${newOwner} across ${updateResult.modifiedCount + 1} directive(s)` : null
        });
      } catch (emailUpdateError) {
        console.error('⚠️  Failed to update emails for other directives:', emailUpdateError);
        // Still return success for the main directive update
        res.json({ 
          success: true, 
          data: directive,
          warning: 'Directive updated but failed to sync email to other directives with same owner'
        });
      }
    } else {
      res.json({ success: true, data: directive });
    }
    
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
   const track = await Directive.countDocuments({ ...query, monitoringStatus: 'On Track' });
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
    'On Track': true,  // ✅ CORRECT
    'At Risk': true,
    'High Risk': true
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

app.get('/submit-update/test', (req, res) => {
  res.send('<h1>✅ Route is working!</h1>');
});




// ==========================================
// EMAIL MANAGEMENT API ROUTES
// ==========================================

// Get all process owners with their directives
app.get('/api/process-owners-with-directives', async (req, res) => {
  try {
    const directives = await Directive.find().sort({ owner: 1, createdAt: -1 });
    
    // Group by owner
    const ownerMap = new Map();
    
    directives.forEach(directive => {
      const ownerName = directive.owner || 'Unassigned';
      
      if (!ownerMap.has(ownerName)) {
        ownerMap.set(ownerName, {
          name: ownerName,
          primaryEmail: directive.primaryEmail || '',
          secondaryEmail: directive.secondaryEmail || '',
          directiveCount: 0,
          directives: []
        });
      }
      
      const owner = ownerMap.get(ownerName);
      owner.directiveCount++;
      owner.directives.push({
        _id: directive._id,
        ref: directive.ref,
        subject: directive.subject,
        source: directive.source,
        monitoringStatus: directive.monitoringStatus
      });
    });
    
    // Convert map to array and sort
    const owners = Array.from(ownerMap.values()).sort((a, b) => {
      // Sort: without email first, then by name
      const aHasEmail = a.primaryEmail && a.primaryEmail.trim() !== '';
      const bHasEmail = b.primaryEmail && b.primaryEmail.trim() !== '';
      
      if (aHasEmail === bHasEmail) {
        return a.name.localeCompare(b.name);
      }
      return aHasEmail ? 1 : -1;
    });
    
    res.json({ success: true, data: owners });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Update emails for all directives of a specific owner
app.post('/api/update-owner-emails', async (req, res) => {
  try {
    const { owner, primaryEmail, secondaryEmail } = req.body;
    
    if (!owner) {
      return res.status(400).json({ success: false, error: 'Owner name required' });
    }
    
    // Update all directives for this owner
    const result = await Directive.updateMany(
      { owner: owner },
      {
        $set: {
          primaryEmail: primaryEmail || '',
          secondaryEmail: secondaryEmail || ''
        }
      }
    );
    
    res.json({ 
      success: true, 
      updated: result.modifiedCount,
      message: `Updated ${result.modifiedCount} directives for ${owner}`
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});



app.listen(PORT, () => {
  console.log(`\n🚀 CBN Directives Platform - EMAIL INTEGRATED & FIXED`);
  console.log(`📍 Server: http://localhost:${PORT}`);
  console.log(`💾 MongoDB: ${mongoose.connection.readyState === 1 ? '✅ Connected' : '⏳ Connecting...'}`);
  console.log(`📧 Email: ${emailTransporter ? '✅ Configured' : '❌ Not Configured'}`);
  console.log(`\n✨ Features:`);
  console.log(`   • Email collection (primary + secondary)`);
  console.log(`   • Automated email reminders in CBN memo format`);
  console.log(`   • Email preview before sending`);
  console.log(`   • Improved timeout handling for Render deployment\n`);
});



// ADD this endpoint to your server.js file (after the /api/directives/:id/remind endpoint)


// Request Update - COUNTS AS A REMINDER
// REPLACE the entire /api/directives/:id/request-update endpoint with this:

app.post('/api/directives/:id/request-update', async (req, res) => {
  try {
    const directive = await Directive.findById(req.params.id);
    if (!directive) {
      return res.status(404).json({ success: false, error: 'Directive not found' });
    }

    const { selectedOutcomes } = req.body; // Array of indices [0, 2, 5]
    
    if (!selectedOutcomes || selectedOutcomes.length === 0) {
      return res.status(400).json({ success: false, error: 'No outcomes selected' });
    }

    if (!directive.primaryEmail || directive.primaryEmail.trim() === '') {
      return res.status(400).json({ success: false, error: 'No email configured for this process owner' });
    }

    if ((directive.reminders || 0) >= 3) {
      return res.status(400).json({ success: false, error: 'Maximum reminders (3) already sent' });
    }

    // Generate unique token
    const token = crypto.randomBytes(32).toString('hex');

    // Save token with selected outcome INDICES
    const submissionToken = new SubmissionToken({
      token: token,
      directiveId: directive._id,
      selectedOutcomes: selectedOutcomes,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    });
    await submissionToken.save();

    const baseUrl = process.env.BASE_URL || 'https://directives-new.onrender.com';
    const submissionUrl = `${baseUrl}/submit-update/${directive._id}?token=${token}`;

    const today = new Date();
    const dateStr = `${today.getDate()}${getOrdinal(today.getDate())} ${today.toLocaleString('default', { month: 'long' })} ${today.getFullYear()}`;

    // Build outcomes HTML - ONLY selected ones
    const outcomesToShow = selectedOutcomes.map(idx => ({
      outcome: directive.outcomes[idx],
      originalIndex: idx
    })).filter(o => o.outcome);

    const outcomesHtml = outcomesToShow.map(({ outcome, originalIndex }) => {
      const statusColor = {
        'Not Started': '#6b7280',
        'Being Implemented': '#3b82f6',
        'Delayed': '#f59e0b',
        'Completed': '#10b981'
      }[outcome.status] || '#6b7280';

      return `
        <div style="margin-bottom: 16px; padding: 16px; background: white; border-radius: 8px; border-left: 4px solid ${statusColor};">
          <div style="font-weight: 700; color: #1B5E20; margin-bottom: 8px; font-size: 13px;">Outcome ${originalIndex + 1}</div>
          <div style="color: #374151; font-size: 13px; line-height: 1.5; margin-bottom: 8px;">${outcome.text}</div>
          <span style="display: inline-block; padding: 4px 10px; border-radius: 12px; font-size: 11px; font-weight: 600; background: ${statusColor}; color: white;">${outcome.status}</span>
        </div>
      `;
    }).join('');

    const emailHtml = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="font-family: Arial, sans-serif; background: #f5f5f5; margin: 0; padding: 20px;">
  <div style="max-width: 650px; margin: 0 auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
    
    <!-- Header -->
    <div style="padding: 24px; background: linear-gradient(135deg, #1B5E20 0%, #2E7D32 100%); color: white;">
      <h1 style="margin: 0; font-size: 18px; text-transform: uppercase;">Request for Status Update</h1>
      <p style="margin: 8px 0 0 0; opacity: 0.9; font-size: 13px;">Central Bank of Nigeria - Corporate Secretariat</p>
    </div>
    
    <!-- Memo Info -->
    <div style="padding: 16px 24px; background: #f9fafb; border-bottom: 1px solid #e5e7eb; font-size: 13px;">
      <div><strong>To:</strong> ${directive.owner}</div>
      <div style="margin-top: 4px;"><strong>Ref:</strong> ${directive.ref || 'N/A'} &nbsp;|&nbsp; <strong>Date:</strong> ${dateStr}</div>
    </div>
    
    <!-- Subject -->
    <div style="padding: 16px 24px; border-bottom: 1px solid #e5e7eb;">
      <div style="font-size: 11px; color: #6b7280; text-transform: uppercase; font-weight: 600; margin-bottom: 4px;">Subject</div>
      <div style="font-size: 14px; font-weight: 600; color: #111827;">${directive.subject}</div>
    </div>
    
    <!-- Outcomes Header -->
    <div style="padding: 12px 24px; background: #E8F5E9;">
      <div style="font-size: 13px; font-weight: 700; color: #1B5E20;">
        📋 Outcomes Requiring Update (${outcomesToShow.length} of ${directive.outcomes.length})
      </div>
    </div>
    
    <!-- Outcomes -->
    <div style="padding: 20px 24px; background: #fafafa;">
      ${outcomesHtml}
    </div>
    
    <!-- CTA Button -->
    <div style="padding: 32px 24px; text-align: center; background: linear-gradient(135deg, #1B5E20 0%, #2E7D32 100%);">
      <h3 style="color: white; margin: 0 0 12px 0; font-size: 18px;">Submit Your Implementation Update</h3>
      <p style="color: #C8E6C9; margin: 0 0 20px 0; font-size: 13px;">Click the button below to update status, add timelines, and upload documents</p>
      <a href="${submissionUrl}" style="display: inline-block; background: white; color: #1B5E20; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: 700; font-size: 14px;">
        📝 Submit Update Now →
      </a>
    </div>
    
    <!-- Footer -->
    <div style="padding: 16px 24px; background: #f9fafb; text-align: center; border-top: 1px solid #e5e7eb;">
      <p style="margin: 0; font-size: 11px; color: #6b7280;">Automated message from CBN Directives Management System</p>
    </div>
  </div>
</body>
</html>
    `;

    // Send email
    let emailSent = false;
    if (emailTransporter) {
      try {
        const recipients = [directive.primaryEmail];
        if (directive.secondaryEmail && directive.secondaryEmail.trim() !== '') {
          recipients.push(directive.secondaryEmail);
        }

        await emailTransporter.sendMail({
          to: recipients.join(', '),
          subject: `Status Update Request - ${directive.ref || directive.subject}`,
          html: emailHtml
        });
        emailSent = true;
        console.log(`✅ Request email sent to: ${recipients.join(', ')}`);
      } catch (emailError) {
        console.error('❌ Email send failed:', emailError.message);
        return res.status(500).json({ success: false, error: `Email failed: ${emailError.message}` });
      }
    }

    // Update directive tracking
    directive.reminders = (directive.reminders || 0) + 1;
    directive.lastReminderDate = new Date();
    if (!directive.reminderHistory) directive.reminderHistory = [];
    directive.reminderHistory.push({
      sentAt: new Date(),
      recipient: directive.primaryEmail,
      method: 'Email',
      acknowledged: false
    });
    await directive.save();

    res.json({
      success: true,
      message: `Request sent to ${directive.primaryEmail}`,
      emailSent: emailSent,
      reminder: `${directive.reminders}/3`
    });

  } catch (error) {
    console.error('Request update error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});








/// Replace the DELETE endpoint with this GET version
app.get('/api/admin/clear-directives', async (req, res) => {
  try {
    const result = await Directive.deleteMany({});
    res.json({ 
      success: true, 
      message: `Deleted ${result.deletedCount} directives` 
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});


// ==========================================
// SUBMISSION PORTAL - GET PAGE
// ==========================================

// ==========================================
// SUBMISSION PORTAL - GET PAGE
// ==========================================
// REPLACE the entire /submit-update/:id GET endpoint with this:
app.get('/submit-update/:id', async (req, res) => {
  try {
    const directive = await Directive.findById(req.params.id);
    if (!directive) {
      return res.status(404).send('<h1>Directive not found</h1>');
    }

    const token = req.query.token;
    let outcomesToShow = directive.outcomes.map((o, idx) => ({ outcome: o, originalIndex: idx }));

    // If token provided, filter to selected outcomes only
    if (token) {
      const submissionToken = await SubmissionToken.findOne({ 
        token: token,
        directiveId: req.params.id
      });

      if (submissionToken) {
        if (submissionToken.used) {
          return res.send('<h1>This submission link has already been used</h1>');
        }

        if (submissionToken.expiresAt && new Date() > submissionToken.expiresAt) {
          return res.send('<h1>This submission link has expired</h1>');
        }

        if (submissionToken.selectedOutcomes && submissionToken.selectedOutcomes.length > 0) {
          outcomesToShow = submissionToken.selectedOutcomes.map(idx => ({
            outcome: directive.outcomes[idx],
            originalIndex: idx
          })).filter(o => o.outcome);
        }
      }
    }

    // Build outcomes HTML
    const outcomesHtml = outcomesToShow.map(({ outcome, originalIndex }) => `
      <div class="bg-gray-50 rounded-lg border border-gray-200 p-4 mb-4">
        <div class="flex items-center justify-between mb-3">
          <span class="text-sm font-bold text-green-700">Outcome ${originalIndex + 1}</span>
          <span class="text-xs px-2 py-1 rounded-full font-semibold ${
            outcome.status === 'Completed' ? 'bg-green-100 text-green-700' :
            outcome.status === 'Being Implemented' ? 'bg-blue-100 text-blue-700' :
            outcome.status === 'Delayed' ? 'bg-orange-100 text-orange-700' :
            'bg-gray-100 text-gray-700'
          }">Current: ${outcome.status}</span>
        </div>
        
        <p class="text-sm text-gray-700 mb-3 leading-relaxed">${outcome.text}</p>
        
        <input type="hidden" name="outcome_index_${originalIndex}" value="${originalIndex}">
        
        <div class="space-y-3">
          <div>
            <label class="block text-xs font-semibold text-gray-600 mb-1">Update Status *</label>
            <select name="outcome_status_${originalIndex}" required class="outcome-status w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-green-500 text-sm">
              <option value="Not Started" ${outcome.status === 'Not Started' ? 'selected' : ''}>Not Started</option>
              <option value="Being Implemented" ${outcome.status === 'Being Implemented' ? 'selected' : ''}>Being Implemented</option>
              <option value="Delayed" ${outcome.status === 'Delayed' ? 'selected' : ''}>Delayed</option>
              <option value="Completed" ${outcome.status === 'Completed' ? 'selected' : ''}>Completed</option>
            </select>
          </div>
          
          <div>
            <label class="block text-xs font-semibold text-gray-600 mb-1">Challenges / Notes</label>
            <textarea name="outcome_challenges_${originalIndex}" rows="2" placeholder="Any challenges or updates..." class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-green-500 text-sm">${outcome.challenges || ''}</textarea>
          </div>
          
          <div class="completion-details-${originalIndex}" style="display: ${outcome.status === 'Completed' ? 'block' : 'none'};">
            <label class="block text-xs font-semibold text-gray-600 mb-1">Completion Details</label>
            <textarea name="outcome_completionDetails_${originalIndex}" rows="2" placeholder="Describe what was completed..." class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-green-500 text-sm">${outcome.completionDetails || ''}</textarea>
          </div>
          
          <div class="delay-reason-${originalIndex}" style="display: ${outcome.status === 'Delayed' ? 'block' : 'none'};">
            <label class="block text-xs font-semibold text-gray-600 mb-1">Reason for Delay</label>
            <textarea name="outcome_delayReason_${originalIndex}" rows="2" placeholder="Explain why this is delayed..." class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-green-500 text-sm">${outcome.delayReason || ''}</textarea>
          </div>
        </div>
      </div>
    `).join('');

    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Submit Update - ${directive.ref || 'CBN Directive'}</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
    <style>* { font-family: 'Inter', sans-serif; }</style>
</head>
<body class="bg-gray-100 min-h-screen py-8 px-4">
    <div class="max-w-3xl mx-auto">
        
        <!-- Header -->
        <div class="bg-gradient-to-r from-green-800 to-green-600 text-white rounded-t-xl p-6">
            <h1 class="text-2xl font-bold mb-1">📝 Submit Implementation Update</h1>
            <p class="text-green-100 text-sm">Central Bank of Nigeria - Corporate Secretariat</p>
        </div>
        
        <!-- Info -->
        <div class="bg-white border-b p-6">
            <div class="grid grid-cols-2 gap-4 text-sm">
                <div><span class="text-gray-500">Reference:</span> <span class="font-semibold">${directive.ref || 'N/A'}</span></div>
                <div><span class="text-gray-500">Process Owner:</span> <span class="font-semibold">${directive.owner}</span></div>
            </div>
            <div class="mt-4 p-3 bg-green-50 rounded-lg border border-green-200">
                <div class="text-xs text-gray-500 font-semibold mb-1">SUBJECT</div>
                <div class="text-sm font-semibold text-gray-900">${directive.subject}</div>
            </div>
            ${outcomesToShow.length < directive.outcomes.length ? `
            <div class="mt-3 p-2 bg-green-50 rounded-lg border border-green-200">
                <p class="text-xs font-semibold text-green-700">📋 Showing ${outcomesToShow.length} of ${directive.outcomes.length} outcomes as requested</p>
            </div>
            ` : ''}
        </div>

        <!-- Form -->
        <form id="updateForm" class="bg-white rounded-b-xl shadow-lg">
            
            <!-- Outcomes -->
            <div class="p-6 border-b">
                <h2 class="text-lg font-bold text-gray-900 mb-1">🎯 Update Outcomes</h2>
                <p class="text-sm text-gray-500 mb-4">Please update the status for each outcome below</p>
                ${outcomesHtml}
            </div>
            
            <!-- Timeline -->
            <div class="p-6 border-b">
                <h2 class="text-lg font-bold text-gray-900 mb-4">📅 Implementation Timeline</h2>
                <div class="grid grid-cols-2 gap-4">
                    <div>
                        <label class="block text-sm font-semibold text-gray-700 mb-2">Start Date</label>
                        <input type="date" name="implementationStartDate" value="${directive.implementationStartDate ? new Date(directive.implementationStartDate).toISOString().split('T')[0] : ''}" class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500">
                    </div>
                    <div>
                        <label class="block text-sm font-semibold text-gray-700 mb-2">End Date</label>
                        <input type="date" name="implementationEndDate" value="${directive.implementationEndDate ? new Date(directive.implementationEndDate).toISOString().split('T')[0] : ''}" class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500">
                    </div>
                </div>
            </div>
            
            <!-- Comments -->
            <div class="p-6 border-b">
                <h2 class="text-lg font-bold text-gray-900 mb-4">💬 Additional Comments</h2>
                <textarea name="completionNote" rows="3" placeholder="Any additional details..." class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-green-500"></textarea>
            </div>
            
            <!-- ⭐ FILE UPLOAD SECTION -->
            <div class="p-6 border-b">
                <h2 class="text-lg font-bold text-gray-900 mb-4">📎 Supporting Documents</h2>
                <div class="border-2 border-dashed border-gray-300 rounded-lg p-6 text-center cursor-pointer hover:border-green-500 transition-colors" onclick="document.getElementById('fileInput').click()">
                    <input type="file" id="fileInput" multiple accept=".pdf,.doc,.docx,.xls,.xlsx,.png,.jpg,.jpeg" class="hidden">
                    <svg class="w-12 h-12 mx-auto mb-3 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 48 48">
                        <path d="M28 8H12a4 4 0 00-4 4v20m32-12v8m0 0v8a4 4 0 01-4 4H12a4 4 0 01-4-4v-4m32-4l-3.172-3.172a4 4 0 00-5.656 0L28 28M8 32l9.172-9.172a4 4 0 015.656 0L28 28m0 0l4 4m4-24h8m-4-4v8m-12 4h.02" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                    <p class="text-sm text-gray-600 mb-1">
                        <span class="font-semibold text-green-700">Click to upload</span> or drag and drop
                    </p>
                    <p class="text-xs text-gray-500">PDF, DOC, XLS, PNG, JPG up to 10MB each (max 5 files)</p>
                </div>
                <div id="fileList" class="mt-3 space-y-2"></div>
            </div>
            
            <!-- Submit -->
            <div class="p-6">
                <button type="submit" id="submitBtn" class="w-full bg-gradient-to-r from-green-700 to-green-600 text-white font-bold py-3 rounded-lg hover:from-green-800 hover:to-green-700 transition-all shadow-lg">
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
            <button onclick="location.reload()" class="px-6 py-3 bg-green-600 text-white font-semibold rounded-lg hover:bg-green-700">Try Again</button>
        </div>
    </div>

    <script>
        // Show/hide conditional fields
        document.querySelectorAll('.outcome-status').forEach((select) => {
            select.addEventListener('change', function() {
                const match = this.name.match(/outcome_status_(\\d+)/);
                if (!match) return;
                const idx = match[1];
                
                const completionDiv = document.querySelector('.completion-details-' + idx);
                const delayDiv = document.querySelector('.delay-reason-' + idx);
                
                if (this.value === 'Completed') {
                    if (completionDiv) completionDiv.style.display = 'block';
                    if (delayDiv) delayDiv.style.display = 'none';
                } else if (this.value === 'Delayed') {
                    if (delayDiv) delayDiv.style.display = 'block';
                    if (completionDiv) completionDiv.style.display = 'none';
                } else {
                    if (completionDiv) completionDiv.style.display = 'none';
                    if (delayDiv) delayDiv.style.display = 'none';
                }
            });
        });
        
        // File upload handling
        const fileInput = document.getElementById('fileInput');
        const fileList = document.getElementById('fileList');
        
        fileInput.addEventListener('change', function() {
            fileList.innerHTML = '';
            if (this.files.length === 0) return;
            
            Array.from(this.files).forEach((file) => {
                const fileItem = document.createElement('div');
                fileItem.className = 'flex items-center justify-between p-2 bg-gray-50 rounded border border-gray-200';
                fileItem.innerHTML = '<div class="flex items-center"><svg class="w-4 h-4 mr-2 text-green-600" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M8 4a3 3 0 00-3 3v4a5 5 0 0010 0V7a1 1 0 112 0v4a7 7 0 11-14 0V7a5 5 0 0110 0v4a3 3 0 11-6 0V7a1 1 0 012 0v4a1 1 0 102 0V7a3 3 0 00-3-3z"/></svg><span class="text-xs font-medium text-gray-700">' + file.name + '</span><span class="text-xs text-gray-500 ml-2">(' + (file.size / 1024).toFixed(1) + ' KB)</span></div>';
                fileList.appendChild(fileItem);
            });
        });
        
        // Form submission
        document.getElementById('updateForm').addEventListener('submit', async function(e) {
            e.preventDefault();
            
            const btn = document.getElementById('submitBtn');
            btn.disabled = true;
            btn.textContent = '⏳ Submitting...';
            
            try {
                const formData = new FormData(this);
                
                // Add files
                const files = document.getElementById('fileInput').files;
                for (let i = 0; i < files.length; i++) {
                    formData.append('files', files[i]);
                }
                
                // Collect outcomes
                const outcomes = [];
                document.querySelectorAll('[name^="outcome_index_"]').forEach(input => {
                    const idx = parseInt(input.value);
                    outcomes.push({
                        originalIndex: idx,
                        status: formData.get('outcome_status_' + idx),
                        challenges: formData.get('outcome_challenges_' + idx) || '',
                        completionDetails: formData.get('outcome_completionDetails_' + idx) || '',
                        delayReason: formData.get('outcome_delayReason_' + idx) || ''
                    });
                });
                
                formData.append('outcomes', JSON.stringify(outcomes));
                
                const response = await fetch('/api/submit-update/${directive._id}?token=${token || ''}', {
                    method: 'POST',
                    body: formData
                });
                
                const result = await response.json();
                
                if (result.success) {
                    document.getElementById('updateForm').classList.add('hidden');
                    document.getElementById('successMessage').classList.remove('hidden');
                    window.scrollTo({ top: 0, behavior: 'smooth' });
                } else {
                    throw new Error(result.error || 'Submission failed');
                }
            } catch (error) {
                console.error('Submission error:', error);
                document.getElementById('updateForm').classList.add('hidden');
                document.getElementById('errorText').textContent = error.message;
                document.getElementById('errorMessage').classList.remove('hidden');
                window.scrollTo({ top: 0, behavior: 'smooth' });
            }
        });
    </script>
</body>
</html>
    `);
  } catch (error) {
    res.status(500).send('<h1>Error: ' + error.message + '</h1>');
  }
});











// Serve assets folder at root level
app.use('/assets', express.static(path.join(__dirname, 'assets')));

// Serve public folder
app.use(express.static(path.join(__dirname, 'public')));




// ADD multer storage configuration
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        const dir = `./uploads/${req.params.id || 'temp'}`;
        require('fs').mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + '-' + file.originalname);
    }
});

const upload = multer({
    storage: storage,
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
    fileFilter: (req, file, cb) => {
        const allowed = ['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'image/png', 'image/jpeg'];
        cb(null, allowed.includes(file.mimetype));
    }
}).array('files', 5);

// ADD static route for uploads
app.use('/uploads', express.static('uploads'));








// ADD these endpointss
app.post('/api/process-owners/register', async (req, res) => {
    try {
        const { email, password, name, department } = req.body;
        const hashedPassword = await bcrypt.hash(password, 10);
        const owner = await ProcessOwner.create({ email, password: hashedPassword, name, department });
        res.json({ success: true, owner: { email: owner.email, name: owner.name } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/process-owners/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const owner = await ProcessOwner.findOne({ email: email.toLowerCase() });
        if (!owner || !await bcrypt.compare(password, owner.password)) {
            return res.status(401).json({ success: false, error: 'Invalid credentials' });
        }
        owner.lastLogin = new Date();
        await owner.save();
        const token = crypto.randomBytes(32).toString('hex');
        res.json({ success: true, owner: { email: owner.email, name: owner.name }, token });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/process-owners/:email/pending-directives', async (req, res) => {
    try {
        const directives = await Directive.find({ primaryEmail: req.params.email.toLowerCase() });
        res.json({ success: true, data: directives });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});


// ADD this endpoint
app.get('/api/submission-token/:token', async (req, res) => {
    try {
        const tokenDoc = await SubmissionToken.findOne({ token: req.params.token }).populate('directiveId');
        if (!tokenDoc) return res.status(404).json({ success: false, error: 'Invalid token' });
        if (tokenDoc.isUsed) return res.json({ success: false, error: 'Token already used', usedAt: tokenDoc.usedAt });
        if (tokenDoc.expiresAt < new Date()) return res.status(410).json({ success: false, error: 'Token expired' });
        res.json({ success: true, directive: tokenDoc.directiveId, selectedOutcomes: tokenDoc.selectedOutcomes });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});



// MODIFY the submit-update endpoint
// Find this endpoint and update the outcomes parsing section
// ADD the POST handler
// FIND THIS (around line 1150):

app.post('/api/submit-update/:id', upload, async (req, res) => {
    try {
        const { token } = req.query;
        const updateSource = req.body.updateSource || 'reminder-link'; // Track source
        
        // Mark token as used if present
        if (token) {
            const tokenDoc = await SubmissionToken.findOne({ token });
            if (tokenDoc) {
                if (tokenDoc.used) {
                    return res.status(400).json({ success: false, error: 'This submission link has already been used' });
                }
                tokenDoc.used = true;
                tokenDoc.usedAt = new Date();
                await tokenDoc.save();
            }
        }

        const directive = await Directive.findById(req.params.id);
        if (!directive) {
            return res.status(404).json({ success: false, error: 'Directive not found' });
        }

        // Parse outcomes
        let outcomesUpdates = [];
        try {
            if (typeof req.body.outcomes === 'string') {
                outcomesUpdates = JSON.parse(req.body.outcomes);
            } else if (Array.isArray(req.body.outcomes)) {
                outcomesUpdates = req.body.outcomes;
            }
        } catch (parseError) {
            console.error('❌ Error parsing outcomes:', parseError.message);
            return res.status(400).json({ success: false, error: 'Invalid outcomes data' });
        }
        
        // Track changes for history
        let outcomeChanges = 0;
        
        // Update outcomes
        outcomesUpdates.forEach((update) => {
            const idx = update.originalIndex;
            if (directive.outcomes[idx]) {
                if (directive.outcomes[idx].status !== update.status) {
                    outcomeChanges++;
                }
                directive.outcomes[idx].status = update.status;
                directive.outcomes[idx].challenges = update.challenges;
                directive.outcomes[idx].completionDetails = update.completionDetails;
                directive.outcomes[idx].delayReason = update.delayReason;
            }
        });

        // Update timeline
        if (req.body.implementationStartDate) {
            directive.implementationStartDate = new Date(req.body.implementationStartDate);
        }
        if (req.body.implementationEndDate) {
            directive.implementationEndDate = new Date(req.body.implementationEndDate);
        }
        
        // Update comments
        let commentText = '';
        if (req.body.completionNote) {
            const timestamp = new Date().toLocaleString('en-GB', { 
                day: '2-digit', month: 'short', year: 'numeric',
                hour: '2-digit', minute: '2-digit'
            });
            commentText = req.body.completionNote.trim();
            const newComment = `[${timestamp}] ${commentText}`;
            
            if (directive.additionalComments && directive.additionalComments.trim()) {
                directive.additionalComments += '\n\n' + newComment;
            } else {
                directive.additionalComments = newComment;
            }
        }

        // Handle file uploads
        if (req.files && req.files.length > 0) {
            console.log(`📎 Processing ${req.files.length} uploaded files`);
            
            if (!directive.attachments) {
                directive.attachments = [];
            }
            
            req.files.forEach(file => {
                directive.attachments.push({
                    filename: file.filename,
                    originalName: file.originalname,
                    mimetype: file.mimetype,
                    size: file.size,
                    path: file.path,
                    uploadedAt: new Date(),
                    uploadedBy: directive.owner
                });
                
                console.log(`   ✅ Saved: ${file.originalname} (${(file.size / 1024).toFixed(2)} KB)`);
            });
        }

        // Add to update history - THIS IS NEW
        if (!directive.updateHistory) {
            directive.updateHistory = [];
        }
        directive.updateHistory.push({
            timestamp: new Date(),
            source: updateSource, // 'reminder-link' or 'self-initiated'
            updatedBy: directive.owner,
            outcomeChanges: outcomeChanges,
            comment: commentText
        });

        directive.lastSbuUpdate = new Date();
        directive.lastResponseDate = new Date();
        
        // Mark as responsive if they submitted an update
        if (directive.reminders >= 3) {
            directive.isResponsive = true; // They responded after being non-responsive
        }
        
        await directive.updateMonitoringStatus(`Update received (${updateSource})`);
        await directive.save();

        console.log(`✅ Directive ${directive.ref} updated successfully by ${directive.owner}`);
        console.log(`   Source: ${updateSource}`);
        console.log(`   Updated ${outcomesUpdates.length} outcomes (${outcomeChanges} changed)`);
        console.log(`   Uploaded ${req.files ? req.files.length : 0} files`);

        res.json({ 
            success: true, 
            message: 'Update submitted successfully',
            filesUploaded: req.files ? req.files.length : 0,
            updateSource: updateSource
        });
        
    } catch (error) {
        console.error('❌ Submission error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});





app.get('/api/directives/eligible-for-reminder', async (req, res) => {
    try {
        const { source } = req.query;
        
        const query = {};
        if (source) query.source = source;
        
        const directives = await Directive.find(query);
        
        // Filter to only include directives that need reminders
        const eligible = directives.filter(d => {
            // Exclude if already completed
            if (d.monitoringStatus === 'Completed') return false;
            
            // Exclude if already at 3 reminders (non-responsive)
            if (d.reminders >= 3) return false;
            
            // Exclude if updated in last 7 days (they're actively working on it)
            if (d.lastSbuUpdate) {
                const daysSinceUpdate = Math.ceil((new Date() - new Date(d.lastSbuUpdate)) / (1000 * 60 * 60 * 24));
                if (daysSinceUpdate < 7) return false;
            }
            
            // Include if no outcomes or has incomplete outcomes
            if (!d.outcomes || d.outcomes.length === 0) return true;
            const hasIncomplete = d.outcomes.some(o => o.status !== 'Completed');
            return hasIncomplete;
        });
        
        res.json({ 
            success: true, 
            data: eligible,
            total: eligible.length,
            message: `${eligible.length} directive(s) eligible for reminders`
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});







// DEBUG ENDPOINT - Add this temporarily
app.get('/api/debug-token/:token', async (req, res) => {
    try {
        const tokenDoc = await SubmissionToken.findOne({ token: req.params.token });
        
        if (!tokenDoc) {
            return res.json({
                success: false,
                message: 'Token not found in database',
                token: req.params.token
            });
        }
        
        const directive = await Directive.findById(tokenDoc.directiveId);
        
        res.json({
            success: true,
            token: req.params.token,
            directiveRef: directive?.ref,
            selectedOutcomes: tokenDoc.selectedOutcomes,
            totalOutcomes: directive?.outcomes.length,
            isUsed: tokenDoc.isUsed,
            createdAt: tokenDoc.createdAt
        });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});



app.post('/api/submit-update/:id', async (req, res) => {
  try {
    const token = req.query.token;
    const directive = await Directive.findById(req.params.id);
    
    if (!directive) {
      return res.status(404).json({ success: false, error: 'Directive not found' });
    }

    // Mark token as used if provided
    if (token) {
      await SubmissionToken.findOneAndUpdate(
        { token: token, directiveId: req.params.id },
        { used: true, usedAt: new Date() }
      );
    }

    const { outcomes, implementationStartDate, implementationEndDate, completionNote } = req.body;

    // Update only the submitted outcomes
    if (outcomes && outcomes.length > 0) {
      outcomes.forEach(submitted => {
        const idx = submitted.originalIndex;
        if (directive.outcomes[idx]) {
          directive.outcomes[idx].status = submitted.status;
          directive.outcomes[idx].challenges = submitted.challenges;
        }
      });
    }

    if (implementationStartDate) directive.implementationStartDate = new Date(implementationStartDate);
    if (implementationEndDate) directive.implementationEndDate = new Date(implementationEndDate);
    
    if (completionNote && completionNote.trim()) {
      const timestamp = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
      const newComment = `[${timestamp}] ${completionNote.trim()}`;
      directive.additionalComments = directive.additionalComments 
        ? `${directive.additionalComments}\n\n${newComment}` 
        : newComment;
    }

    directive.lastSbuUpdate = new Date();
    directive.isResponsive = true;

    await directive.save();

    res.json({ success: true, message: 'Update submitted successfully' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});






// ========================================
// PROCESS OWNER ACCOUNT MANAGEMENT - COMPLETE SYSTEM
// Add these to your server.js
// ========================================

// First, install bcrypt for password hashing
// Run: npm install bcrypt

const bcrypt = require('bcrypt');
const crypto = require('crypto');

// ========================================
// 1. PROCESS OWNER SCHEMA
// ========================================

const ProcessOwnerSchema = new mongoose.Schema({
  name: { 
    type: String, 
    required: true,
    trim: true
  },
  email: { 
    type: String, 
    required: true, 
    unique: true,
    lowercase: true,
    trim: true
  },
  password: { 
    type: String // Will be null until owner sets it
  },
  department: String,
  position: String,
  phone: String,
  
  // Account status
  isActive: { type: Boolean, default: true },
  passwordSetupToken: String, // For first-time password setup
  passwordSetupExpires: Date,
  passwordResetToken: String, // For password reset
  passwordResetExpires: Date,
  
  // Tracking
  createdBy: String, // Admin who created the account
  createdAt: { type: Date, default: Date.now },
  passwordSetAt: Date, // When they first set their password
  lastLogin: Date,
  
  // Security
  failedLoginAttempts: { type: Number, default: 0 },
  accountLockedUntil: Date
});

// Hash password before saving
ProcessOwnerSchema.pre('save', async function(next) {
  if (!this.isModified('password') || !this.password) return next();
  
  try {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (error) {
    next(error);
  }
});

// Method to compare passwords
ProcessOwnerSchema.methods.comparePassword = async function(candidatePassword) {
  if (!this.password) return false;
  return await bcrypt.compare(candidatePassword, this.password);
};

// Method to check if account is locked
ProcessOwnerSchema.methods.isLocked = function() {
  return !!(this.accountLockedUntil && this.accountLockedUntil > Date.now());
};

const ProcessOwner = mongoose.model('ProcessOwner', ProcessOwnerSchema);


// ========================================
// 2. ADMIN CREATES PROCESS OWNER ACCOUNT
// ========================================

app.post('/api/process-owners/create', async (req, res) => {
  try {
    const { name, email, department, position, phone } = req.body;
    
    // Validate
    if (!name || !email) {
      return res.status(400).json({ 
        success: false, 
        error: 'Name and email are required' 
      });
    }

    // Check if email already exists
    const existing = await ProcessOwner.findOne({ email: email.toLowerCase() });
    if (existing) {
      return res.status(400).json({ 
        success: false, 
        error: 'An account with this email already exists' 
      });
    }

    // Generate password setup token (valid for 7 days)
    const setupToken = crypto.randomBytes(32).toString('hex');
    const setupExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    // Create process owner account (NO PASSWORD YET)
    const processOwner = new ProcessOwner({
      name,
      email: email.toLowerCase(),
      department,
      position,
      phone,
      passwordSetupToken: setupToken,
      passwordSetupExpires: setupExpires,
      createdBy: req.body.adminUsername || 'admin', // Track who created it
      isActive: true
    });

    await processOwner.save();

    // Send setup email
    const baseUrl = process.env.BASE_URL || 'https://directives-new.onrender.com';
    const setupUrl = `${baseUrl}/setup-password.html?token=${setupToken}`;

    const emailHtml = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="font-family: Arial, sans-serif; background: #f5f5f5; margin: 0; padding: 20px;">
  <div style="max-width: 600px; margin: 0 auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
    
    <!-- Header -->
    <div style="padding: 32px 24px; background: linear-gradient(135deg, #1B5E20 0%, #2E7D32 100%); color: white; text-align: center;">
      <h1 style="margin: 0; font-size: 24px;">Welcome to CBN Directives Platform</h1>
      <p style="margin: 8px 0 0 0; opacity: 0.9; font-size: 14px;">Process Owner Portal Access</p>
    </div>
    
    <!-- Content -->
    <div style="padding: 32px 24px;">
      <p style="margin: 0 0 16px 0; font-size: 15px; color: #374151;">Dear <strong>${name}</strong>,</p>
      
      <p style="margin: 0 0 16px 0; font-size: 14px; color: #374151; line-height: 1.6;">
        An account has been created for you on the <strong>CBN Directives Management Platform</strong>. 
        You can now track and submit updates for all directives assigned to you.
      </p>
      
      <div style="background: #f9fafb; padding: 16px; border-radius: 8px; margin: 24px 0; border-left: 4px solid #1B5E20;">
        <div style="font-size: 12px; color: #6b7280; margin-bottom: 8px;">YOUR LOGIN EMAIL</div>
        <div style="font-size: 16px; font-weight: 600; color: #1B5E20;">${email}</div>
      </div>
      
      <p style="margin: 0 0 24px 0; font-size: 14px; color: #374151;">
        To activate your account, please set up your password by clicking the button below:
      </p>
      
      <!-- CTA Button -->
      <div style="text-align: center; margin: 32px 0;">
        <a href="${setupUrl}" style="display: inline-block; background: linear-gradient(135deg, #1B5E20 0%, #2E7D32 100%); color: white; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: 700; font-size: 14px; box-shadow: 0 4px 12px rgba(27, 94, 32, 0.3);">
          🔐 Set Up Your Password
        </a>
      </div>
      
      <p style="margin: 24px 0 8px 0; font-size: 12px; color: #6b7280;">
        Or copy and paste this link into your browser:
      </p>
      <p style="margin: 0; font-size: 11px; color: #9ca3af; word-break: break-all;">
        ${setupUrl}
      </p>
      
      <div style="background: #FEF3C7; padding: 12px; border-radius: 8px; margin: 24px 0;">
        <div style="font-size: 12px; color: #92400E;">
          ⏰ <strong>Important:</strong> This setup link expires in 7 days. Please set up your password as soon as possible.
        </div>
      </div>
      
      <p style="margin: 24px 0 0 0; font-size: 14px; color: #374151; line-height: 1.6;">
        Once your password is set, you can log in at any time to:
      </p>
      <ul style="margin: 12px 0; padding-left: 20px; font-size: 14px; color: #374151;">
        <li style="margin-bottom: 8px;">View all directives assigned to you</li>
        <li style="margin-bottom: 8px;">Submit implementation updates</li>
        <li style="margin-bottom: 8px;">Track progress and timelines</li>
        <li style="margin-bottom: 8px;">Upload supporting documents</li>
      </ul>
    </div>
    
    <!-- Footer -->
    <div style="padding: 20px 24px; background: #f9fafb; border-top: 1px solid #e5e7eb; text-align: center;">
      <p style="margin: 0 0 4px 0; font-size: 11px; color: #6b7280;">
        If you did not expect this email or need assistance, please contact the Corporate Secretariat.
      </p>
      <p style="margin: 0; font-size: 10px; color: #9ca3af;">
        Central Bank of Nigeria - Directives Management System
      </p>
    </div>
  </div>
</body>
</html>
    `;

    if (emailTransporter) {
      try {
        await emailTransporter.sendMail({
          from: process.env.SMTP_USER || 'directives@cbn.gov.ng',
          to: email,
          subject: '🔐 Set Up Your CBN Directives Platform Password',
          html: emailHtml
        });
        
        console.log(`✅ Password setup email sent to: ${email}`);
      } catch (emailError) {
        console.error('❌ Email send failed:', emailError.message);
        // Don't fail account creation if email fails
      }
    }

    res.json({
      success: true,
      message: 'Process owner account created successfully',
      processOwner: {
        id: processOwner._id,
        name: processOwner.name,
        email: processOwner.email,
        setupEmailSent: !!emailTransporter
      },
      setupUrl: setupUrl // Return URL for admin to copy manually if needed
    });

  } catch (error) {
    console.error('❌ Create process owner error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});


// ========================================
// 3. VALIDATE PASSWORD SETUP TOKEN
// ========================================

app.get('/api/process-owners/validate-setup-token/:token', async (req, res) => {
  try {
    const { token } = req.params;
    
    const processOwner = await ProcessOwner.findOne({
      passwordSetupToken: token,
      passwordSetupExpires: { $gt: Date.now() }
    });

    if (!processOwner) {
      return res.status(400).json({
        success: false,
        error: 'Invalid or expired setup link. Please contact the Corporate Secretariat to request a new one.'
      });
    }

    res.json({
      success: true,
      processOwner: {
        name: processOwner.name,
        email: processOwner.email
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});


// ========================================
// 4. PROCESS OWNER SETS PASSWORD
// ========================================

app.post('/api/process-owners/setup-password', async (req, res) => {
  try {
    const { token, password, confirmPassword } = req.body;

    // Validate
    if (!token || !password || !confirmPassword) {
      return res.status(400).json({
        success: false,
        error: 'All fields are required'
      });
    }

    if (password !== confirmPassword) {
      return res.status(400).json({
        success: false,
        error: 'Passwords do not match'
      });
    }

    // Password strength check
    if (password.length < 8) {
      return res.status(400).json({
        success: false,
        error: 'Password must be at least 8 characters long'
      });
    }

    // Find process owner
    const processOwner = await ProcessOwner.findOne({
      passwordSetupToken: token,
      passwordSetupExpires: { $gt: Date.now() }
    });

    if (!processOwner) {
      return res.status(400).json({
        success: false,
        error: 'Invalid or expired setup link'
      });
    }

    // Set password (will be hashed by pre-save hook)
    processOwner.password = password;
    processOwner.passwordSetAt = new Date();
    processOwner.passwordSetupToken = undefined;
    processOwner.passwordSetupExpires = undefined;
    
    await processOwner.save();

    console.log(`✅ Password set for process owner: ${processOwner.email}`);

    res.json({
      success: true,
      message: 'Password set successfully! You can now log in.',
      email: processOwner.email
    });

  } catch (error) {
    console.error('❌ Setup password error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});


// ========================================
// 5. PROCESS OWNER LOGIN (UPDATED)
// ========================================

app.post('/api/process-owners/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        error: 'Email and password are required'
      });
    }

    // Find process owner
    const processOwner = await ProcessOwner.findOne({ 
      email: email.toLowerCase() 
    });

    if (!processOwner) {
      return res.status(401).json({
        success: false,
        error: 'Invalid email or password'
      });
    }

    // Check if account is active
    if (!processOwner.isActive) {
      return res.status(403).json({
        success: false,
        error: 'Your account has been deactivated. Please contact the Corporate Secretariat.'
      });
    }

    // Check if password is set
    if (!processOwner.password) {
      return res.status(403).json({
        success: false,
        error: 'Please set up your password first. Check your email for the setup link.',
        needsPasswordSetup: true
      });
    }

    // Check if account is locked
    if (processOwner.isLocked()) {
      const minutesRemaining = Math.ceil((processOwner.accountLockedUntil - Date.now()) / (1000 * 60));
      return res.status(423).json({
        success: false,
        error: `Account locked due to too many failed login attempts. Try again in ${minutesRemaining} minutes.`
      });
    }

    // Verify password
    const isMatch = await processOwner.comparePassword(password);

    if (!isMatch) {
      // Increment failed attempts
      processOwner.failedLoginAttempts += 1;
      
      // Lock account after 5 failed attempts
      if (processOwner.failedLoginAttempts >= 5) {
        processOwner.accountLockedUntil = new Date(Date.now() + 30 * 60 * 1000); // Lock for 30 minutes
        await processOwner.save();
        
        return res.status(423).json({
          success: false,
          error: 'Account locked due to too many failed login attempts. Try again in 30 minutes.'
        });
      }
      
      await processOwner.save();
      
      return res.status(401).json({
        success: false,
        error: `Invalid email or password. ${5 - processOwner.failedLoginAttempts} attempts remaining.`
      });
    }

    // Successful login - reset failed attempts
    processOwner.failedLoginAttempts = 0;
    processOwner.accountLockedUntil = undefined;
    processOwner.lastLogin = new Date();
    await processOwner.save();

    console.log(`✅ Process owner logged in: ${processOwner.email}`);

    // Generate session token (you could use JWT here)
    const sessionToken = crypto.randomBytes(32).toString('hex');

    res.json({
      success: true,
      message: 'Login successful',
      owner: {
        id: processOwner._id,
        name: processOwner.name,
        email: processOwner.email,
        department: processOwner.department,
        position: processOwner.position
      },
      token: sessionToken
    });

  } catch (error) {
    console.error('❌ Login error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});


// ========================================
// 6. REQUEST PASSWORD RESET
// ========================================

app.post('/api/process-owners/request-password-reset', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        error: 'Email is required'
      });
    }

    const processOwner = await ProcessOwner.findOne({ 
      email: email.toLowerCase() 
    });

    // Always return success to prevent email enumeration
    if (!processOwner) {
      return res.json({
        success: true,
        message: 'If an account exists with this email, you will receive password reset instructions.'
      });
    }

    // Generate reset token (valid for 1 hour)
    const resetToken = crypto.randomBytes(32).toString('hex');
    processOwner.passwordResetToken = resetToken;
    processOwner.passwordResetExpires = new Date(Date.now() + 60 * 60 * 1000);
    await processOwner.save();

    // Send reset email
    const baseUrl = process.env.BASE_URL || 'https://directives-new.onrender.com';
    const resetUrl = `${baseUrl}/reset-password.html?token=${resetToken}`;

    const emailHtml = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="font-family: Arial, sans-serif; background: #f5f5f5; margin: 0; padding: 20px;">
  <div style="max-width: 600px; margin: 0 auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
    <div style="padding: 32px 24px; background: linear-gradient(135deg, #1B5E20 0%, #2E7D32 100%); color: white; text-align: center;">
      <h1 style="margin: 0; font-size: 24px;">Password Reset Request</h1>
    </div>
    
    <div style="padding: 32px 24px;">
      <p style="margin: 0 0 16px 0; font-size: 15px; color: #374151;">Dear <strong>${processOwner.name}</strong>,</p>
      
      <p style="margin: 0 0 24px 0; font-size: 14px; color: #374151; line-height: 1.6;">
        We received a request to reset your password for the CBN Directives Platform. Click the button below to set a new password:
      </p>
      
      <div style="text-align: center; margin: 32px 0;">
        <a href="${resetUrl}" style="display: inline-block; background: linear-gradient(135deg, #1B5E20 0%, #2E7D32 100%); color: white; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: 700; font-size: 14px;">
          🔐 Reset Password
        </a>
      </div>
      
      <div style="background: #FEF3C7; padding: 12px; border-radius: 8px; margin: 24px 0;">
        <div style="font-size: 12px; color: #92400E;">
          ⏰ This reset link expires in 1 hour.
        </div>
      </div>
      
      <p style="margin: 24px 0 0 0; font-size: 13px; color: #6b7280;">
        If you didn't request this reset, you can safely ignore this email. Your password will remain unchanged.
      </p>
    </div>
    
    <div style="padding: 20px 24px; background: #f9fafb; border-top: 1px solid #e5e7eb; text-align: center;">
      <p style="margin: 0; font-size: 11px; color: #6b7280;">Central Bank of Nigeria - Directives Management System</p>
    </div>
  </div>
</body>
</html>
    `;

    if (emailTransporter) {
      await emailTransporter.sendMail({
        from: process.env.SMTP_USER || 'directives@cbn.gov.ng',
        to: email,
        subject: '🔐 Password Reset Request - CBN Directives Platform',
        html: emailHtml
      });
    }

    res.json({
      success: true,
      message: 'If an account exists with this email, you will receive password reset instructions.'
    });

  } catch (error) {
    console.error('❌ Password reset request error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});


// ========================================
// 7. RESET PASSWORD
// ========================================

app.post('/api/process-owners/reset-password', async (req, res) => {
  try {
    const { token, password, confirmPassword } = req.body;

    if (!token || !password || !confirmPassword) {
      return res.status(400).json({
        success: false,
        error: 'All fields are required'
      });
    }

    if (password !== confirmPassword) {
      return res.status(400).json({
        success: false,
        error: 'Passwords do not match'
      });
    }

    if (password.length < 8) {
      return res.status(400).json({
        success: false,
        error: 'Password must be at least 8 characters long'
      });
    }

    const processOwner = await ProcessOwner.findOne({
      passwordResetToken: token,
      passwordResetExpires: { $gt: Date.now() }
    });

    if (!processOwner) {
      return res.status(400).json({
        success: false,
        error: 'Invalid or expired reset link'
      });
    }

    // Set new password
    processOwner.password = password;
    processOwner.passwordResetToken = undefined;
    processOwner.passwordResetExpires = undefined;
    processOwner.failedLoginAttempts = 0;
    processOwner.accountLockedUntil = undefined;
    
    await processOwner.save();

    console.log(`✅ Password reset for: ${processOwner.email}`);

    res.json({
      success: true,
      message: 'Password reset successfully! You can now log in with your new password.'
    });

  } catch (error) {
    console.error('❌ Reset password error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});


// ========================================
// 8. LIST ALL PROCESS OWNERS (ADMIN ONLY)
// ========================================

app.get('/api/process-owners', async (req, res) => {
  try {
    const processOwners = await ProcessOwner.find()
      .select('-password -passwordSetupToken -passwordResetToken')
      .sort({ name: 1 });

    res.json({
      success: true,
      data: processOwners,
      total: processOwners.length
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});




// ========================================
// RESEND SETUP EMAIL (ADMIN ONLY)
// Complete implementation
// ========================================

app.post('/api/process-owners/:id/resend-setup', async (req, res) => {
  try {
    const processOwner = await ProcessOwner.findById(req.params.id);
    
    if (!processOwner) {
      return res.status(404).json({
        success: false,
        error: 'Process owner not found'
      });
    }

    // Check if password already set
    if (processOwner.password) {
      return res.status(400).json({
        success: false,
        error: 'Password already set. This account is active. Use password reset instead.'
      });
    }

    // Check if account is active
    if (!processOwner.isActive) {
      return res.status(400).json({
        success: false,
        error: 'Account is deactivated. Please activate it first.'
      });
    }

    // Generate new setup token (valid for 7 days)
    const setupToken = crypto.randomBytes(32).toString('hex');
    processOwner.passwordSetupToken = setupToken;
    processOwner.passwordSetupExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await processOwner.save();

    const baseUrl = process.env.BASE_URL || 'https://directives-new.onrender.com';
    const setupUrl = `${baseUrl}/setup-password.html?token=${setupToken}`;

    // Build setup email HTML
    const emailHtml = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="font-family: Arial, sans-serif; background: #f5f5f5; margin: 0; padding: 20px;">
  <div style="max-width: 600px; margin: 0 auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
    
    <!-- Header -->
    <div style="padding: 32px 24px; background: linear-gradient(135deg, #1B5E20 0%, #2E7D32 100%); color: white; text-align: center;">
      <h1 style="margin: 0; font-size: 24px;">Welcome to CBN Directives Platform</h1>
      <p style="margin: 8px 0 0 0; opacity: 0.9; font-size: 14px;">Process Owner Portal Access</p>
    </div>
    
    <!-- Content -->
    <div style="padding: 32px 24px;">
      <p style="margin: 0 0 16px 0; font-size: 15px; color: #374151;">Dear <strong>${processOwner.name}</strong>,</p>
      
      <p style="margin: 0 0 16px 0; font-size: 14px; color: #374151; line-height: 1.6;">
        This is a reminder to complete your account setup for the <strong>CBN Directives Management Platform</strong>. 
        You can track and submit updates for all directives assigned to you.
      </p>
      
      <div style="background: #f9fafb; padding: 16px; border-radius: 8px; margin: 24px 0; border-left: 4px solid #1B5E20;">
        <div style="font-size: 12px; color: #6b7280; margin-bottom: 8px;">YOUR LOGIN EMAIL</div>
        <div style="font-size: 16px; font-weight: 600; color: #1B5E20;">${processOwner.email}</div>
      </div>
      
      <p style="margin: 0 0 24px 0; font-size: 14px; color: #374151;">
        To activate your account, please set up your password by clicking the button below:
      </p>
      
      <!-- CTA Button -->
      <div style="text-align: center; margin: 32px 0;">
        <a href="${setupUrl}" style="display: inline-block; background: linear-gradient(135deg, #1B5E20 0%, #2E7D32 100%); color: white; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: 700; font-size: 14px; box-shadow: 0 4px 12px rgba(27, 94, 32, 0.3);">
          🔐 Set Up Your Password
        </a>
      </div>
      
      <p style="margin: 24px 0 8px 0; font-size: 12px; color: #6b7280;">
        Or copy and paste this link into your browser:
      </p>
      <p style="margin: 0; font-size: 11px; color: #9ca3af; word-break: break-all; background: #f9fafb; padding: 12px; border-radius: 6px;">
        ${setupUrl}
      </p>
      
      <div style="background: #FEF3C7; padding: 12px; border-radius: 8px; margin: 24px 0;">
        <div style="font-size: 12px; color: #92400E;">
          ⏰ <strong>Important:</strong> This setup link expires in 7 days. Please set up your password as soon as possible.
        </div>
      </div>
      
      <p style="margin: 24px 0 0 0; font-size: 14px; color: #374151; line-height: 1.6;">
        Once your password is set, you can log in at any time to:
      </p>
      <ul style="margin: 12px 0; padding-left: 20px; font-size: 14px; color: #374151;">
        <li style="margin-bottom: 8px;">View all directives assigned to you</li>
        <li style="margin-bottom: 8px;">Submit implementation updates</li>
        <li style="margin-bottom: 8px;">Track progress and timelines</li>
        <li style="margin-bottom: 8px;">Upload supporting documents</li>
      </ul>
    </div>
    
    <!-- Footer -->
    <div style="padding: 20px 24px; background: #f9fafb; border-top: 1px solid #e5e7eb; text-align: center;">
      <p style="margin: 0 0 4px 0; font-size: 11px; color: #6b7280;">
        If you did not expect this email or need assistance, please contact the Corporate Secretariat.
      </p>
      <p style="margin: 0; font-size: 10px; color: #9ca3af;">
        Central Bank of Nigeria - Directives Management System
      </p>
    </div>
  </div>
</body>
</html>
    `;

    // Send email
    if (emailTransporter) {
      try {
        await emailTransporter.sendMail({
          from: process.env.SMTP_USER || 'directives@cbn.gov.ng',
          to: processOwner.email,
          subject: '🔐 Reminder: Set Up Your CBN Directives Platform Password',
          html: emailHtml
        });
        
        console.log(`✅ Setup email resent to: ${processOwner.email}`);
      } catch (emailError) {
        console.error('❌ Email send failed:', emailError.message);
        return res.status(500).json({ 
          success: false, 
          error: `Failed to send email: ${emailError.message}`,
          setupUrl: setupUrl // Still return URL so admin can send manually
        });
      }
    } else {
      return res.status(500).json({
        success: false,
        error: 'Email service not configured',
        setupUrl: setupUrl // Return URL for manual sharing
      });
    }

    res.json({
      success: true,
      message: 'Setup email resent successfully',
      processOwner: {
        id: processOwner._id,
        name: processOwner.name,
        email: processOwner.email
      },
      setupUrl: setupUrl, // Return URL for admin reference
      expiresIn: '7 days'
    });

  } catch (error) {
    console.error('❌ Resend setup error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});


// ========================================
// BONUS: GET PROCESS OWNER DETAILS (ADMIN ONLY)
// Useful to check account status before resending
// ========================================

app.get('/api/process-owners/:id', async (req, res) => {
  try {
    const processOwner = await ProcessOwner.findById(req.params.id)
      .select('-password -passwordSetupToken -passwordResetToken'); // Don't expose sensitive data

    if (!processOwner) {
      return res.status(404).json({
        success: false,
        error: 'Process owner not found'
      });
    }

    // Calculate status
    const status = {
      hasPassword: !!processOwner.password,
      isActive: processOwner.isActive,
      setupTokenExpired: processOwner.passwordSetupExpires && new Date() > processOwner.passwordSetupExpires,
      accountLocked: processOwner.isLocked(),
      needsPasswordSetup: !processOwner.password && processOwner.isActive
    };

    res.json({
      success: true,
      data: processOwner,
      status: status
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});


// ========================================
// BONUS: DEACTIVATE/REACTIVATE PROCESS OWNER (ADMIN ONLY)
// ========================================

app.patch('/api/process-owners/:id/toggle-active', async (req, res) => {
  try {
    const processOwner = await ProcessOwner.findById(req.params.id);
    
    if (!processOwner) {
      return res.status(404).json({
        success: false,
        error: 'Process owner not found'
      });
    }

    // Toggle active status
    processOwner.isActive = !processOwner.isActive;
    await processOwner.save();

    console.log(`✅ Process owner ${processOwner.email} ${processOwner.isActive ? 'activated' : 'deactivated'}`);

    res.json({
      success: true,
      message: `Account ${processOwner.isActive ? 'activated' : 'deactivated'} successfully`,
      processOwner: {
        id: processOwner._id,
        name: processOwner.name,
        email: processOwner.email,
        isActive: processOwner.isActive
      }
    });
  } catch (error) {
    console.error('❌ Toggle active error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});


// ========================================
// BONUS: DELETE PROCESS OWNER (ADMIN ONLY)
// Use with caution - this is permanent
// ========================================

app.delete('/api/process-owners/:id', async (req, res) => {
  try {
    const processOwner = await ProcessOwner.findById(req.params.id);
    
    if (!processOwner) {
      return res.status(404).json({
        success: false,
        error: 'Process owner not found'
      });
    }

    // Store details before deletion for logging
    const deletedDetails = {
      name: processOwner.name,
      email: processOwner.email,
      deletedAt: new Date(),
      deletedBy: req.body.adminUsername || 'admin'
    };

    await ProcessOwner.findByIdAndDelete(req.params.id);

    console.log(`⚠️  Process owner deleted: ${deletedDetails.email} by ${deletedDetails.deletedBy}`);

    res.json({
      success: true,
      message: 'Process owner account deleted successfully',
      deleted: deletedDetails
    });
  } catch (error) {
    console.error('❌ Delete error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});


// ========================================
// BONUS: UPDATE PROCESS OWNER DETAILS (ADMIN ONLY)
// ========================================

app.patch('/api/process-owners/:id', async (req, res) => {
  try {
    const { name, email, department, position, phone } = req.body;
    
    const processOwner = await ProcessOwner.findById(req.params.id);
    
    if (!processOwner) {
      return res.status(404).json({
        success: false,
        error: 'Process owner not found'
      });
    }

    // Check if new email is already taken by another process owner
    if (email && email !== processOwner.email) {
      const existing = await ProcessOwner.findOne({ 
        email: email.toLowerCase(),
        _id: { $ne: req.params.id }
      });
      
      if (existing) {
        return res.status(400).json({
          success: false,
          error: 'Email already in use by another process owner'
        });
      }
    }

    // Update fields if provided
    if (name) processOwner.name = name;
    if (email) processOwner.email = email.toLowerCase();
    if (department !== undefined) processOwner.department = department;
    if (position !== undefined) processOwner.position = position;
    if (phone !== undefined) processOwner.phone = phone;

    await processOwner.save();

    console.log(`✅ Process owner updated: ${processOwner.email}`);

    res.json({
      success: true,
      message: 'Process owner updated successfully',
      processOwner: {
        id: processOwner._id,
        name: processOwner.name,
        email: processOwner.email,
        department: processOwner.department,
        position: processOwner.position,
        phone: processOwner.phone
      }
    });
  } catch (error) {
    console.error('❌ Update error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});
