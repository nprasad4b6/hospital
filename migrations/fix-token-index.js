/**
 * Migration: Fix tokenNumber unique index to be per-day instead of global
 * 
 * Run this once to:
 * 1. Drop the old unique index on tokenNumber
 * 2. Create a new compound unique index on [tokenNumber, createdAt]
 * 
 * Command: node migrations/fix-token-index.js
 */

const mongoose = require('mongoose');
require('dotenv').config();

const MONGO_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/hospital-queue';

async function fixTokenIndex() {
  try {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(MONGO_URI);
    console.log('✓ Connected');

    const db = mongoose.connection.db;
    const patientsCollection = db.collection('patients');

    console.log('\nListing current indexes...');
    const indexes = await patientsCollection.listIndexes().toArray();
    console.log('Current indexes:', indexes.map(i => i.name));

    // Drop the old unique index on tokenNumber if it exists
    const indexNames = indexes.map(i => i.name);
    if (indexNames.includes('tokenNumber_1')) {
      console.log('\n⚠ Dropping old index: tokenNumber_1');
      await patientsCollection.dropIndex('tokenNumber_1');
      console.log('✓ Dropped');
    }

    // Create new compound unique index
    console.log('\n➕ Creating new compound unique index on [tokenNumber, createdAt]...');
    await patientsCollection.createIndex(
      { tokenNumber: 1, createdAt: 1 },
      { unique: true }
    );
    console.log('✓ Created');

    // Show updated indexes
    console.log('\nUpdated indexes:');
    const newIndexList = await patientsCollection.listIndexes().toArray();
    console.log(newIndexList.map(i => i.name));

    console.log('\n✅ Migration completed successfully!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error.message);
    process.exit(1);
  }
}

fixTokenIndex();
