const mongoose = require('mongoose');
require('dotenv').config();

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://oyebanjoabiola_db_user:83kDNVz6CN6sGUsv@cluster0.mkj92f1.mongodb.net/cbn_directives?retryWrites=true&w=majority';

async function analyzeDatabase() {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log('✅ Connected to MongoDB\n');

    const Directive = mongoose.connection.collection('directives');
    
    // Get total count
    const total = await Directive.countDocuments();
    console.log(`📊 Total directives in DB: ${total}\n`);
    
    // Check for bad data (header rows imported as data)
    console.log('🔍 CHECKING FOR BAD DATA (Header rows):');
    const badData = await Directive.find({
      $or: [
        { subject: /PARTICULARS/i },
        { owner: /AMOUNT|PROCESS OWNER/i },
        { particulars: /PROCESS OWNER/i },
        { ref: /MEETING AT WHICH/i }
      ]
    }).toArray();
    
    console.log(`   Found ${badData.length} header rows imported as data ❌`);
    if (badData.length > 0) {
      console.log('   Sample bad record:');
      console.log('   ', JSON.stringify(badData[0], null, 2));
    }
    console.log('');
    
    // Get a good data sample
    console.log('🔍 CHECKING FOR GOOD DATA:');
    const goodData = await Directive.find({
      subject: { $not: /PARTICULARS/i },
      owner: { $not: /AMOUNT|PROCESS OWNER/i },
      ref: { $exists: true, $ne: null, $not: /MEETING AT WHICH/i }
    }).limit(1).toArray();
    
    if (goodData.length > 0) {
      console.log('   Found good data ✓');
      console.log('   Sample good record:');
      console.log(JSON.stringify(goodData[0], null, 2));
    } else {
      console.log('   No good data found - all may be header rows! ❌');
    }
    console.log('');
    
    // Check current schema structure
    console.log('📋 CURRENT SCHEMA FIELDS:');
    const sampleDoc = await Directive.findOne();
    if (sampleDoc) {
      Object.keys(sampleDoc).forEach(key => {
        const value = sampleDoc[key];
        const type = Array.isArray(value) ? 'Array' : typeof value;
        console.log(`   - ${key}: ${type}`);
      });
    }
    console.log('');
    
    // Check what fields are MISSING for submissions
    console.log('❌ MISSING FIELDS FOR SUBMISSION SYSTEM:');
    const requiredFields = [
      'attachments',
      'fileUploads', 
      'documents',
      'sbuUpdateDate',
      'updateHistory',
      'primaryEmail',
      'secondaryEmail'
    ];
    
    requiredFields.forEach(field => {
      const exists = sampleDoc && sampleDoc.hasOwnProperty(field);
      console.log(`   - ${field}: ${exists ? '✓ EXISTS' : '✗ MISSING'}`);
    });
    console.log('');
    
    // Check email fields
    console.log('📧 EMAIL FIELD STATUS:');
    const withEmail = await Directive.countDocuments({ primaryEmail: { $exists: true, $ne: '', $ne: null } });
    console.log(`   Directives with primaryEmail: ${withEmail}/${total}`);
    console.log('');
    
    // Check implementation dates
    console.log('📅 IMPLEMENTATION DATE STATUS:');
    const withStartDate = await Directive.countDocuments({ implementationStartDate: { $exists: true, $ne: null } });
    const withEndDate = await Directive.countDocuments({ implementationEndDate: { $exists: true, $ne: null } });
    console.log(`   With start date: ${withStartDate}/${total}`);
    console.log(`   With end date: ${withEndDate}/${total}`);
    console.log('');
    
    // Summary
    console.log('📊 SUMMARY & RECOMMENDATIONS:');
    console.log(`   1. Clean up ${badData.length} header rows ❌`);
    console.log('   2. Update schema to add submission fields ✏️');
    console.log('   3. Fix Google Sheets sync to skip headers 🔧');
    console.log('   4. Add email fields to all directives 📧');
    console.log('   5. Add file upload capability 📎');
    
  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    await mongoose.disconnect();
    console.log('\n✅ Disconnected');
  }
}

analyzeDatabase();
