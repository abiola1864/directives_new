require('dotenv').config();
const {MongoClient}=require('mongodb');
console.log('URI:', process.env.MONGODB_URI ? 'FOUND' : 'MISSING');
MongoClient.connect(process.env.MONGODB_URI)
  .then(()=>console.log('✅ Connected!'))
  .catch(e=>console.log('❌ Error:',e.message));
