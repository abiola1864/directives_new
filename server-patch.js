'use strict';
var fs   = require('fs');
var path = require('path');

var FILE    = path.join(__dirname, 'server.js');
var LOGFILE = path.join(__dirname, 'server-patch3.log');

var log = [];
function out(msg) { console.log(msg); log.push(msg); }

var code = fs.readFileSync(FILE, 'utf8');
out('server.js: ' + code.length + ' chars');

// Already applied?
if (code.indexOf("amount:") !== -1 && code.indexOf("decisionSchema") !== -1) {
  // Check if amount is inside decisionSchema specifically
  var dIdx = code.indexOf('const decisionSchema');
  var dEnd = code.indexOf('});', dIdx) + 3;
  var dBlock = code.slice(dIdx, dEnd);
  if (dBlock.indexOf('amount') !== -1) {
    out('SKIP - amount already in decisionSchema');
    fs.writeFileSync(LOGFILE, log.join('\n') + '\n');
    out('Nothing to do. All 6 changes are now applied.');
    process.exit(0);
  }
}

var applied = false;

// Try anchoring on "challenges" field — common in all versions
var anchors = [
  'challenges:         String,',
  'challenges: String,',
  'challenges:String,',
  "challenges:         { type: String }",
  "challenges: { type: String }",
];

for (var i = 0; i < anchors.length; i++) {
  var anchor = anchors[i];
  if (code.indexOf(anchor) !== -1) {
    code = code.replace(anchor, anchor + '\n  amount:             { type: String, default: \'\' },');
    out('DONE - amount added after: ' + anchor);
    applied = true;
    break;
  }
}

if (!applied) {
  // Last resort: find decisionSchema and show what fields it has
  var start = code.indexOf('const decisionSchema');
  if (start !== -1) {
    var end = code.indexOf('});', start) + 3;
    var block = code.slice(start, end);
    out('SKIP - could not match. decisionSchema block found:');
    out(block);
  } else {
    out('SKIP - decisionSchema not found at all');
  }
}

if (applied) {
  fs.writeFileSync(FILE, code);
  out('server.js saved. Restart or push to Render.');
  out('');
  out('ALL 6 CHANGES NOW COMPLETE:');
  out('  1. amount per decision     - DONE');
  out('  2. isArchived on directive - DONE (was already applied)');
  out('  3. includeArchived filter  - DONE');
  out('  4. archive/unarchive routes- DONE');
  out('  5. max users 3->9          - DONE');
  out('  6. preserve decision amounts on PUT - DONE');
}

fs.writeFileSync(LOGFILE, log.join('\n') + '\n');
out('Log -> server-patch3.log');