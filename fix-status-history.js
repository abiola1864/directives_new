const mongoose = require('mongoose');
require('dotenv').config();

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://oyebanjoabiola_db_user:83kDNVz6CN6sGUsv@cluster0.mkj92f1.mongodb.net/cbn_directives?retryWrites=true&w=majority';

async function fixStatusHistory() {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log('✅ Connected to MongoDB\n');
    
    const db = mongoose.connection.db;
    const collection = db.collection('directives');
    
    // Find all directives with "Awaiting Next Reminder" in status history
    const directives = await collection.find({
      'statusHistory.status': 'Awaiting Next Reminder'
    }).toArray();
    
    console.log(`📊 Found ${directives.length} directives with old status in history\n`);
    
    let updated = 0;
    
    for (const directive of directives) {
      // Update each status history entry
      const newStatusHistory = directive.statusHistory.map(h => {
        if (h.status === 'Awaiting Next Reminder') {
          return { ...h, status: 'On Track' };
        }
        return h;
      });
      
      await collection.updateOne(
        { _id: directive._id },
        { $set: { statusHistory: newStatusHistory } }
      );
      
      updated++;
      console.log(`   ✓ Updated history for ${directive.ref}`);
    }
    
    console.log(`\n✅ Updated status history in ${updated} directives!`);
    process.exit(0);
    
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

fixStatusHistory();
