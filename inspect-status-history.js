const mongoose = require('mongoose');
require('dotenv').config();

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://oyebanjoabiola_db_user:83kDNVz6CN6sGUsv@cluster0.mkj92f1.mongodb.net/cbn_directives?retryWrites=true&w=majority';

async function inspectStatusHistory() {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log('✅ Connected to MongoDB\n');
    
    const db = mongoose.connection.db;
    const collection = db.collection('directives');
    
    // Get a few directives with status history
    const directives = await collection.find({
      statusHistory: { $exists: true, $ne: [] }
    }).limit(5).toArray();
    
    console.log(`📊 Sample Status History from ${directives.length} directives:\n`);
    
    directives.forEach((directive, idx) => {
      console.log(`\n${'='.repeat(60)}`);
      console.log(`Directive ${idx + 1}: ${directive.ref}`);
      console.log(`${'='.repeat(60)}`);
      
      if (directive.statusHistory && directive.statusHistory.length > 0) {
        directive.statusHistory.forEach((history, hIdx) => {
          console.log(`\n  History Entry ${hIdx + 1}:`);
          console.log(`    Status: "${history.status}"`);
          console.log(`    Changed At: ${history.changedAt}`);
          console.log(`    Changed By: ${history.changedBy || 'N/A'}`);
          console.log(`    Notes: ${history.notes || 'N/A'}`);
          console.log(`    _id: ${history._id}`);
        });
      } else {
        console.log('  No status history');
      }
    });
    
    // Check for all unique status values in history
    console.log(`\n\n${'='.repeat(60)}`);
    console.log('ALL UNIQUE STATUS VALUES IN HISTORY:');
    console.log(`${'='.repeat(60)}\n`);
    
    const uniqueStatuses = await collection.aggregate([
      { $unwind: '$statusHistory' },
      { $group: { _id: '$statusHistory.status', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]).toArray();
    
    uniqueStatuses.forEach(s => {
      console.log(`  "${s._id}": ${s.count} entries`);
    });
    
    console.log('\n✅ Inspection complete!');
    process.exit(0);
    
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

inspectStatusHistory();
