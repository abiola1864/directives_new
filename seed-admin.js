// ============================================================
// seed-admin.js — Run ONCE to create your first Super Admin
// ============================================================
// Usage:  node seed-admin.js
// ============================================================

'use strict';
require('dotenv').config();

const mongoose = require('mongoose');
const bcrypt   = require('bcrypt');
const readline = require('readline');

// ── Minimal AdminUser model (copy from server.js) ─────────────
const AdminUserSchema = new mongoose.Schema({
  name:                 { type: String, required: true, trim: true },
  email:                { type: String, required: true, unique: true, lowercase: true, trim: true },
  password:             String,
  role:                 { type: String, enum: ['super_admin', 'admin', 'viewer'], default: 'super_admin' },
  isActive:             { type: Boolean, default: true },
  passwordSetupToken:   String,
  passwordSetupExpires: Date,
  passwordResetToken:   String,
  passwordResetExpires: Date,
  createdBy:            { type: String, default: 'seed-script' },
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

const AdminUser = mongoose.model('AdminUser', AdminUserSchema);

// ── Prompt helper ──────────────────────────────────────────────
function prompt(question, hidden = false) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    if (hidden) {
      process.stdout.write(question);
      process.stdin.setRawMode?.(true);
      let chars = '';
      process.stdin.on('data', function handler(ch) {
        ch = ch.toString();
        if (ch === '\n' || ch === '\r' || ch === '\u0004') {
          process.stdin.setRawMode?.(false);
          process.stdin.removeListener('data', handler);
          process.stdout.write('\n');
          rl.close();
          resolve(chars);
        } else if (ch === '\u0003') {
          process.exit();
        } else if (ch === '\u007f') {
          chars = chars.slice(0, -1);
        } else {
          chars += ch;
          process.stdout.write('*');
        }
      });
    } else {
      rl.question(question, answer => { rl.close(); resolve(answer.trim()); });
    }
  });
}

async function main() {
  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  CBN Directives Platform — Super Admin Setup Script   ');
  console.log('═══════════════════════════════════════════════════════\n');

  // Connect
  const uri = process.env.MONGODB_URI;
  if (!uri) { console.error('❌  MONGODB_URI not set in .env'); process.exit(1); }

  try {
    await mongoose.connect(uri, { useNewUrlParser: true, useUnifiedTopology: true });
    console.log('✅  MongoDB connected\n');
  } catch (e) {
    console.error('❌  MongoDB connection failed:', e.message);
    process.exit(1);
  }

  // Check if any super_admin already exists
  const existing = await AdminUser.findOne({ role: 'super_admin' });
  if (existing) {
    console.log(`ℹ️   A Super Admin already exists: ${existing.email} (${existing.isActive ? 'active' : 'inactive'})`);
    const cont = await prompt('Create another admin anyway? (y/N): ');
    if (cont.toLowerCase() !== 'y') {
      console.log('\n👋  Exiting — no changes made.\n');
      await mongoose.disconnect();
      process.exit(0);
    }
  }

  // Collect details
  console.log('Please enter the details for the new Super Admin:\n');
  const name  = await prompt('Full Name:  ');
  const email = await prompt('Email:      ');

  if (!name || !email) {
    console.error('\n❌  Name and email are required.');
    await mongoose.disconnect();
    process.exit(1);
  }

  // Check duplicate
  const dup = await AdminUser.findOne({ email: email.toLowerCase() });
  if (dup) {
    console.error(`\n❌  An admin with email "${email}" already exists (role: ${dup.role}).`);
    await mongoose.disconnect();
    process.exit(1);
  }

  const password = await prompt('Password (min 8 chars): ', true);
  const confirm  = await prompt('Confirm Password:       ', true);

  if (!password || password.length < 8) {
    console.error('\n❌  Password must be at least 8 characters.');
    await mongoose.disconnect();
    process.exit(1);
  }
  if (password !== confirm) {
    console.error('\n❌  Passwords do not match.');
    await mongoose.disconnect();
    process.exit(1);
  }

  // Role selection
  console.log('\nSelect role:');
  console.log('  1 → super_admin  (manage other admins + full access)');
  console.log('  2 → admin        (full access, cannot manage admins)');
  console.log('  3 → viewer       (read-only)');
  const roleChoice = await prompt('Role [1/2/3, default 1]: ');
  const roleMap    = { '1': 'super_admin', '2': 'admin', '3': 'viewer' };
  const role       = roleMap[roleChoice] || 'super_admin';

  // Create
  console.log(`\n⏳  Creating ${role} account for ${name} <${email}>...`);
  try {
    const admin = new AdminUser({ name, email, password, role, passwordSetAt: new Date() });
    await admin.save();

    console.log('\n╔══════════════════════════════════════════════════════╗');
    console.log('║          ✅  Admin Account Created Successfully       ║');
    console.log('╠══════════════════════════════════════════════════════╣');
    console.log(`║  Name:   ${name.padEnd(43)}║`);
    console.log(`║  Email:  ${email.padEnd(43)}║`);
    console.log(`║  Role:   ${role.padEnd(43)}║`);
    console.log('╚══════════════════════════════════════════════════════╝');
    console.log('\n👉  You can now log in at /login.html with these credentials.');
    console.log('    A 2FA code will be sent to the email address on login.\n');
  } catch (e) {
    console.error('\n❌  Failed to create admin:', e.message);
  }

  await mongoose.disconnect();
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });