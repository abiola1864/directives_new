const mongoose = require('mongoose');
require('dotenv').config();

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://oyebanjoabiola_db_user:83kDNVz6CN6sGUsv@cluster0.mkj92f1.mongodb.net/cbn_directives?retryWrites=true&w=majority';

async function checkDatabase() {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log('✅ Connected to MongoDB\n');

    // Get all collections
    const collections = await mongoose.connection.db.listCollections().toArray();
    console.log('📊 Collections in database:');
    collections.forEach(col => console.log(`   - ${col.name}`));
    console.log('');

    // Check directives schema
    const Directive = mongoose.connection.collection('directives');
    const sampleDirective = await Directive.findOne();
    
    if (sampleDirective) {
      console.log('📋 Sample Directive Structure:');
      console.log(JSON.stringify(sampleDirective, null, 2));
      console.log('');
      
      // Check for file/attachment fields
      console.log('🔍 Checking for file storage fields:');
      console.log('   - Has attachments field?', sampleDirective.attachments ? 'YES ✓' : 'NO ✗');
      console.log('   - Has fileUploads field?', sampleDirective.fileUploads ? 'YES ✓' : 'NO ✗');
      console.log('   - Has documents field?', sampleDirective.documents ? 'YES ✓' : 'NO ✗');
      console.log('');
      
      // Check outcomes structure
      if (sampleDirective.outcomes && sampleDirective.outcomes.length > 0) {
        console.log('📝 Outcome Structure:');
        console.log(JSON.stringify(sampleDirective.outcomes[0], null, 2));
      }
    } else {
      console.log('⚠️  No directives found in database');
    }
    
    // Count directives
    const count = await Directive.countDocuments();
    console.log(`\n📊 Total directives: ${count}`);
    
  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    await mongoose.disconnect();
    console.log('\n✅ Disconnected from MongoDB');
  }
}

checkDatabase();
