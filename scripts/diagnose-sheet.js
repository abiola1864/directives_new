const { google } = require('googleapis');
require('dotenv').config();

async function diagnoseSheet() {
  try {
    console.log('🔍 Diagnosing Google Sheet access...\n');
    
    // Check credentials file
    const fs = require('fs');
    const credPath = process.env.GOOGLE_CREDENTIALS_PATH || './credentials.json';
    
    console.log(`📄 Checking credentials file: ${credPath}`);
    if (!fs.existsSync(credPath)) {
      console.log('❌ credentials.json not found!');
      console.log('\n🔧 Solution:');
      console.log('   1. Go to Google Cloud Console');
      console.log('   2. Create Service Account');
      console.log('   3. Download JSON key');
      console.log('   4. Save as credentials.json in project root\n');
      return;
    }
    console.log('✅ credentials.json found\n');
    
    // Read and validate credentials
    const credentials = JSON.parse(fs.readFileSync(credPath, 'utf8'));
    console.log('📧 Service Account Email:', credentials.client_email);
    console.log('🔑 Project ID:', credentials.project_id, '\n');
    
    console.log('⚠️  IMPORTANT: Share your Google Sheet with this email!');
    console.log('   📋 Copy this email:', credentials.client_email);
    console.log('   🔗 Open sheet:', 'https://docs.google.com/spreadsheets/d/1dTDorJHVaSXSQVf-GZ8N9PG3nsFV3RDGvr2Dqg_fvDI/edit');
    console.log('   👆 Click Share → Add email above → Set to Viewer → Share\n');
    
    // Initialize Google Sheets API
    console.log('🔌 Connecting to Google Sheets API...');
    const auth = new google.auth.GoogleAuth({
      keyFile: credPath,
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });
    
    const client = await auth.getClient();
    const sheets = google.sheets({ version: 'v4', auth: client });
    console.log('✅ Connected to Google Sheets API\n');
    
    // Try to access the spreadsheet
    const sheetId = process.env.GOOGLE_SHEET_ID || '1dTDorJHVaSXSQVf-GZ8N9PG3nsFV3RDGvr2Dqg_fvDI';
    console.log(`📊 Attempting to access Sheet ID: ${sheetId}\n`);
    
    // Get spreadsheet metadata
    console.log('📋 Getting spreadsheet metadata...');
    const metadata = await sheets.spreadsheets.get({
      spreadsheetId: sheetId,
    });
    
    console.log('✅ Success! Spreadsheet accessible\n');
    console.log('═══════════════════════════════════════════════════════════');
    console.log('📊 Spreadsheet Details:\n');
    console.log(`   Title: ${metadata.data.properties.title}`);
    console.log(`   Locale: ${metadata.data.properties.locale}`);
    console.log(`   Time Zone: ${metadata.data.properties.timeZone}`);
    console.log(`   Total Sheets/Tabs: ${metadata.data.sheets.length}\n`);
    
    console.log('📑 Available Sheets/Tabs:\n');
    metadata.data.sheets.forEach((sheet, i) => {
      const props = sheet.properties;
      const type = props.title.toLowerCase().includes('board') ? '🏛️  Board' : '🏦 CG';
      console.log(`   ${i + 1}. ${type} → "${props.title}"`);
      console.log(`      Sheet ID: ${props.sheetId}`);
      console.log(`      Grid: ${props.gridProperties.rowCount} rows × ${props.gridProperties.columnCount} cols`);
      console.log(`      Hidden: ${props.hidden ? 'Yes' : 'No'}\n`);
    });
    
    console.log('═══════════════════════════════════════════════════════════\n');
    console.log('✅ All checks passed! Your setup is working correctly.\n');
    console.log('💡 Next steps:');
    console.log('   1. Run: npm run dev');
    console.log('   2. Open: http://localhost:3000');
    console.log('   3. Click "Sync from Sheets" button\n');
    
  } catch (error) {
    console.error('\n❌ Error:', error.message);
    console.log('\n📋 Error Code:', error.code || 'Unknown');
    
    if (error.code === 403) {
      console.log('\n🔧 PERMISSION ERROR - Sheet not shared with service account');
      console.log('\n   Steps to fix:');
      console.log('   1. Open credentials.json');
      console.log('   2. Copy the "client_email" value');
      console.log('   3. Open: https://docs.google.com/spreadsheets/d/1dTDorJHVaSXSQVf-GZ8N9PG3nsFV3RDGvr2Dqg_fvDI/edit');
      console.log('   4. Click Share button');
      console.log('   5. Add the service account email');
      console.log('   6. Set permission to "Viewer"');
      console.log('   7. Uncheck "Notify people"');
      console.log('   8. Click Share');
      console.log('   9. Wait 1 minute and try again\n');
    } else if (error.code === 404) {
      console.log('\n🔧 SHEET NOT FOUND');
      console.log('\n   Check that your Sheet ID is correct:');
      console.log(`   Current: ${process.env.GOOGLE_SHEET_ID}`);
      console.log('   Should be: 1dTDorJHVaSXSQVf-GZ8N9PG3nsFV3RDGvr2Dqg_fvDI\n');
    } else if (error.message.includes('not supported')) {
      console.log('\n🔧 FILE FORMAT ERROR');
      console.log('   The file might still be in Excel format.');
      console.log('   Make sure you converted it to Google Sheets.\n');
    } else {
      console.log('\n🔧 Full error details:');
      console.log(error);
    }
  }
}

diagnoseSheet();