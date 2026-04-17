'use strict';
// server-patch-notifications.js
// Adds a proper per-admin notification system backed by MongoDB.
// Notifications are created when:
//   - A business unit submits an update via the submission link
//   - A directive is archived or unarchived
// Each admin has their own read/unread state stored in the DB.
//
// Run: node server-patch-notifications.js

var fs   = require('fs');
var path = require('path');

var FILE    = path.join(__dirname, 'server.js');
var BACKUP  = path.join(__dirname, 'server.js.notif.bak');
var LOGFILE = path.join(__dirname, 'server-patch-notif.log');

var log = [];
function out(msg) { console.log(msg); log.push(msg); }

if (!fs.existsSync(FILE)) {
  out('ERROR: server.js not found');
  process.exit(1);
}

var code = fs.readFileSync(FILE, 'utf8');
out('server.js: ' + code.length + ' chars');
fs.writeFileSync(BACKUP, code);
out('Backup -> server.js.notif.bak');

var applied = 0;
var skipped = 0;

function patch(label, find, replace) {
  if (code.indexOf(find) === -1) {
    out('  SKIP [' + label + ']');
    skipped++;
    return;
  }
  code = code.replace(find, replace);
  out('  DONE [' + label + ']');
  applied++;
}

// ── 1. Add Notification schema after the ReminderSettings model ──────────────
patch(
  '1 - Notification schema',
  "// ─── Process Owner ────────────────────────────────────────────",

  "// ─── Notification ────────────────────────────────────────────\n" +
  "const NotificationSchema = new mongoose.Schema({\n" +
  "  type:             { type: String, default: 'update' }, // update | archive | unarchive\n" +
  "  directiveId:      { type: mongoose.Schema.Types.ObjectId, ref: 'Directive' },\n" +
  "  directiveRef:     { type: String, default: '' },\n" +
  "  directiveSubject: { type: String, default: '' },\n" +
  "  businessUnit:     { type: String, default: '' },\n" +
  "  message:          { type: String, default: '' },\n" +
  "  decisionChanges:  { type: Number, default: 0 },\n" +
  "  submittedBy:      { type: String, default: '' },\n" +
  "  createdAt:        { type: Date, default: Date.now },\n" +
  "  readBy:           [{ adminId: String, readAt: { type: Date, default: Date.now } }]\n" +
  "});\n" +
  "const Notification = mongoose.model('Notification', NotificationSchema);\n\n" +
  "// Helper: create a notification for all admins\n" +
  "async function createNotification(data) {\n" +
  "  try {\n" +
  "    await new Notification(data).save();\n" +
  "  } catch (e) {\n" +
  "    console.error('Notification create error:', e.message);\n" +
  "  }\n" +
  "}\n\n" +
  "// ─── Process Owner ────────────────────────────────────────────"
);

// ── 2. Create notification when business unit submits update ──────────────────
patch(
  '2 - notify on submission',
  "    directive.lastSbuUpdate = directive.lastResponseDate = new Date();\n    await directive.updateMonitoringStatus('Update received via submission link');\n    console.log(",

  "    directive.lastSbuUpdate = directive.lastResponseDate = new Date();\n" +
  "    await directive.updateMonitoringStatus('Update received via submission link');\n" +
  "    // Create notification for all admins\n" +
  "    await createNotification({\n" +
  "      type:             'update',\n" +
  "      directiveId:      directive._id,\n" +
  "      directiveRef:     directive.ref || '',\n" +
  "      directiveSubject: directive.subject || '',\n" +
  "      businessUnit:     directive.owner || '',\n" +
  "      message:          (directive.owner || 'Business unit') + ' submitted an update',\n" +
  "      decisionChanges:  changed,\n" +
  "      submittedBy:      directive.owner || ''\n" +
  "    });\n" +
  "    console.log("
);

// ── 3. Create notification when directive is archived ─────────────────────────
patch(
  '3 - notify on archive',
  "    d.isArchived   = true;\n    d.archivedAt   = new Date();\n    d.archivedNote = req.body.note || '';\n    await d.save();\n    res.json({ success: true, message: 'Directive archived', data: d });",

  "    d.isArchived   = true;\n    d.archivedAt   = new Date();\n    d.archivedNote = req.body.note || '';\n    await d.save();\n" +
  "    await createNotification({\n" +
  "      type: 'archive', directiveId: d._id, directiveRef: d.ref || '',\n" +
  "      directiveSubject: d.subject || '', businessUnit: d.owner || '',\n" +
  "      message: 'Directive archived' + (req.body.note ? ': ' + req.body.note : '')\n" +
  "    });\n" +
  "    res.json({ success: true, message: 'Directive archived', data: d });"
);

// ── 4. Create notification when directive is unarchived ───────────────────────
patch(
  '4 - notify on unarchive',
  "    d.isArchived   = false;\n    d.archivedAt   = undefined;\n    d.archivedNote = '';\n    await d.save();\n    res.json({ success: true, message: 'Directive restored', data: d });",

  "    d.isArchived   = false;\n    d.archivedAt   = undefined;\n    d.archivedNote = '';\n    await d.save();\n" +
  "    await createNotification({\n" +
  "      type: 'unarchive', directiveId: d._id, directiveRef: d.ref || '',\n" +
  "      directiveSubject: d.subject || '', businessUnit: d.owner || '',\n" +
  "      message: 'Directive restored from archive'\n" +
  "    });\n" +
  "    res.json({ success: true, message: 'Directive restored', data: d });"
);

// ── 5. Add notification API routes ────────────────────────────────────────────
patch(
  '5 - notification routes',
  "// ─── Remind — single ─────────────────────────────────────────",

  "// ─── Notifications ───────────────────────────────────────────\n" +
  "\n" +
  "// GET all notifications, with unread count for a specific admin\n" +
  "app.get('/api/notifications', async (req, res) => {\n" +
  "  try {\n" +
  "    const adminId = req.headers['x-admin-id'] || req.query.adminId || 'unknown';\n" +
  "    const limit   = parseInt(req.query.limit) || 50;\n" +
  "    const notifs  = await Notification.find()\n" +
  "      .sort({ createdAt: -1 })\n" +
  "      .limit(limit);\n" +
  "    const data = notifs.map(n => ({\n" +
  "      _id:              n._id,\n" +
  "      type:             n.type,\n" +
  "      directiveId:      n.directiveId,\n" +
  "      directiveRef:     n.directiveRef,\n" +
  "      directiveSubject: n.directiveSubject,\n" +
  "      businessUnit:     n.businessUnit,\n" +
  "      message:          n.message,\n" +
  "      decisionChanges:  n.decisionChanges,\n" +
  "      createdAt:        n.createdAt,\n" +
  "      isRead:           n.readBy.some(r => r.adminId === adminId)\n" +
  "    }));\n" +
  "    const unreadCount = data.filter(n => !n.isRead).length;\n" +
  "    res.json({ success: true, data, unreadCount });\n" +
  "  } catch (e) {\n" +
  "    res.status(500).json({ success: false, error: e.message });\n" +
  "  }\n" +
  "});\n" +
  "\n" +
  "// Mark all notifications as read for this admin\n" +
  "app.post('/api/notifications/mark-read', async (req, res) => {\n" +
  "  try {\n" +
  "    const adminId = req.headers['x-admin-id'] || req.body.adminId || 'unknown';\n" +
  "    const ids     = req.body.ids; // optional — if omitted, mark all\n" +
  "    const query   = ids && ids.length ? { _id: { $in: ids } } : {};\n" +
  "    const notifs  = await Notification.find({ ...query, 'readBy.adminId': { $ne: adminId } });\n" +
  "    await Promise.all(notifs.map(n => {\n" +
  "      n.readBy.push({ adminId, readAt: new Date() });\n" +
  "      return n.save();\n" +
  "    }));\n" +
  "    res.json({ success: true, marked: notifs.length });\n" +
  "  } catch (e) {\n" +
  "    res.status(500).json({ success: false, error: e.message });\n" +
  "  }\n" +
  "});\n" +
  "\n" +
  "// ─── Remind — single ─────────────────────────────────────────"
);

// ── 6. Also clear notification model in /api/admin/clear-all ─────────────────
patch(
  '6 - clear notifications in clear-all',
  "    const [dir, dept, po, tok, otp] = await Promise.all([\n      Directive.deleteMany({}),\n      Department.deleteMany({}),\n      ProcessOwner.deleteMany({}),\n      SubmissionToken.deleteMany({}),\n      Otp.deleteMany({})\n    ]);",
  "    const [dir, dept, po, tok, otp, notif] = await Promise.all([\n      Directive.deleteMany({}),\n      Department.deleteMany({}),\n      ProcessOwner.deleteMany({}),\n      SubmissionToken.deleteMany({}),\n      Otp.deleteMany({}),\n      Notification.deleteMany({})\n    ]);"
);

// ── Write ─────────────────────────────────────────────────────────────────────
out('');
out('Applied : ' + applied);
out('Skipped : ' + skipped);

if (applied > 0) {
  fs.writeFileSync(FILE, code);
  out('server.js saved. Push to Render.');
} else {
  out('Nothing changed.');
}

fs.writeFileSync(LOGFILE, log.join('\n') + '\n');
out('Log -> server-patch-notif.log');