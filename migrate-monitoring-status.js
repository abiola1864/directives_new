const mongoose = require('mongoose');
require('dotenv').config();

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://oyebanjoabiola_db_user:83kDNVz6CN6sGUsv@cluster0.mkj92f1.mongodb.net/cbn_directives?retryWrites=true&w=majority';

async function migrate() {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log('✅ Connected to MongoDB');
    
    const Directive = mongoose.model('Directive', new mongoose.Schema({}, { strict: false }));
    
    const directives = await Directive.find({});
    console.log(`📊 Found ${directives.length} directives to migrate`);
    
    let updated = 0;
    
    for (const directive of directives) {
      let needsUpdate = false;
      
      // 1. RENAME 'Awaiting Next Reminder' to 'On Track'
      if (directive.monitoringStatus === 'Awaiting Next Reminder') {
        directive.monitoringStatus = 'On Track';
        needsUpdate = true;
      }
      
      // 2. CONVERT invalid monitoring statuses
      if (['Being Implemented', 'Implemented', 'No response'].includes(directive.monitoringStatus)) {
        if (directive.reminders >= 3) {
          directive.monitoringStatus = 'At Risk';
        } else {
          directive.monitoringStatus = 'On Track';
        }
        needsUpdate = true;
      }
      
      // 3. ADD isResponsive field (if missing)
      if (directive.isResponsive === undefined) {
        if (directive.reminders >= 3 && 
            (!directive.lastSbuUpdate || 
             (directive.lastReminderDate && directive.lastSbuUpdate < directive.lastReminderDate))) {
          directive.isResponsive = false;
        } else {
          directive.isResponsive = true;
        }
        needsUpdate = true;
      }
      
      if (needsUpdate) {
        await directive.save();
        updated++;
        console.log(`   ✓ Updated: ${directive.ref || directive._id}`);
      }
    }
    
    console.log(`\n✅ Migration complete! Updated ${updated} of ${directives.length} directives`);
    process.exit(0);
    
  } catch (error) {
    console.error('❌ Migration error:', error);
    process.exit(1);
  }
}

migrate();
