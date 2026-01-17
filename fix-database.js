const mongoose = require('mongoose');
require('dotenv').config();

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://oyebanjoabiola_db_user:83kDNVz6CN6sGUsv@cluster0.mkj92f1.mongodb.net/cbn_directives?retryWrites=true&w=majority';

async function fixDatabase() {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log('✅ Connected to MongoDB\n');

    const Directive = mongoose.connection.collection('directives');
    
    // STEP 1: Delete header row
    console.log('🗑️  STEP 1: Deleting header rows...');
    const deleteResult = await Directive.deleteMany({
      $or: [
        { subject: /PARTICULARS/i },
        { owner: /AMOUNT|PROCESS OWNER/i },
        { ref: /MEETING AT WHICH/i }
      ]
    });
    console.log(`   Deleted ${deleteResult.deletedCount} header rows ✓\n`);
    
    // STEP 2: Add missing fields to all documents
    console.log('📝 STEP 2: Adding missing submission fields...');
    const updateResult = await Directive.updateMany(
      {},
      {
        $set: {
          // Email fields (if not exists)
          primaryEmail: '',
          secondaryEmail: '',
          
          // Dates (if not exists)
          implementationStartDate: null,
          implementationEndDate: null,
          
          // Submission tracking
          attachments: [],
          updateHistory: [],
          lastSbuUpdate: null,
          
          // Reminder history (if not exists)
          reminderHistory: [],
          lastReminderDate: null,
          
          // Status history (if not exists)
          statusHistory: []
        }
      }
    );
    console.log(`   Updated ${updateResult.modifiedCount} documents ✓\n`);
    
    // STEP 3: Clean up bad values
    console.log('🧹 STEP 3: Cleaning up bad data values...');
    
    // Fix ",," values
    const cleanupResult = await Directive.updateMany(
      {
        $or: [
          { particulars: /^,+$/ },
          { ref: /^,+$/ },
          { amount: /^,+$/ }
        ]
      },
      {
        $set: {
          particulars: '',
          ref: null,
          amount: ''
        }
      }
    );
    console.log(`   Cleaned ${cleanupResult.modifiedCount} documents with bad values ✓\n`);
    
    // STEP 4: Fix outcomes with bad text
    console.log('📋 STEP 4: Fixing bad outcome text...');
    const directivesWithBadOutcomes = await Directive.find({
      'outcomes.text': /^,+$/
    }).toArray();
    
    for (const doc of directivesWithBadOutcomes) {
      const cleanedOutcomes = doc.outcomes.filter(o => o.text && !o.text.match(/^,+$/));
      
      if (cleanedOutcomes.length === 0 && doc.subject) {
        // Use subject as outcome if no valid outcomes
        cleanedOutcomes.push({
          text: doc.subject.substring(0, 300),
          status: 'Not Started'
        });
      }
      
      await Directive.updateOne(
        { _id: doc._id },
        { $set: { outcomes: cleanedOutcomes } }
      );
    }
    console.log(`   Fixed outcomes for ${directivesWithBadOutcomes.length} documents ✓\n`);
    
    // STEP 5: Summary
    console.log('📊 DATABASE UPDATED SUCCESSFULLY!\n');
    
    const finalCount = await Directive.countDocuments();
    const withEmail = await Directive.countDocuments({ primaryEmail: { $ne: '' } });
    const withDates = await Directive.countDocuments({ implementationEndDate: { $ne: null } });
    
    console.log('Final Status:');
    console.log(`   Total directives: ${finalCount}`);
    console.log(`   With emails: ${withEmail} (${((withEmail/finalCount)*100).toFixed(1)}%)`);
    console.log(`   With dates: ${withDates} (${((withDates/finalCount)*100).toFixed(1)}%)`);
    console.log(`   Ready for submissions: ✓`);
    
  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    await mongoose.disconnect();
    console.log('\n✅ Disconnected');
  }
}

fixDatabase();
