const mongoose = require('mongoose');
require('dotenv').config();

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://oyebanjoabiola_db_user:83kDNVz6CN6sGUsv@cluster0.mkj92f1.mongodb.net/cbn_directives?retryWrites=true&w=majority';

async function fixHighRisk() {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log('✅ Connected to MongoDB');
    
    const db = mongoose.connection.db;
    const collection = db.collection('directives');
    
    // Find directives with High Risk but NO implementation end date
    const result = await collection.updateMany(
      { 
        monitoringStatus: 'High Risk',
        $or: [
          { implementationEndDate: { $exists: false } },
          { implementationEndDate: null }
        ]
      },
      { 
        $set: { monitoringStatus: 'Needs Timeline' }
      }
    );
    
    console.log(`✅ Changed ${result.modifiedCount} directives from "High Risk" to "Needs Timeline"`);
    
    // Show distribution
    const counts = await collection.aggregate([
      {
        $group: {
          _id: '$monitoringStatus',
          count: { $sum: 1 }
        }
      }
    ]).toArray();
    
    console.log('\n📊 Monitoring Status Distribution:');
    counts.forEach(c => {
      console.log(`   ${c._id}: ${c.count}`);
    });
    
    // Show actual high risk directives (with deadlines)
    const actualHighRisk = await collection.find({
      monitoringStatus: 'High Risk',
      implementationEndDate: { $exists: true, $ne: null }
    }).toArray();
    
    console.log(`\n⚠️  Actual High Risk directives (with deadlines):`);
    actualHighRisk.forEach(d => {
      const days = Math.ceil((new Date(d.implementationEndDate) - new Date()) / (1000 * 60 * 60 * 24));
      console.log(`   ${d.ref}: ${days} days ${days < 0 ? 'overdue' : 'left'}`);
    });
    
    console.log('\n✅ Fix completed!');
    process.exit(0);
    
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

fixHighRisk();
