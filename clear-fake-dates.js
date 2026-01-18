const mongoose = require('mongoose');
require('dotenv').config();

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://oyebanjoabiola_db_user:83kDNVz6CN6sGUsv@cluster0.mkj92f1.mongodb.net/cbn_directives?retryWrites=true&w=majority';

async function clearFakeDates() {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log('✅ Connected to MongoDB\n');
    
    const db = mongoose.connection.db;
    const collection = db.collection('directives');
    
    // Set all Jan 17, 2026 dates to null
    const result = await collection.updateMany(
      {
        implementationEndDate: {
          $gte: new Date('2026-01-17T00:00:00.000Z'),
          $lt: new Date('2026-01-18T00:00:00.000Z')
        }
      },
      {
        $set: { implementationEndDate: null }
      }
    );
    
    console.log(`✅ Cleared ${result.modifiedCount} fake Jan 17, 2026 dates\n`);
    
    // Also clear start dates if they're Jan 17
    const result2 = await collection.updateMany(
      {
        implementationStartDate: {
          $gte: new Date('2026-01-17T00:00:00.000Z'),
          $lt: new Date('2026-01-18T00:00:00.000Z')
        }
      },
      {
        $set: { implementationStartDate: null }
      }
    );
    
    console.log(`✅ Cleared ${result2.modifiedCount} fake Jan 17, 2026 start dates\n`);
    
    console.log('✅ All fake dates cleared!');
    process.exit(0);
    
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

clearFakeDates();
