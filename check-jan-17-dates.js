const mongoose = require('mongoose');
require('dotenv').config();

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://oyebanjoabiola_db_user:83kDNVz6CN6sGUsv@cluster0.mkj92f1.mongodb.net/cbn_directives?retryWrites=true&w=majority';

async function checkDates() {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log('✅ Connected to MongoDB\n');
    
    const db = mongoose.connection.db;
    const collection = db.collection('directives');
    
    // Count directives with Jan 17, 2026 as end date
    const jan17Count = await collection.countDocuments({
      implementationEndDate: {
        $gte: new Date('2026-01-17T00:00:00.000Z'),
        $lt: new Date('2026-01-18T00:00:00.000Z')
      }
    });
    
    console.log(`📊 Directives with Jan 17, 2026 end date: ${jan17Count}`);
    
    // Show all unique end dates
    const uniqueDates = await collection.aggregate([
      {
        $group: {
          _id: '$implementationEndDate',
          count: { $sum: 1 }
        }
      },
      { $sort: { count: -1 } }
    ]).toArray();
    
    console.log('\n📅 All unique implementation end dates:');
    uniqueDates.forEach(d => {
      const dateStr = d._id ? new Date(d._id).toISOString().split('T')[0] : 'NULL';
      console.log(`   ${dateStr}: ${d.count} directive(s)`);
    });
    
    console.log('\n✅ Query complete!');
    process.exit(0);
    
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

checkDates();
