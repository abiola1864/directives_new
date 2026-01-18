const mongoose = require('mongoose');
require('dotenv').config();

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://oyebanjoabiola_db_user:83kDNVz6CN6sGUsv@cluster0.mkj92f1.mongodb.net/cbn_directives?retryWrites=true&w=majority';

async function queryDatabase() {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log('✅ Connected to MongoDB\n');
    
    const db = mongoose.connection.db;
    const collection = db.collection('directives');
    
    // 1. Show monitoring status distribution
    console.log('📊 MONITORING STATUS DISTRIBUTION:');
    const statusCounts = await collection.aggregate([
      {
        $group: {
          _id: '$monitoringStatus',
          count: { $sum: 1 }
        }
      },
      { $sort: { count: -1 } }
    ]).toArray();
    
    statusCounts.forEach(s => {
      console.log(`   ${s._id || 'NULL'}: ${s.count}`);
    });
    
    // 2. Show directives with NO timeline
    console.log('\n📋 DIRECTIVES WITHOUT IMPLEMENTATION END DATE:');
    const noTimeline = await collection.find({
      $or: [
        { implementationEndDate: { $exists: false } },
        { implementationEndDate: null }
      ]
    }).project({ ref: 1, monitoringStatus: 1, implementationEndDate: 1 }).limit(10).toArray();
    
    console.log(`   Total: ${noTimeline.length} (showing first 10)`);
    noTimeline.forEach(d => {
      console.log(`   ${d.ref}: ${d.monitoringStatus} | EndDate: ${d.implementationEndDate || 'NOT SET'}`);
    });
    
    // 3. Show High Risk directives
    console.log('\n⚠️  HIGH RISK DIRECTIVES:');
    const highRisk = await collection.find({
      monitoringStatus: 'High Risk'
    }).project({ ref: 1, implementationEndDate: 1 }).toArray();
    
    console.log(`   Total: ${highRisk.length}`);
    highRisk.forEach(d => {
      const hasDate = d.implementationEndDate ? '✓ HAS DATE' : '❌ NO DATE';
      const daysLeft = d.implementationEndDate 
        ? Math.ceil((new Date(d.implementationEndDate) - new Date()) / (1000 * 60 * 60 * 24))
        : 'N/A';
      console.log(`   ${d.ref}: ${hasDate} | Days: ${daysLeft}`);
    });
    
    // 4. Check for "Awaiting Next Reminder" or old statuses
    console.log('\n🔍 CHECKING FOR OLD STATUS VALUES:');
    const oldStatuses = await collection.find({
      monitoringStatus: { $in: ['Awaiting Next Reminder', 'Being Implemented', 'Implemented', 'No response'] }
    }).project({ ref: 1, monitoringStatus: 1 }).toArray();
    
    if (oldStatuses.length > 0) {
      console.log(`   ❌ Found ${oldStatuses.length} directives with old status values:`);
      oldStatuses.forEach(d => {
        console.log(`      ${d.ref}: "${d.monitoringStatus}"`);
      });
    } else {
      console.log('   ✅ No old status values found');
    }
    
    // 5. Sample of all fields for one directive
    console.log('\n📄 SAMPLE DIRECTIVE (full document):');
    const sample = await collection.findOne({});
    console.log(JSON.stringify(sample, null, 2));
    
    console.log('\n✅ Query complete!');
    process.exit(0);
    
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

queryDatabase();
