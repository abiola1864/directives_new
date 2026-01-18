const mongoose = require('mongoose');
require('dotenv').config();

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://oyebanjoabiola_db_user:83kDNVz6CN6sGUsv@cluster0.mkj92f1.mongodb.net/cbn_directives?retryWrites=true&w=majority';

async function cleanStatusHistory() {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log('✅ Connected to MongoDB\n');
    
    const db = mongoose.connection.db;
    const collection = db.collection('directives');
    
    // Get all directives
    const directives = await collection.find({}).toArray();
    
    console.log(`📊 Processing ${directives.length} directives...\n`);
    
    let updated = 0;
    const statusMapping = {
      'Implemented': 'Completed',
      'Being Implemented': 'On Track',  // Implementation status leaked into monitoring
      'No response': null,  // Will be removed
      'Awaiting Next Reminder': 'On Track'
    };
    
    for (const directive of directives) {
      if (!directive.statusHistory || directive.statusHistory.length === 0) {
        continue;
      }
      
      let needsUpdate = false;
      const cleanedHistory = [];
      
      directive.statusHistory.forEach(entry => {
        // Check if status needs mapping
        if (statusMapping.hasOwnProperty(entry.status)) {
          const newStatus = statusMapping[entry.status];
          
          if (newStatus === null) {
            // Skip this entry (don't add to cleaned history)
            console.log(`   ✗ Removing "${entry.status}" from ${directive.ref}`);
            needsUpdate = true;
          } else {
            // Map to new status
            console.log(`   → Mapping "${entry.status}" → "${newStatus}" in ${directive.ref}`);
            cleanedHistory.push({
              ...entry,
              status: newStatus
            });
            needsUpdate = true;
          }
        } else {
          // Keep as is
          cleanedHistory.push(entry);
        }
      });
      
      if (needsUpdate) {
        await collection.updateOne(
          { _id: directive._id },
          { $set: { statusHistory: cleanedHistory } }
        );
        updated++;
      }
    }
    
    console.log(`\n✅ Cleaned status history in ${updated} directives!`);
    
    // Show final distribution
    console.log('\n📊 Final Status History Distribution:');
    const finalStatuses = await collection.aggregate([
      { $unwind: '$statusHistory' },
      { $group: { _id: '$statusHistory.status', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]).toArray();
    
    finalStatuses.forEach(s => {
      console.log(`   "${s._id}": ${s.count} entries`);
    });
    
    console.log('\n✅ Cleanup complete!');
    process.exit(0);
    
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

cleanStatusHistory();
