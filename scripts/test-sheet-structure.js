// scripts/test-sheet-structure.js
// Test script specifically for your CBN sheet structure

const { google } = require('googleapis');
require('dotenv').config();

async function testSheetStructure() {
  try {
    console.log('🔍 Testing CBN Sheet Structure...\n');
    console.log('═══════════════════════════════════════════════════════════\n');
    
    // Initialize Google Sheets API
    const auth = new google.auth.GoogleAuth({
      keyFile: process.env.GOOGLE_CREDENTIALS_PATH || './credentials.json',
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });
    
    const client = await auth.getClient();
    const sheets = google.sheets({ version: 'v4', auth: client });
    const sheetId = process.env.GOOGLE_SHEET_ID || '1BuQneU7HESvwRE25Zkir96jZrSP-TKLe';
    
    // Get all sheets
    const metadata = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
    const allSheets = metadata.data.sheets;
    
    console.log(`📊 Spreadsheet: "${metadata.data.properties.title}"`);
    console.log(`📑 Total Sheets: ${allSheets.length}\n`);
    
    // Test first sheet in detail
    const firstSheet = allSheets[0].properties.title;
    console.log(`📄 Testing First Sheet: "${firstSheet}"`);
    console.log('─────────────────────────────────────────────────────────────\n');
    
    // Read first 10 rows to see structure
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: `'${firstSheet}'!A1:L10`,
    });
    
    const rows = response.data.values;
    
    if (!rows || rows.length === 0) {
      console.log('⚠️  No data found in sheet');
      return;
    }
    
    console.log('📋 First 10 Rows (Raw Structure):\n');
    
    rows.forEach((row, index) => {
      console.log(`Row ${index + 1}:`);
      row.forEach((cell, colIndex) => {
        if (cell && cell.trim()) {
          const colLetter = String.fromCharCode(65 + colIndex);
          const preview = cell.length > 80 ? cell.substring(0, 80) + '...' : cell;
          console.log(`   ${colLetter}: ${preview}`);
        }
      });
      console.log('');
    });
    
    console.log('═══════════════════════════════════════════════════════════\n');
    
    // Now test reading from Row 4 onwards (actual data structure)
    console.log('📊 Reading from Row 4 (Headers) onwards...\n');
    
    const dataResponse = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: `'${firstSheet}'!A4:L100`,
    });
    
    const dataRows = dataResponse.data.values;
    
    if (!dataRows || dataRows.length < 2) {
      console.log('⚠️  No data found from Row 4 onwards');
      return;
    }
    
    // Row 4 = Headers
    const headers = dataRows[0];
    console.log('📌 Column Headers (Row 4):\n');
    headers.forEach((header, i) => {
      if (header && header.trim()) {
        console.log(`   ${String.fromCharCode(65 + i)}: ${header}`);
      }
    });
    
    console.log('\n─────────────────────────────────────────────────────────────\n');
    
    // Expected column mapping
    const colMap = {
      refNo: 0,       // Column A
      meeting: 1,     // Column B
      date: 2,        // Column C
      subject: 3,     // Column D
      particulars: 4, // Column E
      owner: 5,       // Column F
      amount: 6,      // Column G
      vendor: 7,      // Column H
      deadline: 8,    // Column I
      implStatus: 9,  // Column J
      monStatus: 10   // Column K
    };
    
    console.log('🔍 Expected Column Mapping:\n');
    console.log('   A (0)  → Ref No');
    console.log('   B (1)  → Meeting');
    console.log('   C (2)  → Date');
    console.log('   D (3)  → Subject');
    console.log('   E (4)  → Particulars');
    console.log('   F (5)  → Process Owner');
    console.log('   G (6)  → Amount');
    console.log('   H (7)  → Vendor');
    console.log('   I (8)  → Implementation Deadline');
    console.log('   J (9)  → Implementation Status');
    console.log('   K (10) → Monitoring Status');
    
    console.log('\n─────────────────────────────────────────────────────────────\n');
    
    // Parse first 3 data rows
    console.log('📝 First 3 Data Rows (Parsed):\n');
    
    const dataRowsToParse = dataRows.slice(1, 4); // Rows 5-7
    
    dataRowsToParse.forEach((row, idx) => {
      if (!row || row.every(cell => !cell || cell.trim() === '')) {
        console.log(`Row ${idx + 5}: [EMPTY ROW - SKIPPED]\n`);
        return;
      }
      
      console.log(`Row ${idx + 5}:`);
      console.log(`   Ref No:         ${row[colMap.refNo] || '[NOT PROVIDED]'}`);
      console.log(`   Meeting:        ${(row[colMap.meeting] || '').substring(0, 60)}...`);
      console.log(`   Date:           ${row[colMap.date] || '[MISSING]'}`);
      console.log(`   Subject:        ${(row[colMap.subject] || '').substring(0, 60)}...`);
      console.log(`   Particulars:    ${(row[colMap.particulars] || '').substring(0, 80)}...`);
      console.log(`   Owner:          ${row[colMap.owner] || '[UNASSIGNED]'}`);
      console.log(`   Amount:         ${row[colMap.amount] || '[NOT SPECIFIED]'}`);
      console.log(`   Vendor:         ${row[colMap.vendor] || '[NOT SPECIFIED]'}`);
      console.log(`   Deadline:       ${row[colMap.deadline] || '[NOT SET]'}`);
      console.log(`   Impl Status:    ${row[colMap.implStatus] || '[NOT SET]'}`);
      console.log(`   Mon Status:     ${row[colMap.monStatus] || '[NOT SET]'}`);
      console.log('');
      
      // Parse outcomes
      const particulars = row[colMap.particulars] || row[colMap.subject];
      if (particulars) {
        const cleanText = particulars
          .replace(/^The Committee of Governors (DECIDED|APPROVED|RECOMMENDED) as follows?:?\s*/i, '')
          .replace(/^APPROVED:?\s*/i, '')
          .trim();
        
        const outcomes = cleanText
          .split(/(?:\([A-Z]\)|\d+\.)\s+/)
          .map(s => s.trim())
          .filter(s => s.length > 15);
        
        if (outcomes.length > 1) {
          console.log(`   Parsed Outcomes: ${outcomes.length}`);
          outcomes.forEach((outcome, i) => {
            console.log(`      ${i + 1}. ${outcome.substring(0, 100)}...`);
          });
        } else {
          console.log(`   Parsed Outcomes: 1 (single item)`);
          console.log(`      1. ${cleanText.substring(0, 100)}...`);
        }
        console.log('');
      }
    });
    
    console.log('═══════════════════════════════════════════════════════════\n');
    
    // Count total data rows
    const totalDataRows = dataRows.slice(1).filter(row => 
      row && !row.every(cell => !cell || cell.trim() === '')
    ).length;
    
    console.log('📊 Statistics:\n');
    console.log(`   Total Rows in Sheet: ${rows.length}`);
    console.log(`   Header Row: Row 4`);
    console.log(`   Data Rows: ${totalDataRows} (from Row 5 onwards)`);
    console.log(`   Columns Used: ${headers.filter(h => h && h.trim()).length}`);
    
    console.log('\n═══════════════════════════════════════════════════════════\n');
    
    console.log('✅ Structure Test Complete!\n');
    console.log('💡 Next Steps:');
    console.log('   1. Verify column mapping matches your sheet');
    console.log('   2. Check that data parsing looks correct');
    console.log('   3. Run the server and sync: npm run dev');
    console.log('   4. Click "Sync from Sheets" in the dashboard\n');
    
  } catch (error) {
    console.error('\n❌ Error:', error.message);
    
    if (error.code === 403) {
      console.log('\n🔧 Troubleshooting:');
      console.log('   1. Share the sheet with the service account email');
      console.log('   2. Enable Google Sheets API in your project');
      console.log('   3. Verify credentials.json is correct');
    }
  }
}

testSheetStructure();