// MongoDB Schema for CBN Directives Platform
// File: models/Directive.js

const mongoose = require('mongoose');

const outcomeSchema = new mongoose.Schema({
  text: { type: String, required: true },
  status: { 
    type: String, 
    enum: ['Not Started', 'Being Implemented', 'Delayed', 'Completed'],
    default: 'Not Started'
  },
  completionDetails: String,
  delayReason: String,
  challenges: String
});

const directiveSchema = new mongoose.Schema({
  // From Google Sheet columns
  source: { 
    type: String, 
    required: true,
    enum: ['CG', 'Board'] // Derived from sheet tab name
  },
  meetingDate: { type: Date, required: true }, // "DATE" column
  subject: { type: String, required: true }, // "SUBJECT MATTER OF APPROVAL"
  particulars: { type: String, required: true }, // "PARTICULARS"
  owner: { type: String, required: true }, // "PROCESS OWNERS"
  amount: String, // "AMOUNT"
  vendor: String, // "VENDOR"
  timeline: { type: Date, required: true }, // "IMPLEMENTATION DEADLINE"
  implementationStatus: { 
    type: String,
    default: 'Not Started'
  }, // "IMPLEMENTATION STATUS"
  
  // Generated fields
  ref: { type: String, unique: true, required: true }, // Auto-generated
  monitoringStatus: {
    type: String,
    enum: [
      'Awaiting Next Reminder',
      'At Risk',
      'High Risk',
      'Non-Responsive',
      'Completed'
    ],
    default: 'Awaiting Next Reminder'
  },
  reminders: { type: Number, default: 0 },
  lastReminderDate: Date,
  completionNote: String,
  
  // Outcomes (parsed from particulars or manually added)
  outcomes: [outcomeSchema],
  
  // Audit fields
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
  createdBy: String,
  updatedBy: String
});

// Auto-generate reference number before saving
directiveSchema.pre('save', function(next) {
  if (!this.ref) {
    const prefix = this.source === 'CG' ? 'CG' : 'BD';
    const month = this.meetingDate.toLocaleString('en-US', { month: 'short' }).toUpperCase();
    const year = this.meetingDate.getFullYear();
    const random = Math.floor(Math.random() * 900) + 100;
    this.ref = `${prefix}/${month}/${random}`;
  }
  this.updatedAt = Date.now();
  next();
});

// Method to calculate monitoring status based on reminders and dates
directiveSchema.methods.updateMonitoringStatus = function() {
  if (this.implementationStatus === 'Completed') {
    this.monitoringStatus = 'Completed';
  } else {
    const today = new Date();
    const daysUntilDeadline = Math.ceil((this.timeline - today) / (1000 * 60 * 60 * 24));
    
    if (this.reminders >= 3) {
      this.monitoringStatus = 'Non-Responsive';
    } else if (daysUntilDeadline < 0) {
      this.monitoringStatus = 'High Risk';
    } else if (daysUntilDeadline <= 30 || this.reminders >= 1) {
      this.monitoringStatus = 'At Risk';
    } else {
      this.monitoringStatus = 'Awaiting Next Reminder';
    }
  }
  return this.save();
};

module.exports = mongoose.model('Directive', directiveSchema);