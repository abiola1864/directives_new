const mongoose = require('mongoose');
require('dotenv').config();

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://oyebanjoabiola_db_user:83kDNVz6CN6sGUsv@cluster0.mkj92f1.mongodb.net/cbn_directives?retryWrites=true&w=majority';

async function fixMonitoringStatus() {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log('✅ Connected to MongoDB');
    
    const db = mongoose.connection.db;
    const collection = db.collection('directives');
    
    // 1. Rename 'Awaiting Next Reminder' to 'On Track'
    const result1 = await collection.updateMany(
      { monitoringStatus: 'Awaiting Next Reminder' },
      { $set: { monitoringStatus: 'On Track' } }
    );
    console.log(`✅ Renamed 'Awaiting Next Reminder' → 'On Track': ${result1.modifiedCount} documents`);
    
    // 2. Convert invalid statuses
    const result2 = await collection.updateMany(
      { monitoringStatus: { $in: ['Being Implemented', 'Implemented', 'No response'] } },
      { $set: { monitoringStatus: 'On Track' } }
    );
    console.log(`✅ Fixed invalid monitoring statuses: ${result2.modifiedCount} documents`);
    
    // 3. Add isResponsive field where missing
    const result3 = await collection.updateMany(
      { isResponsive: { $exists: false } },
      { $set: { isResponsive: true } }
    );
    console.log(`✅ Added isResponsive field: ${result3.modifiedCount} documents`);
    
    // 4. Set isResponsive = false for non-responsive directives
    const result4 = await collection.updateMany(
      { 
        reminders: { $gte: 3 },
        $or: [
          { lastSbuUpdate: { $exists: false } },
          { $expr: { $lt: ['$lastSbuUpdate', '$lastReminderDate'] } }
        ]
      },
      { $set: { isResponsive: false } }
    );
    console.log(`✅ Set isResponsive = false for non-responsive: ${result4.modifiedCount} documents`);
    
    // 5. Verify the changes
    const counts = await collection.aggregate([
      {
        $group: {
          _id: '$monitoringStatus',
          count: { $sum: 1 }
        }
      }
    ]).toArray();
    
    console.log('\n📊 Current Monitoring Status Distribution:');
    counts.forEach(c => {
      console.log(`   ${c._id}: ${c.count}`);
    });
    
    const responsiveCounts = await collection.aggregate([
      {
        $group: {
          _id: '$isResponsive',
          count: { $sum: 1 }
        }
      }
    ]).toArray();
    
    console.log('\n📊 Responsiveness Distribution:');
    responsiveCounts.forEach(c => {
      console.log(`   ${c._id === true ? 'Responsive' : 'Non-Responsive'}: ${c.count}`);
    });
    
    console.log('\n✅ All fixes applied successfully!');
    process.exit(0);
    
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

fixMonitoringStatus();
