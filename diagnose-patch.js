'use strict';
var fs   = require('fs');
var path = require('path');

var FILE = path.join(__dirname, 'server.js');
var OUT  = path.join(__dirname, 'diagnose-output.txt');

if (!fs.existsSync(FILE)) {
  fs.writeFileSync(OUT, 'ERROR: server.js not found\n');
  process.exit(1);
}

var code  = fs.readFileSync(FILE, 'utf8');
var lines = [];

lines.push('server.js length: ' + code.length);
lines.push('');

function show(label, keyword, before, after) {
  var idx = code.indexOf(keyword);
  lines.push('=== ' + label + ' ===');
  if (idx === -1) {
    lines.push('NOT FOUND: ' + keyword);
    lines.push('');
    return;
  }
  var start = Math.max(0, idx - before);
  var end   = Math.min(code.length, idx + keyword.length + after);
  var chunk = code.slice(start, end);
  lines.push('pos: ' + idx);
  lines.push('ESCAPED:');
  lines.push(JSON.stringify(chunk));
  lines.push('PLAIN:');
  lines.push(chunk);
  lines.push('---');
  lines.push('');
}

show('SKIP1 decisionSchema end', 'impliedResponsible', 250, 30);
show('SKIP2 directive ref field', 'ref: { type: String }', 10, 250);
show('SKIP3 GET directives query', 'const { source, owner, status', 10, 250);

fs.writeFileSync(OUT, lines.join('\n') + '\nDONE\n');